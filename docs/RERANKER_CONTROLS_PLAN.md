# Reranker Controls — Per-Request Override Plan

## Context

Today, the reranker is configured exclusively by the corpus profile YAML. A user
who wants to A/B `voyage/rerank-2` against `voyage/rerank-2.5-lite`, or turn
rerank off for a single query, must edit `packages/corpus-profiles/profiles/<id>.yaml`,
regenerate `_generated.ts`, and rebuild. Meanwhile the sandbox already shows
the post-hoc rerank audit (provider, model, executed, fallback_reason) but
exposes no input controls.

The merge layer is the only piece that already does the right thing:
`packages/corpus-profiles/src/merge.ts:44-47` deep-merges
`override.retrieval_defaults.rerank` over the baked profile's rerank config.
The TS `CorpusProfileOverride` type at `merge.ts:21` already declares
`rerank?: Partial<...>`. **Everything downstream of `mergeProfile` is ready.**
The gap is the request schema, the override extractor, the Python merge
mirror, and the sandbox UI.

This plan adds a per-request `retrieval.rerank` block to `QueryRequest`.
Since the API contract is the single source of truth — consumed directly by
the MCP `query` tool (`packages/mcp/src/tools/query.ts:13`) and the sandbox
client — one schema change unlocks all three surfaces.

## Goals

1. **API**: `POST /v1/query` accepts an optional `retrieval.rerank` block that
   overrides the corpus profile's rerank config field-by-field.
2. **MCP**: The `query` tool's input schema picks up the new fields
   automatically (it imports `QueryRequest` from `@textral/contracts`).
3. **Sandbox**: A "Reranker" group in `QueryForm.tsx` lets users toggle, pin
   provider/model, set `top_n`, and pin a key — mirroring the existing
   Embedding / Inference / Retrieval groups.
4. **Audit fidelity**: The existing audit shape (`audit.reranker.{enabled,
   executed, provider, model, top_n, latency_ms, fallback_reason, actionable}`)
   does not change. What's reported reflects what actually ran.
5. **Backward compatibility**: Omitting the new fields preserves today's
   behavior exactly. No existing client breaks.

## Out of scope

- New rerank providers (e.g., LLM-as-judge using OpenAI). Tracked separately;
  this plan does not widen `RerankProviderId`.
- Auto-fallback between rerank providers (e.g., Voyage → Cohere on
  `PROVIDER_QUOTA_EXHAUSTED`).
- Per-namespace rerank defaults stored in the `namespaces` table. Today the
  per-namespace surface is `corpus_profile`; that's deliberate.
- Reranking observability dashboards / cost rollups specific to rerank.

## Design

### Schema — `RetrievalConfig` in `packages/contracts/src/query.ts`

Add an optional `rerank` field. All sub-fields are individually optional and
merge into the profile's rerank config; the request body is **partial
override**, not full replacement.

```ts
export const RerankOverride = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['voyage', 'cohere']).optional(),
  model: z.string().min(1).optional(),
  top_n: z.number().int().positive().max(200).optional(),
  provider_key_ref: z.string().optional(),
  provider_key_id: z.string().optional(),
}).optional();

export const RetrievalConfig = z.object({
  // ...existing fields unchanged...
  rerank: RerankOverride,
});
```

Why `provider` is constrained to `['voyage', 'cohere']` (not the full
`ProviderName`): the rerank capability lives only on those two providers in
`apps/api/src/providers/registry.ts:82-86`. Submitting `openai` here would be
a category error; we should fail at validation time rather than at
`maybeRerank`.

### Validation rules (server-side, in the query handler)

After `mergeProfile` produces the merged rerank config, apply these checks
before invoking `maybeRerank`:

1. **`enabled: true` requires resolvable `provider` + `model`.** If the
   profile's `enabled` was `false` and the request flips it on, the request
   must also supply `provider` + `model` (or the profile must already have
   them). Otherwise → `400 BAD_REQUEST`, `"rerank.provider and rerank.model
   are required when enabled"`. This mirrors the existing Zod
   `superRefine` on `RerankConfig` in `corpus-profiles/src/schema.ts:83-92`.
