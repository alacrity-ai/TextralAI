# Fix Plan 05 — `query.ts` pipeline extraction

> Resolves audit finding §5: `query.ts` is 891 lines with 12
> responsibilities. The route handler alone is ~330 lines of
> imperative pipeline.

## Goal

Replace the monolith with a six-stage pipeline. Each stage is a
small, individually testable module. The route handler shrinks to
~60 lines orchestrating them.

## Layout

```
apps/api/src/query/                     ← NEW directory
├── pipeline.ts                         ← orchestrator: takes a request, runs stages, returns response
├── stages/
│   ├── 01-resolve.ts                   ← namespace + corpus profile + version_ids + profile gate
│   ├── 02-embed.ts                     ← provider key + Phase-2 embed call
│   ├── 03-retrieve.ts                  ← hybrid + rerank
│   ├── 04-context.ts                   ← assembleContext
│   ├── 05-synthesize.ts                ← prompt build + chat() + structured-output validate
│   └── 06-finalize.ts                  ← citation validate + audit + R2 mirror
├── audit-shape.ts                      ← FinalizeAuditArgs + finalizeAudit + finalizeFailure
└── routes.ts                           ← OpenAPI binding only

apps/api/src/routes/query.ts            ← becomes a 5-line re-export of routes.ts
```

## Stage-by-stage responsibilities

### Stage 01 — resolve

```ts
export interface ResolvedQueryContext {
  tenant_id: string;
  namespace: { id: string; corpus_profile: string };
  profile: CorpusProfile;             // already merged with request overrides
  version_ids: string[];
  embedding_profile: string;          // fully resolved name
  chunking_profile: string;
}

export async function resolveQueryContext(
  env: Env,
  tenant_id: string,
  body: QueryRequest,
): Promise<ResolvedQueryContext>;
```

Folds: namespace lookup, profile resolution + override merge,
version_id resolution, profile-gate check.

### Stage 02 — embed

Call the embedding provider with the query text. Returns
`{query_vector, embedding_input_tokens, provider_key_id}`. Throws on
provider failure (caller catches).

### Stage 03 — retrieve

Hybrid retrieval + reranker invocation + fallback. Returns:

```ts
export interface RetrieveStageOutput {
  candidates: FusedHit[];               // post-rerank order
  retrieval: HybridResult;
  reranker_audit: RerankerAudit;
}
```

### Stage 04 — context

`assembleContext` with profile-driven layer_budgets/order. Returns
the existing `AssembledContext`.

### Stage 05 — synthesize

Prompt build → provider chat call → structured-output validation.
Returns:

```ts
export interface SynthesizeStageOutput {
  answer: Answer;
  raw_text: string;
  synthesis_input_tokens: number;
  synthesis_output_tokens: number;
  synthesis_status: 'success' | 'truncated' | 'failed';
  provider_key_id: string;
}
```

### Stage 06 — finalize

Citation validation, degradation computation, audit row update,
R2 mirror best-effort. Returns the full `QueryResponse`.

## Pipeline orchestrator

```ts
export async function runQueryPipeline(
  env: Env,
  tenant_id: string,
  body: QueryRequest,
): Promise<QueryResponse> {
  const start = Date.now();
  const ctx = await resolveQueryContext(env, tenant_id, body);
  const qevId = await insertQueryEvent(env, /* ... */);
  try {
    const embed = await embedQuery(env, ctx, body, qevId);
    const retrieve = await retrieveCandidates(env, ctx, embed, body, qevId);
    if (retrieve.candidates.length === 0) {
      return await finalizeEmpty(env, ctx, retrieve, qevId, start);
    }
    const context = await assembleContextStage(env, ctx, retrieve);
    const synth = await synthesize(env, ctx, body, context, qevId);
    return await finalize(env, ctx, qevId, body, retrieve, context, synth, start);
  } catch (e) {
    return await finalizeFailure(env, qevId, e, start);
  }
}
```

The route handler in `routes.ts` is just OpenAPI plumbing + a call
to `runQueryPipeline`.

## What's NOT in scope

- Streaming. Phase 6 owns that; the pipeline shape leaves room for
  it (synthesize stage becomes a generator).
- Per-stage independent retries. Today the handler retries-via-fail.
  Pipeline preserves that.
- Caching of embeddings or rerank results. Phase 7+ if profiling
  shows leverage.

## Tests

- Existing `query-route.test.ts` cases continue to pass — they hit
  the route handler at the OpenAPI boundary, which now goes through
  the pipeline. No behavior change.
- New `apps/api/test/query/stage-{01..06}.test.ts` files — one
  focused unit per stage. Each stage takes `Env` + the previous
  stage's output; mocking is straightforward.
- Existing `query-route.test.ts` and `regression-quota.test.ts` stay
  as integration coverage.

## Acceptance

- `pnpm --filter @textral/api typecheck` clean.
- `pnpm --filter @textral/api test` green.
- Both live e2es green.
- `wc -l apps/api/src/routes/query.ts` ≤ 30 (re-export only).
- Each stage file ≤ 200 lines.

## Sequencing

Depends on §3 (D1 helpers) and §2 (provider key consolidation) being
done first. Doing it after those means the stages don't have to do
their own SQL or their own try/catch around `BAD_REQUEST`.

This is the biggest unlock for Phase 6 (streaming). Worth the
upfront cost.
