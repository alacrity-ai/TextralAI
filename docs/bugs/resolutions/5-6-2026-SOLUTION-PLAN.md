# Bugs 5-6-2026 — Solution Plan

Three bugs from `docs/bugs/5-6-2026.md`. Each has a focused root cause, a
concrete fix, and acceptance criteria. The three are independent and can
land as three separate PRs (or one bundled PR per maintainer preference).

---

## Bug 1 — GPT-5 / reasoning-model inference fails with `bad_request`

### Root cause

`apps/api/src/providers/openai-compat.ts:187-200` `buildChatBody` always
sends two fields that OpenAI's reasoning-model family rejects:

```ts
const body: Record<string, unknown> = {
  model: req.model,
  messages: req.messages,
  temperature: req.temperature ?? 0,    // ← reasoning models reject !== 1
};
if (req.max_tokens != null) body.max_tokens = req.max_tokens;  // ← deprecated
```

OpenAI's reasoning-model family (`gpt-5*`, `o1*`, `o3*`, `o4*`) has these
documented constraints in the Chat Completions API:

1. `temperature` only accepts the default value (`1`). Sending `0` or any
   non-1 value returns `400 bad_request: "Unsupported value: 'temperature'
   does not support <x>. Only the default (1) value is supported."`
2. `max_tokens` is deprecated for these models — must use
   `max_completion_tokens` instead. Sending `max_tokens` returns
   `400 bad_request: "Unsupported parameter: 'max_tokens' is not supported
   with this model. Use 'max_completion_tokens' instead."`
3. `top_p`, `presence_penalty`, `frequency_penalty` are also rejected
   (we don't currently send these, but the encoder needs to keep ignoring
   them — verified).

The user's logs show three retries on `bad_request` (the request fails
deterministically; retries are wasted) — that's a secondary issue. See
"Secondary fix" below.

### Fix

**Primary — adapt the request body to the model family.**

1. Add `isReasoningModel(model: string): boolean` in
   `apps/api/src/providers/openai-compat.ts`. Match (case-insensitive):
   - `^gpt-5` (covers `gpt-5`, `gpt-5-mini`, `gpt-5.4`, `gpt-5.4-mini`,
     `gpt-5.5`, etc.)
   - `^o1`, `^o3`, `^o4` (covers `o1`, `o1-mini`, `o3-mini`, `o4-mini`)
2. Branch in `buildChatBody`:
   - For reasoning models: omit `temperature` entirely; if
     `req.max_tokens != null`, emit it as `max_completion_tokens`.
   - For everything else: keep today's behavior unchanged
     (`temperature` always sent, `max_tokens` always sent).
3. Mirror the same predicate + branch on the streaming path
   (`openai-compat.ts` streaming chat — same file).

**Secondary — stop retrying deterministic 400s.**

`apps/api/src/providers/error-classification.ts:48` lists `bad_request` as
NOT fatal, so the retry loop hits it three times before giving up. 400s on
OpenAI are virtually always deterministic (malformed request, unsupported
param, missing required field) — retrying just delays the inevitable
error and burns latency.