2. **`enabled: false` short-circuits.** If the merged config is disabled,
   skip rerank entirely; emit `audit.reranker = { enabled: false, executed:
   false, provider: null, model: null, top_n: null }` (today's shape).
3. **Key resolution order** (existing path, unchanged conceptually):
   - `provider_key_id` (request) — explicit, errors if not found.
   - `provider_key_ref` (request) — by label, errors if not found.
   - profile's `provider_key_ref` — by label, returns null if not found.
   - tenant's `(provider, label='default')` — fallback added in the prior
     change. Returns null if not found.
   - null → `maybeRerank` falls back to RRF top-K with
     `PROVIDER_KEY_NOT_FOUND`.

### Profile-override forwarding — `apps/api/src/query/overrides.ts`

`extractProfileOverrides` currently forwards `artifact_types`,
`layer_budgets`, `layer_order`, and prompts. Add rerank forwarding into
`out.retrieval_defaults.rerank` only when the request supplied at least one
field, so the merge stays a pure no-op when omitted.

```ts
if (r.retrieval?.rerank) {
  out.retrieval_defaults = {
    ...(out.retrieval_defaults ?? {}),
    rerank: r.retrieval.rerank,
  };
}
```

`provider_key_id` is request-side only — it's a runtime concern, not a
profile concern, and shouldn't bleed into the merged profile shape. It
continues to be read from the original request body in the rerank-key
resolver path. (See "File changes" below — `resolveRerankProviderKey`
helper grows a new optional `requestKeyId` argument.)

### Python merge-mirror — `apps/ingest/app/corpus_profiles/merge.py` and `schema.py`

Per the parity convention documented at `packages/corpus-profiles/src/schema.ts:3-6`,
any change to the TS profile schema must land in the Python Pydantic mirror
in the same PR. The TS schema (`RerankConfig`) already has all fields we
need; only the override-merge logic and any tests in
`apps/ingest/tests/test_profile_parity.py` need to verify the shape. **Audit
this in the implementation pass; do not assume parity.**

### Rerank-key resolver — `apps/api/src/query/helpers.ts`

`resolveRerankProviderKey` (added in the prior change) takes
`(env, tenantId, provider, providerKeyRef)`. Extend it to honor a
request-supplied `provider_key_id` if present:

```ts
export async function resolveRerankProviderKey(
  env: Env,
  tenantId: string,
  provider: string,
  providerKeyRef?: string,
  providerKeyId?: string,    // NEW
): Promise<QueryResolvedKey | null> {
  // 1. id (strict — error if missing). Use existing 'either' kind if id given.
  if (providerKeyId) {
    const r = await resolveProviderKey(env, tenantId,
      { kind: 'id', provider, id: providerKeyId },
      { include_raw: true });
    return r?.raw_key ? { id: r.id, raw_key: r.raw_key } : null;
  }
  // 2..4. Existing optional_ref → profile ref → label='default' fallback.
}
```

### Sandbox UI — `apps/sandbox/src/components/QueryForm.tsx`

Add a new `Group title="Reranker"` between the Retrieval and Context groups,
mirroring the existing `Group → FieldGrid` pattern:

| Field | Control | Default |
|---|---|---|
| `enabled` | tri-state select: `inherit profile`, `on`, `off` | `inherit profile` |
| `provider` | `SelectField` over `['voyage', 'cohere']` | `inherit profile` (empty) |
| `model` | `Input` (string) | `inherit profile` (empty) |
| `top_n` | `Input` (number) | `inherit profile` (empty) |
| `provider_key_ref` | `Input` (string) | `default` (matches the existing convention used for embedding/inference key refs) |

Persistence: same `localStorage` key pattern as the rest of the form. State
shape additions:

```ts
rerank_enabled: 'inherit' | 'on' | 'off';
rerank_provider: '' | 'voyage' | 'cohere';
rerank_model: string;
rerank_top_n: number | '';
rerank_provider_key_ref: string;
```

`buildRequest()` only emits a `retrieval.rerank` field when at least one of
the controls deviates from `inherit`/empty, so the sandbox keeps producing
clean requests for the unmodified case.

### Sandbox API client types — `apps/sandbox/src/api/types.ts`

Mirror the contract addition in the sandbox's local `QueryRequest` type. (The
sandbox doesn't import the contracts package directly today; it uses a hand-
rolled type.) Keep the field names identical so debugging across surfaces
stays trivial.

