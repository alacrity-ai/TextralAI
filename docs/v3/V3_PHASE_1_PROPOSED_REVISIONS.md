# V3 Phase 1 — Proposed Revisions

> Architect's audit of what shipped in V3 Phase 1. Evaluates against
> four lenses: **extensibility** (can a 4th backend land cleanly?),
> **maintainability** (naming, organization, redundancy, type
> safety), **single-codebase / multi-deploy posture** (does V2 still
> work, does Phase-2 self-host stay reachable?), and **test
> coverage** (what's pinned, what's hand-waved).
>
> Ships proposed corrections in priority order. Each item lists the
> finding, the cost of leaving it, and the proposed change. Items
> at the bottom are "acknowledged debt" — flagged but not fixed in
> this revision.

---

## Audit verdict

**Phase 1 is sound on the four lenses.** The selector dispatches
cleanly (`switch (binding.backend)`); both new adapters share a
consistent constructor + `private fetch` shape; `VectorBinding` is
a small, clean carrier; the migration is additive only;
existing `vectorize` deploys see zero behavior change.

**But six things should be tightened** before the doc says "Phase 1
done" definitively. Five are real (test gaps + a type-safety hole
+ a missing exhaustive-check guard + a duplication-risk helper);
one is a tiny doc-comment. None re-architect anything; all are
small, additive corrections.

---

## Findings (priority order)

### #1 — Missing namespace-creation regression test

**Finding.** The implementation doc's file list (Step 12 / §
"Naming and locations") promised
`apps/api/test/namespace-vector-backend.test.ts`. It was never
created during execution. The new validation rules in
`apps/api/src/routes/namespaces.ts:82-103` —
- Qdrant backend without `vector_index_name` → 400 BAD_REQUEST
- Vectorize backend with `vector_index_name` set → 400 BAD_REQUEST
- Default-omitted `vector_backend` lands as `'vectorize'`
- `vector_index_name` round-trips through `getNamespaceBySlug`

— are pinned only by the deployed-dev manual smoke-test in Step 11
(now stale; the test namespaces were deleted). Nothing in CI
catches a regression.

**Cost of leaving.** A future PR that loosens validation (e.g.,
allows mid-life backend switch) would silently ship.
`docs-regression.test.ts` doesn't catch behavior; only Scalar surface.

**Proposed change.** Create
`apps/api/test/namespace-vector-backend.test.ts` with five tests
covering the validation matrix + round-trip persistence.

---

### #2 — No tests for the `vectorStoreFor()` selector branches

**Finding.** `apps/api/src/retrieval/vector-store.ts:65-110` has
four `TextralError('BAD_REQUEST', ...)` throw paths:
1. Qdrant backend selected but `env.QDRANT_URL` empty.
2. Qdrant backend selected without `binding.index_name`.
3. Pinecone backend selected but `env.PINECONE_API_KEY` empty.
4. Pinecone backend selected without `binding.index_name`.

Plus three success paths returning the right adapter type. Zero
unit tests.

**Cost of leaving.** A future refactor that swaps the env-var
naming or reorders the guards could silently ship a broken
selector. Today nothing in CI exercises it.

**Proposed change.** Create
`apps/api/test/retrieval/vector-store-selector.test.ts` —
mocked-Env coverage of all four error branches + the three
success branches (verify the returned class identity).

---

### #3 — Pinecone metadata cast is sloppy

**Finding.** `apps/api/src/retrieval/adapters/pinecone.ts:56`:

```ts
metadata: r.metadata as unknown as Record<string, string>,
```

Two issues:

1. The double-cast (`as unknown as ...`) hides the actual contract.
2. `VectorMetadata` (the source type) declares fields that are all
   `string`-typed today, but Pinecone's metadata API accepts
   `string | number | boolean | string[]`. The cast claims a
   stricter type than Pinecone enforces, so passing an enum-typed
   field through later would bypass type-safety silently.

**Cost of leaving.** Future contracts changes that add a numeric
or boolean field to `VectorMetadata` would land at runtime
behavior changes without TypeScript catching the implicit
narrowing.

**Proposed change.** Type the Pinecone metadata variable as
`Record<string, string | number | boolean | string[]>` (Pinecone's
actual contract), and cast directly from `VectorMetadata` (which
satisfies that shape since all current fields are strings).

---

### #4 — `uuidv5` lives inside the Qdrant adapter

**Finding.** `apps/api/src/retrieval/adapters/qdrant.ts:184-209`
defines `uuidv5`, `uuidToBytes`, `bytesToUuid` as module-private
helpers. Used twice in `qdrant.ts` (upsert + deleteByIds). Not
exported anywhere.

**Cost of leaving.** If V3 Phase 2 (or a future feature like
audit-key hashing, or another backend whose IDs need UUIDv5
derivation) needs the helper, today's options are:
1. Re-import from `qdrant.ts` (couples the importer to the
   Qdrant adapter — wrong layering).
