# Fix Plan 01 — Vector store interface

> Resolves audit finding §1: `VECTORIZE_OPENAI_LARGE` is hardcoded in
> three files. Adding a second Vectorize index (e.g. for
> `workers_ai` 1024-dim embeddings) is a multi-file change. Swapping
> the vendor entirely is a larger refactor.

## Goal

A single `VectorStore` interface that the rest of the code reaches
through. Selecting the right binding for a given embedding profile
becomes a one-line lookup. Adding a Qdrant adapter (or any other
vendor) becomes one new file.

## Files

**New:**
- `apps/api/src/retrieval/vector-store.ts` — interface + selector +
  Vectorize-V2 adapter.

**Edit:**
- `apps/api/src/retrieval/vectorize-query.ts` — delete; the dense
  query helper moves into `vector-store.ts`.
- `apps/api/src/retrieval/hybrid.ts` — replaces `denseQuery(env, ...)`
  with `vectorStoreFor(env, profile).query(...)`.
- `apps/api/src/routes/internal/ingest-write.ts` — `vectorize/upsert`
  + `vectorize/delete-by-filter` routes call through the interface.
- `apps/api/src/types.ts` — keep the binding declaration; document
  that direct binding access outside `vector-store.ts` is forbidden.

## Interface

```ts
export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface VectorMetadata {
  tenant_id: string;
  namespace_id: string;
  document_id: string;
  version_id: string;
  version_index_id: string;
  artifact_type: string;
}

export interface DenseFilter {
  tenant_id: string;
  namespace_id: string;
  version_id?: { $in: string[] } | string;
  artifact_type?: { $in: string[] } | string;
}

export interface DenseHit {
  chunk_id: string;
  score: number;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<{ mutation_id: string | null }>;
  query(
    vector: number[],
    opts: { topK: number; filter: DenseFilter },
  ): Promise<DenseHit[]>;
  deleteByIds(ids: string[]): Promise<{ count: number }>;
}

export function vectorStoreFor(env: Env, embeddingProfile: string): VectorStore;
```

`vectorStoreFor` switches on the profile name. Today only
`openai-text-embedding-3-large-1536` resolves; future profiles add
cases. An unknown profile throws `EMBEDDING_PROFILE_MISMATCH`.

## What's NOT in scope

- Provisioning a 1024-dim Vectorize index for `workers_ai`. The
  *interface* is ready; provisioning is a deploy-time action and
  doesn't affect this fix.
- Implementing a Qdrant adapter. Same reason.
- Per-namespace overrides (Phase 7+).

## Tests

- `apps/api/test/vector-store.test.ts` (new):
  - `vectorStoreFor('openai-text-embedding-3-large-1536')` returns a
    real adapter with `upsert`/`query`/`deleteByIds` methods.
  - Unknown profile name throws `EMBEDDING_PROFILE_MISMATCH`.
  - `query()` round-trip with a stubbed binding produces the same
    `chunk_id`/`score` rows the existing `vectorize-query.test.ts`
    asserts.
- Existing `hybrid.test.ts` and `ingest-write` tests remain as
  regression coverage (they go through the new interface).

## Acceptance

- `pnpm --filter @textral/api typecheck` clean.
- `pnpm --filter @textral/api test` green (no regressions).
- `make test-live` + `make test-live-phase5` green against deployed dev.
- `grep -rEn 'VECTORIZE_OPENAI_LARGE' apps/api/src/` returns at most
  one hit (in `vector-store.ts`) plus the binding declaration in
  `types.ts`.

## Sequencing note

Independent of the other fixes; can be done in any order. Done after
§5 (query.ts split) to avoid touching the query path twice in one PR.