## File changes

| Path | Change |
|---|---|
| `packages/contracts/src/query.ts` | Add `RerankOverride`; extend `RetrievalConfig` with optional `rerank`. |
| `apps/api/src/query/overrides.ts` | Forward `r.retrieval?.rerank` into `out.retrieval_defaults.rerank`. |
| `apps/api/src/query/helpers.ts` | Extend `resolveRerankProviderKey` with optional `providerKeyId`. |
| `apps/api/src/routes/query.ts` | After `mergeProfile`, if `enabled: true` and (no `provider` or no `model`), throw `BAD_REQUEST`. Pass merged rerank config + request `provider_key_id` to resolver + `maybeRerank`. |
| `apps/api/src/routes/query-stream.ts` | Same edits as query.ts. |
| `apps/ingest/app/corpus_profiles/schema.py` | Audit for parity; expected to already match TS. |
| `apps/ingest/app/corpus_profiles/merge.py` | Audit rerank-merge parity. |
| `apps/sandbox/src/api/types.ts` | Extend `QueryRequest['retrieval']` with optional `rerank`. |
| `apps/sandbox/src/components/QueryForm.tsx` | Add Reranker group + state fields + buildRequest emission. |

## Tests / Acceptance criteria

### Contract tests (`packages/contracts/test/query.test.ts`)

- [ ] `RetrievalConfig` parses with no `rerank` field (back-compat).
- [ ] Parses with `rerank: { enabled: false }`.
- [ ] Parses with `rerank: { provider: 'voyage', model: 'rerank-2.5' }`.
- [ ] **Rejects** `rerank: { provider: 'openai' }` — Zod enum error.
- [ ] Rejects `rerank: { top_n: 0 }` and `rerank: { top_n: -1 }`.

### Override extractor tests (`apps/api/test/profile-resolver.test.ts` or new `overrides.test.ts`)

- [ ] No `rerank` in request → no `rerank` key in extracted override.
- [ ] `rerank: { model: 'rerank-2.5' }` in request → override has
      `retrieval_defaults.rerank: { model: 'rerank-2.5' }`.
- [ ] `mergeProfile(narrative, { retrieval_defaults: { rerank: { model:
      'rerank-2.5' } } })` produces a profile whose rerank config has
      `provider: 'voyage'` (inherited), `model: 'rerank-2.5'` (overridden),
      `top_n: 12` (inherited), `enabled: true` (inherited).

### Query route tests (`apps/api/test/query-route.test.ts`)

- [ ] **Override turns rerank off**: `narrative` namespace + body
      `retrieval.rerank.enabled = false` → response `audit.reranker.enabled
      === false`, `executed === false`, no provider call attempted.
- [ ] **Override flips model**: `narrative` namespace + body
      `retrieval.rerank.model = 'rerank-2.5'` → audit reports `model:
      'rerank-2.5'`; provider stub called with that model name.
- [ ] **Override turns rerank on for a generic-profile namespace**: body
      `retrieval.rerank = { enabled: true, provider: 'voyage', model:
      'rerank-2.5', top_n: 8 }` against the `default` (generic) namespace →
      rerank executes; audit shows the overrides verbatim.
- [ ] **Enable without provider/model fails closed**: body
      `retrieval.rerank = { enabled: true }` against generic namespace → 400
      `BAD_REQUEST`, message names the missing fields.
- [ ] **Per-request `provider_key_id` wins over profile's `provider_key_ref`**:
      stub the resolver to return distinct keys for label `default` vs the
      explicit id; assert the explicit id was used.
- [ ] Audit `provider_key_id` field in the response reflects the key actually
      used by the rerank call (not the inference key).

### Sandbox tests