Move `'bad_request'` into the `isFatal: true` branch. This is a
cross-provider behavior change but a correct one; provider-specific 400s
that ARE actually transient (we don't currently know any) can be
re-classified to a more specific type by the OpenAI/Anthropic
classifiers if they ever arise.

### Files to change

| File | Change |
|---|---|
| `apps/api/src/providers/openai-compat.ts` | Add `isReasoningModel` helper; branch in `buildChatBody` and the streaming-chat body builder. |
| `apps/api/src/providers/error-classification.ts` | Move `'bad_request'` into `isFatal: true` branch. |
| `apps/api/test/providers/openai-compat.test.ts` (or new file) | Cover reasoning-model body shape. |
| `apps/api/test/providers/error-classification.test.ts` | Update `isFatal('bad_request')` expectation. |

### Acceptance criteria

- [ ] **Reasoning-model body shape** unit test: `buildChatBody({ model:
      'gpt-5.4-mini', temperature: 0.2, max_tokens: 512, ... })` produces
      a body with `max_completion_tokens: 512`, NO `temperature` field,
      NO `max_tokens` field. `model` and `messages` are unchanged.
- [ ] **Legacy-model body shape** test: `buildChatBody({ model:
      'gpt-4o-mini', temperature: 0.2, max_tokens: 512, ... })` produces
      `temperature: 0.2`, `max_tokens: 512`. (Regression check.)
- [ ] **Reasoning streaming** test: streaming chat against `gpt-5*`
      omits `temperature` and uses `max_completion_tokens`.
- [ ] **isFatal regression**: `isFatal('bad_request') === true`. Update
      retry-loop tests so a `bad_request` error short-circuits after one
      attempt instead of three.
- [ ] **Manual live**: configure inference `provider: openai, model:
      gpt-5.4-mini` against any namespace; query succeeds. Audit shows
      `inference_model: 'gpt-5.4-mini'` and a non-zero
      `synthesis_output` token count.

### Notes / risks

- The reasoning-model predicate is a moving target. OpenAI may release
  new families with new constraints (`o5`, etc.). Ship the matcher with
  a comment pointing at the OpenAI docs page ("Reasoning models — API
  differences") so the next person who reads it knows where to check.
- Some reasoning models (notably `gpt-5`-vintage with the Responses API)
  also support a `reasoning_effort` parameter and a `verbosity` knob.
  This plan does NOT add those — they're enhancements, not fixes. Track
  separately.
- The `temperature` field on `InferenceConfig` (`packages/contracts/src/query.ts`)
  is currently optional with a `min(0).max(2)` range. We can leave the
  contract as-is and silently drop `temperature` for reasoning models;
  that's friendlier than rejecting valid-shape requests at the contract
  layer for a model-specific reason.

---

## Bug 2 — Model selection should be a dropdown backed by a known-models registry

### Current state

The sandbox `QueryForm` exposes `embedding_model`, `inference_model`, and
(after the recent rerank-controls work) `rerank_model` as free-text
inputs. There is no registry of valid models anywhere in the codebase —
just hard-coded strings scattered across:
- `apps/api/src/openapi/code-samples.ts` (~15 references to
  `gpt-4o-mini`)
- `apps/api/src/ingestion/dispatch.ts:200-208` (dimension defaults for a
  handful of embedding models)
- `apps/sandbox/src/components/QueryForm.tsx` defaults.

A user has to memorize exact model IDs.

### Design

**Build a curated static registry, surface it via API + MCP, consume it
in the sandbox.**

The alternative — fetching live from each provider — is rejected:
- Live calls require a provider key per request, hitting the user's
  rate limits just to populate a dropdown.
- Provider model lists include hundreds of variants the user never
  needs (fine-tunes, deprecated snapshots).
- Provider lists differ wildly in shape and don't tell you which models
  are appropriate for embedding vs inference vs rerank.

A curated list is what we already de facto maintain (every code sample
hard-codes `gpt-4o-mini`); we just centralize it.

#### Registry data shape

Add `packages/contracts/src/models.ts`:

```ts
export type ModelKind = 'embedding' | 'inference' | 'rerank';
export type ModelFamily = 'openai_chat' | 'openai_reasoning' | 'openai_embedding'
  | 'anthropic_messages' | 'voyage_rerank' | 'cohere_rerank' | 'workers_ai';

export interface KnownModel {
  id: string;
  provider: ProviderName;
  kind: ModelKind;
  family: ModelFamily;
  /** For embedding models: native (or recommended) dimension. */
  dimensions?: number;
  /** For embedding models: dimensions the API can return when explicitly
   *  requested via `dimensions=N` (Matryoshka). */
  supported_dimensions?: number[];
  /** Tag for UX hints — e.g., 'fastest', 'cheapest', 'flagship'. */
  tier?: 'flagship' | 'standard' | 'mini' | 'lite';
  deprecated?: boolean;
  notes?: string;
}

export const KNOWN_MODELS: KnownModel[] = [ /* curated list */ ];
```

Initial registry contents (non-exhaustive, easy to extend):

| Provider | Kind | Models |
|---|---|---|
| openai | embedding | `text-embedding-3-large` (1536/native, also 1024, 768, 256), `text-embedding-3-small` (1536/native, also 512) |
| openai | inference | `gpt-4o`, `gpt-4o-mini`, `gpt-5`, `gpt-5-mini`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `o1`, `o1-mini`, `o3-mini`, `o4-mini` |
| anthropic | inference | `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` |
| voyage | rerank | `rerank-2`, `rerank-2.5`, `rerank-2.5-lite`, `rerank-2-lite` |
| cohere | rerank | `rerank-english-v3.0`, `rerank-multilingual-v3.0` |
| workers_ai | embedding | `@cf/baai/bge-large-en-v1.5` (1024), `@cf/baai/bge-base-en-v1.5` (768) |

Source of truth for the registry lives next to the contracts so the
schema and registry move together.

#### API surface

`GET /v1/models` — returns `{ data: KnownModel[] }`. Optional query
params:
- `?provider=openai` — filter by provider
- `?kind=embedding` — filter by kind
- `?include_deprecated=true` — include `deprecated: true` rows (default
  false)

The endpoint is auth-gated via the standard `ApiKeyAuth` (lives behind
the tenant scope) but does not actually reference any tenant-scoped
data. Self-hosted deploys can rely on the API key check + WAF.

#### MCP tool

Add `list_models` to `packages/mcp/src/tools/`:

```ts
export const listModels = defineTool({
  name: 'list_models',
  description: 'List the curated registry of known models per provider/kind...',
  inputSchemaZod: z.object({
    provider: ProviderName.optional(),
    kind: z.enum(['embedding', 'inference', 'rerank']).optional(),
    include_deprecated: z.boolean().optional(),
  }),
  ...
});
```

#### Sandbox UI

`QueryForm.tsx` changes:
1. Fetch `/v1/models` on mount via a new context (e.g.,
   `ModelRegistryContext`) so the data is shared across forms; cache in
   memory for the session.
2. Replace the three `<Input>` model fields with `<SelectField>`
   pre-populated by the registry, filtered by the selected provider and
   the appropriate `kind`. Allow a free-text "custom..." escape hatch
   for the long tail (writes to the same field; dropdown is just
   ergonomics).
3. When `embedding_provider` or `embedding_model` changes, look up the
   matching `KnownModel` and auto-populate `embedding_dimensions` from
   `dimensions` (or the highest entry in `supported_dimensions`). This
   complements Bug 3's autopopulate.

### Files to change

| Path | Change |
|---|---|
| `packages/contracts/src/models.ts` | NEW — registry data and types. |
| `packages/contracts/src/index.ts` | Re-export `KnownModel`, `KNOWN_MODELS`, etc. |
| `apps/api/src/routes/models.ts` | NEW — `GET /v1/models` route. |
| `apps/api/src/index.ts` (or wherever routes are mounted) | Wire the new route. |
| `packages/mcp/src/tools/models.ts` | NEW — `list_models` tool. |
| `packages/mcp/src/tools/index.ts` (or registration site) | Register the tool. |
| `apps/sandbox/src/api/types.ts` | Mirror `KnownModel` type. |
| `apps/sandbox/src/api/client.ts` | Add `listModels()` method. |
| `apps/sandbox/src/context/ModelRegistryContext.tsx` | NEW — fetch on mount, expose `useModels()`. |
| `apps/sandbox/src/main.tsx` | Wrap app in the new provider. |
| `apps/sandbox/src/components/QueryForm.tsx` | Replace model `<Input>` with provider+kind-filtered `<SelectField>`s. |

### Acceptance criteria

- [ ] **`GET /v1/models`** returns `data: KnownModel[]`. Spot-check
      `gpt-5.4-mini`, `text-embedding-3-large`, `rerank-2.5-lite` are
      present.
- [ ] **`?provider=openai&kind=embedding`** returns only OpenAI
      embedding models.
- [ ] **MCP**: `mcp__textral__list_models { provider: 'voyage', kind:
      'rerank' }` returns the rerank-2.5 family.
- [ ] **Sandbox**: changing `embedding_provider` filters the
      `embedding_model` dropdown; selecting `text-embedding-3-large`
      auto-fills `embedding_dimensions` to a sensible default.
- [ ] **Custom escape hatch**: typing a model name not in the
      dropdown still works (saves and submits). This protects against
      registry staleness.
- [ ] Free-text fallback is documented in the form's UI ("Type a
      custom model ID if not listed").

### Notes / risks

- The registry will go stale. Mitigations: (a) the custom escape hatch
  keeps users unblocked; (b) the registry is one PR away from being
  updated; (c) eventually we can add a periodic CI job that fetches the
  upstream model lists and PRs updates. Out of scope for this fix.
- Don't bundle the registry into the *built* MCP / sandbox bundles
  separately — load it from the API. Single source of truth.

---

## Bug 3 — Dimension mismatch is opaque

### Root cause

Two separate problems stack:

1. **Form defaults to 1536 unconditionally.** `apps/sandbox/src/components/QueryForm.tsx:34-58`
   defaults `embedding_dimensions: 1536`. There's a `useEffect` at line
   97-112 that tries to refine this from `active.default_embedding_profile`,
   but it only refines the *model name* — it always re-sets dimensions
   to 1536 when it sees `text-embedding-3-large` in the profile string,
   even when the namespace was actually ingested at 1024 dims.
2. **The namespace `default_embedding_profile` field doesn't always
   carry the dimension.** The user's `lighthouse-tales` namespace has
   `default_embedding_profile: 'openai-text-embedding-3-large'` (no
   `-1024` suffix) — a soft default. The *authoritative* dimensions
   live on the `version_indexes` rows and on the chunks themselves.

The error message itself already includes a `dimension: 'embedding' |
'chunking' | 'both'` discriminator and an `available[]` array
(`apps/api/src/retrieval/profile-gate.ts:33-48`), but:
- The error catalog's headline message
  (`apps/api/src/openapi/error-catalog.ts:151`) is generic.
- The sandbox renders the message field and likely drops the structured
  details, so users never see the diagnostic info.

### Fix — combined A + B (per the user's request)

#### A) Better error message — server-side

Rewrite the message in `profile-gate.ts:32` to be self-explanatory when
the dimension is the failing field:

```ts
const requestedDim = parseDimFromProfile(req.embedding_profile);
const availableProfiles = available.map(v => v.embedding_profile);
const availableDims = availableProfiles.map(parseDimFromProfile);

const message = dimension === 'embedding'
  ? `Embedding profile mismatch. Query asked for "${req.embedding_profile}"` +
    ` but this namespace was ingested with [${availableProfiles.join(', ')}].` +
    ` Re-query with one of the available profiles, or re-ingest at the requested profile.`
  : `Profile mismatch on ${dimension}. Requested ` +
    `(${req.chunking_profile}, ${req.embedding_profile}); available: ` +
    `[${available.map(v => `(${v.chunking_profile}, ${v.embedding_profile})`).join(', ')}].`;
```

The structured `details` payload (the existing `dimension`,
`available`, `requested`, `suggestion` fields) stays as-is so
machine consumers don't break.

Update the error-catalog entry too:

```ts
EMBEDDING_PROFILE_MISMATCH: {
  http: 400,
  when: 'Query\'s embedding profile (model + dimensions) doesn\'t match what this namespace was ingested with.',
  recovery: 'Inspect details.available[] for the indexed profiles; re-query with matching dimensions or re-ingest under the requested profile.',
},
```

#### B) Autopopulate dimensions in the sandbox

Two parts:

**B1) Expose the actually-indexed profiles on `Namespace`.**

Add `indexed_profiles: { embedding_profile, chunking_profile,
embedding_dimensions, embedding_model }[]` to the `Namespace` row that
the API returns. Compute it by joining `version_indexes` rows for
documents in that namespace, deduplicating by
`(chunking_profile, embedding_profile)`.

| Path | Change |
|---|---|
| `packages/contracts/src/namespaces.ts` (or wherever `Namespace` lives) | Add optional `indexed_profiles[]`. |
| `apps/api/src/db/namespaces.ts` | New helper `getIndexedProfilesForNamespace(db, tenantId, namespaceId)`. |
| `apps/api/src/routes/namespaces.ts` | List + get endpoints populate `indexed_profiles`. |

**B2) Sandbox autopopulates from `indexed_profiles`.**