2. Copy-paste the helper (now we have two implementations to
   keep in sync).

Both are bad. Move it to a shared location now while the surface
is small.

**Proposed change.** Extract `uuidv5` (and its byte helpers) into
`apps/api/src/lib/uuidv5.ts`. Qdrant adapter imports from there.
Pure-fetch implementation, no Node `crypto` import (Workers
runtime constraint preserved).

---

### #5 — `vectorStoreFor()` switch has no exhaustive-check guard

**Finding.** `apps/api/src/retrieval/vector-store.ts:65-110`:

```ts
export function vectorStoreFor(env: Env, binding: VectorBinding): VectorStore {
  switch (binding.backend) {
    case 'vectorize': return new VectorizeV2Adapter(...);
    case 'qdrant': { ... return new QdrantAdapter(...); }
    case 'pinecone': { ... return new PineconeAdapter(...); }
  }
}
```

No `default` clause; no exhaustive check. Currently TS knows
`VectorBackend` is `'vectorize' | 'qdrant' | 'pinecone'`, so the
function-without-default returns `VectorStore` only because every
variant has a `return`. **But:** if a future `VectorBackend`
variant lands (e.g. `'weaviate'`) without a case here, TS emits
*no error* — the compiler reasons that the function returns
`VectorStore | undefined`, which gets widened silently in many
call contexts.

**Cost of leaving.** A new backend added in `contracts/namespace.ts`
without a corresponding adapter would silently return undefined,
and callers would null-deref at runtime.

**Proposed change.** Add an exhaustive-check final line:

```ts
const _exhaustive: never = binding.backend;
throw new Error(`Unhandled vector backend: ${String(_exhaustive)}`);
```

TypeScript will then flag any unhandled variant at compile time.

---

### #6 — Empty-string-as-disabled convention is undocumented

**Finding.** `wrangler.toml`'s `[env.dev.vars]` declares
`QDRANT_URL = ""`. The selector reads
`if (!env.QDRANT_URL)` to detect "Qdrant backend not enabled on
this deploy." Empty string is falsy in JS, so this works — but
it's subtle and a future reader has to derive the contract from
the code.

**Cost of leaving.** Negligible; tightening cost is also
negligible.

**Proposed change.** One-line comment on the env-var guard in
`vector-store.ts` explaining the empty-string convention. No
behavior change.

---

## Acknowledged debt (NOT fixed in this revision)

These are real issues but either V2-historical or out of Phase 1
scope. Documenting them so they don't get re-discovered in
future audits.

### `inferDimensionsFromProfile` is a hardcoded map

`apps/api/src/routes/namespaces.ts` carries a switch from profile
strings to dimensions. The right shape is **profiles carry their
own dimension metadata** in a registry. Today profiles are bare
strings. Refactoring is V2 tech debt, not Phase 1 scope; leaving.

### Pinecone API version is pinned in code (`'2025-04'`)

`apps/api/src/retrieval/adapters/pinecone.ts:131`. If Pinecone
breaks the data-plane shape in a later version, every deploy
breaks. Could be env-overridable
(`PINECONE_API_VERSION`), but until Pinecone actually breaks
something in our usage, the pin keeps deploys deterministic.
Leaving.

### No live Qdrant integration test in CI

The Qdrant adapter is pinned by 7 mocked-fetch unit tests. A
real Qdrant service in CI would catch drift in the actual REST
API (e.g., if Qdrant 1.x → 2.x changes a path). The Phase 1
implementation doc punted this to manual `make dev-stack`
exercise. Wiring CI to spin up the dev compose + run the cookbook
validator with `--backend qdrant` is a follow-up. Leaving.

### `vector_index_name` is overloaded for Pinecone (it's a host URL)

The field name says "index name" but for Pinecone it's the full
host URL (`https://my-idx-xxx.svc.us-east-1.pinecone.io`). A
clean shape would split into `vector_index_handle` (logical) +
`vector_index_endpoint` (URL). Renaming requires a schema
migration + breaking change to consumers; cost-prohibitive for a
naming improvement. Leaving.

### BAD_REQUEST vs operator-config-error semantics

The selector throws `BAD_REQUEST` when the deploy is missing
`QDRANT_URL` / `PINECONE_API_KEY`. The HTTP 400 is technically
correct (the consumer asked for a backend the deploy doesn't
support), but a future revision could differentiate "operator
misconfigured" from "consumer sent bad input" with a separate
error code (`BACKEND_UNAVAILABLE`?). Catalog churn vs marginal
clarity gain — leave as-is for now.

---

## Plan

Apply revisions #1–#6 in a single pass. Re-run typecheck + lint +
test + deploy + spot-check live `/openapi.json`.

Acceptance:
- New tests pass; all existing tests still green.
- Lint + typecheck clean.
- `tools/check-no-inline-d1.sh` still passes.
- Deployed `/docs` unchanged in user-visible content (revisions
  are internal hygiene, not docs surface).