The Ajv ESM/CJS shim issue currently blocks all unit tests in `apps/api`
(pre-existing — confirmed by running an untouched test). Sandbox component
tests are not currently part of the test suite. **Acceptance for sandbox is
a manual checklist** (see "Manual validation" below). If a Vitest/JSDOM
runner is added later, port the manual checklist into automated tests.

### Manual validation

Run against the live self-host stack (`make selfhost-up`) with the existing
`lighthouse-tales` namespace:

- [ ] Run a query with no Reranker overrides → audit drawer shows `voyage /
      rerank-2`, `executed: yes` (regression check on existing behavior).
- [ ] Toggle Reranker `enabled: off` → audit shows `enabled: no, executed:
      no`. Drawer label reads "reranker disabled."
- [ ] Set Reranker `model: rerank-2.5-lite` → audit reflects the new model
      string and `executed: yes`. Latency comparable to or lower than
      `rerank-2`.
- [ ] Set Reranker `top_n: 4` → `audit.reranker.top_n === 4`; the candidate
      list visibly shrinks in the Sandbox's RetrievalCandidates panel.
- [ ] Set Reranker on the `default` namespace (generic profile, rerank
      off-by-default) with `enabled: on, provider: voyage, model: rerank-2.5,
      top_n: 8` → rerank executes and reorders results.
- [ ] Replay a saved query (Compare panel) — the reranker overrides round-trip
      through `localStorage` and reproduce the same audit.

### MCP validation

- [ ] `mcp__textral__query` accepts a `retrieval.rerank` field in the input
      payload (verify by inspecting the regenerated tool schema after a
      contract rebuild).
- [ ] An MCP query with `retrieval: { rerank: { model: 'rerank-2.5-lite' } }`
      against `lighthouse-tales` returns an audit reflecting the new model.

## Documentation

- [ ] Update `docs/API.md` — add a "Reranker overrides" subsection under
      `/v1/query`, document the merge semantics ("partial override; omitted
      fields inherit from the corpus profile") and the `enabled: true`
      validation rule.
- [ ] Update the `queryEndpoint` `description` block in
      `apps/api/src/routes/query.ts` so the OpenAPI / Scalar-rendered docs
      pick up the new section without a separate doc edit.
- [ ] If `docs/QUICKSTART.md` shows a query example, add one with a rerank
      override to make the surface discoverable.

## Risks & open questions

1. **Provider key id vs ref precedence on the rerank path.** The embedding
   and inference paths already use the `'either'` kind that errors when
   neither is given but allows id-or-ref. The rerank path is more permissive
   (the `optional_ref` + `default`-label fallback). The plan above keeps the
   two paths semantically distinct: rerank stays optional. If product
   wants to make rerank required when the profile says `enabled: true`, that
   would tighten the resolver to `'either'` and accept an explicit BAD_REQUEST
   on missing key. Flag for review.
2. **Profile validation timing.** Today the profile schema's
   `superRefine` (corpus-profiles/src/schema.ts:83-92) only fires at
   YAML-load time. The merged-profile validation needs to run in the request
   handler — either by re-parsing the merged result through `RerankConfig`
   or by an explicit check. The latter is cheaper. Decide in the
   implementation pass.
3. **Sandbox UX defaults.** "Inherit profile" as the default is the
   non-surprising choice but means the user has to know to expand the
   Reranker group to discover the controls. Consider showing the active
   profile's rerank config inline (read-only) so the user knows what they're
   inheriting. Low priority; defer unless first user feedback requests it.
4. **Audit drift if the request overrides `provider`.** Today,
   `audit.reranker.provider` is the *requested* provider (from the merged
   config), not the resolver's resolved provider. They're the same. Keep them
   the same; if a future feature lets the resolver auto-switch providers on
   fallback, the audit must distinguish requested vs executed.

## Sequencing

1. Land contract + override-extractor + Python parity + helper changes in
   one PR. Ship server tests.
2. Land sandbox form changes in a follow-up PR (UI-only, no server
   coupling). Ship manual-checklist evidence in the PR description.
3. Documentation update can ride either PR; prefer landing it with the
   server PR so the OpenAPI docs reflect the new surface immediately.