Replace the current `useEffect` block in `QueryForm.tsx:97-112` with:

```ts
useEffect(() => {
  if (!active) return;
  const first = active.indexed_profiles?.[0];
  if (first) {
    // Authoritative — what the namespace was actually ingested with.
    setForm(f => ({
      ...f,
      embedding_provider: profileToProvider(first.embedding_profile),
      embedding_model: first.embedding_model,
      embedding_dimensions: first.embedding_dimensions,
    }));
    return;
  }
  // Fall back to the soft default for empty namespaces.
  if (active.default_embedding_profile?.includes('text-embedding-3-large')) {
    setForm(f => ({
      ...f,
      embedding_model: 'text-embedding-3-large',
      embedding_dimensions: 1536,
    }));
  }
}, [active]);
```

When a namespace has multiple `indexed_profiles` (mixed-profile
ingestion), prefer the most recently created or simply the first; if
multiple are equally valid, the dropdown UX from Bug 2 lets the user
pick.

### Files to change

| Path | Change |
|---|---|
| `apps/api/src/retrieval/profile-gate.ts` | Rewrite message to name the available profiles. |
| `apps/api/src/openapi/error-catalog.ts` | Update `EMBEDDING_PROFILE_MISMATCH` entry. |
| `apps/api/src/db/namespaces.ts` | New `getIndexedProfilesForNamespace` helper. |
| `apps/api/src/routes/namespaces.ts` | List + get include `indexed_profiles`. |
| `packages/contracts/src/namespaces.ts` | `Namespace.indexed_profiles?` typed. |
| `apps/sandbox/src/api/types.ts` | Mirror the new field. |
| `apps/sandbox/src/components/QueryForm.tsx` | Replace `useEffect` to read `active.indexed_profiles` first. |

### Acceptance criteria

- [ ] **Server message**: querying `lighthouse-tales` (1024 dims) with
      `embedding.dimensions: 1536` returns
      `EMBEDDING_PROFILE_MISMATCH` whose `message` contains both
      `openai-text-embedding-3-large-1536` (requested) and
      `openai-text-embedding-3-large-1024` (available). No private data
      leaks; just profile strings.
- [ ] **`GET /v1/namespaces`** returns
      `lighthouse-tales` with `indexed_profiles: [{ embedding_profile:
      'openai-text-embedding-3-large-1024', embedding_model:
      'text-embedding-3-large', embedding_dimensions: 1024, ... }]`.
- [ ] **Sandbox autopopulate**: clicking the namespace picker on
      `lighthouse-tales` sets `embedding_dimensions: 1024` in the form
      without user intervention. Running the default form against
      `lighthouse-tales` succeeds (no profile-mismatch error).
- [ ] **Empty-namespace fallback**: a brand-new namespace with no
      ingested documents still renders sensible form defaults
      (`embedding_dimensions: 1536`).
- [ ] **Mixed-profile namespace** (manually crafted in tests): if
      `indexed_profiles` contains two entries, the form selects the
      first; the dropdown from Bug 2 lets the user switch.

### Notes / risks

- `indexed_profiles` is denormalized data on the namespace row's API
  response — it's computed on read, NOT stored. If a namespace has
  thousands of version_indexes the lookup might add latency to the
  list endpoint. Mitigation: the join is `version_indexes ⨝
  document_versions ⨝ documents` filtered by `namespace_id`, with a
  `DISTINCT (chunking_profile, embedding_profile)` projection. Should
  remain cheap (<10 ms) for typical namespaces; benchmark in the PR if
  any namespace exceeds 10k version_indexes.
- The user's specific symptom resolves with B alone (autopopulate). A
  (better message) is still worth doing because it helps API/MCP users
  who don't go through the sandbox.

---

## Sequencing

These three bugs are independent. Recommended order:

1. **Bug 1** — fastest, smallest blast radius, unblocks gpt-5.x users
   immediately. ~2 hours of work + tests.
2. **Bug 3** — small surface, big UX win for newcomers. The server
   message change is a one-file edit; the namespace `indexed_profiles`
   field is an additive contract change.
3. **Bug 2** — biggest scope (registry data, new API route, new MCP
   tool, sandbox context). Worth doing once Bug 3's `indexed_profiles`
   plumbing is in place since the autopopulate logic in Bug 2 builds
   on Bug 3's work.

If only one bug ships this cycle, ship Bug 1.
