# Phase 6 + 7 — Implementation Steps

> Companion to `docs/2-PHASES.md`. Concrete, ordered steps for
> Phase 6 (failure surface + observability + streaming + cost rollups +
> bulk-enrichment admin) and Phase 7 (eval contract).
>
> A dev should be able to follow this document end-to-end and finish
> both phases without making design decisions or asking questions.
> Where the design doc left a choice open, this document picks one.

---

**At completion, you will have:**

Phase 6:
- A standardized error envelope written by a global error handler that
  all routes inherit (no per-route try/catch boilerplate).
- A DLQ admin surface: `GET /v1/admin/ingestion-jobs?dead_lettered=1`
  lists dead-lettered jobs scoped to the caller's tenant; `POST
  /v1/ingestion-jobs/:id/retry` clears the flag and re-enqueues.
- Workers Analytics Engine writes for `query_executions`,
  `ingestion_stage_outcomes`, and `provider_calls`. The deploy can be
  pointed at a real AE binding, but the writes are no-ops when the
  binding is missing (tests + dev).
- AI Gateway tags propagated on every provider call: `tenant_id`,
  `namespace_id`, `query_event_id`, `provider_key_id`, `job_id` — so
  AIG dashboards group by tenant correctly.
- SSE streaming for `/v1/query?stream=sse`. Two event types: `token`
  and `done`. The `done` event carries `degradation_level`,
  `query_event_id`, citations, and audit. Citation validation runs
  once on `done`.
- An `ALERTS.md` runbook documenting the alert set in `1-DESIGN.md`
  §15.3 and how to wire each alert in Cloudflare.
- A `usage_records` rollup populated by every successful query (for
  `queries`, `input_tokens`, `output_tokens`) and every successful
  ingestion (for `ingestion_jobs`, `embedding_tokens`).
- A bulk enrichment-only admin endpoint at
  `POST /v1/admin/namespaces/:slug/enrichment-runs` that supports
  `dry_run=true` for previews.

Phase 7:
- `eval_sets`, `eval_questions`, `eval_runs`, `eval_results` tables
  via migration `0004_eval.sql`.
- API: register an eval set, run it, fetch results.
- Built-in judges (relevance / groundedness / citation_quality) plus
  hooks for tenant-supplied judge prompts.
- A `packages/eval-cli` package with a `textral` binary that drives
  the eval API and emits machine-readable + human-readable output.
- A baseline narrative fixture eval that runs in CI as a regression
  gate.

By the end of these phases, an outside reviewer can: register a
namespace, ingest a document, run a streaming query, watch tokens
arrive, see usage tally on their tenant, and run an eval set against
the namespace with deterministic scores.

---

## What these phases specifically do NOT do

- **No tenant-scoped corpus-profile overrides.** Per `2-PHASES.md`
  §6.9 and Phase 5 deferral. Namespace + per-request override are
  sufficient for MVP.
- **No CF cron for usage GC.** The 90-day prune query lands in the
  runbook; wiring a cron is Phase 8 ops work.
- **No alert delivery wiring beyond docs.** The runbook tells an
  operator how to configure Cloudflare alert rules manually; we don't
  ship a Pulumi/Terraform module.
- **No tenant-side judge LLM defaults.** Built-in judges all use the
  caller-provided `provider_key_ref` for the inference model; if the
  tenant hasn't set one up, the eval call rejects at parse time.
- **No new embedding profiles** (already locked in Phase 5).

---

## Prerequisites recap

These are already true at the end of the post-Phase-5 cleanup:

- Phase 5's audit cleanup is merged: `vector-store.ts`, unified
  `provider-key-resolver`, `src/db/*.ts` SQL helpers, query.ts split,
  R2 sentinel-URL fallback gone, schema-mirror docs.
- `/internal/providers/embed` and `/internal/providers/chat` exist on
  the Worker and the Container's enrichment runner uses them.
- The audit shape `QueryAudit` is canonical in
  `packages/contracts/src/query.ts`; `audit-shape.ts` re-exports it.
- 238 api tests, 50 corpus-profiles tests, 84 ingest tests green.
- `make test-live` and `make test-live-phase5` both work end-to-end
  against deployed dev.

Operational prereqs:

- `pnpm` and Node 24.
- Dev deploy intact.
- Optional but recommended for §6.3: a Cloudflare Analytics Engine
  dataset binding called `AE_METRICS` in `wrangler.toml`. Without it,
  metric writes are no-ops (the helper detects a missing binding).

---

## Locked-in technology choices

### Failure surface

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Error envelope shape | **Existing `ErrorEnvelope` from `packages/contracts/src/error.ts`** | Already canonical; no schema change. |
| Global error handler placement | **Hono `app.onError(...)` in `apps/api/src/index.ts`** | Catches everything thrown by route handlers + middleware. Per-route `onError` only for sub-apps (already done for `/internal`). |
| Error middleware vs handler | **Hono `onError` (not middleware)** — per-app, returns the envelope | Middleware fires before route logic; we want the catch-all *after*. |
| Request-id propagation | **`request_id` set by middleware (already in place via `c.get('request_id')`)** | Echoed in the envelope. |
| Catalog gating | **A new test asserts every route's known error responses use codes from the catalog** | Drift-prevention: a fresh `'NOT_REGISTERED'` literal at any throw site fails the test. |
| Phase 6 new error codes | **`DLQ_NOT_FOUND`, `DLQ_NOT_DEAD_LETTERED`, `STREAM_INTERRUPTED`, `EVAL_SET_NOT_FOUND`, `EVAL_RUN_FAILED`** | Adds to the existing catalog enum. |

### Observability

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Metrics datasets | **Three AE datasets: `query_executions`, `ingestion_stage_outcomes`, `provider_calls`** | Each is a different cardinality + grain. Combining loses dashboard ergonomics. |
| Write helper | **`writeMetric(env, dataset, blobs, doubles, indexes)`** in `src/observability/metrics.ts` | One thin wrapper, no-ops if `env.AE_METRICS` is absent. |
| Metric write timing | **After the response body is finalized**, via `c.executionCtx.waitUntil(...)` | Never blocks the user response on telemetry. |
| AI Gateway metadata allowlist | **`tenant_id`, `namespace_id`, `query_event_id`, `provider_key_id`, `job_id`, `request_id`** | Already in `buildAigMetadata`'s allowlist; ensure every call site populates them. |
| Per-call telemetry tag completeness | **Audited by a new test** that walks every `resolve(env, opts)` call site and asserts `request_metadata` carries at least `tenant_id` | One-time sweep, plus a lint-style test to keep it that way. |

### Streaming

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Wire format | **SSE** (Server-Sent Events) per `1-DESIGN.md` §12.4 | Browser-friendly; Workers `Response` body supports `ReadableStream`. |
| Event types | **`token` and `done`**, no `error` | Errors mid-stream become a `done` with `degradation_level='cannot_answer'` and a synthesis_status of `'failed'`. Keeps the consumer state machine two-state. |
| Citation validation | **Runs once on `done`** | Streaming citations as they arrive is wasted: the model writes the answer *with* citations inline. We validate the full set at end. |
| Truncation | **Sync path's max-token logic also applies to streaming** | Same provider call, same options. |
| Citation-grounding mid-stream | **No** — only at `done` | Streaming gracefully degrades a small set of cases: a citation references a chunk that doesn't exist. The `done` event carries the dropped list. |
| Provider compatibility | **Anthropic + OpenAI compat (text-embedding-only providers excluded; this is a chat path)** | Both expose SSE-shaped streaming over their HTTP APIs. The Worker proxies the stream tokens through. |
| Worker streaming primitive | **`new Response(readableStream, { headers: SSE_HEADERS })`** + `TransformStream` for the source | Native; no extra deps. |
| Heartbeat | **None** for MVP. If the answer is long enough that idle timeouts matter (CF Worker idle timeout is generous on a streamed response), add `: keepalive\n\n` comments in Phase 8 ops. | Don't pre-build infrastructure for an unobserved problem. |

### Cost rollup

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Bucket grain | **Daily**: `period_start` is `Math.floor(now / 86_400_000) * 86_400_000` | Matches `usage_records` schema; keeps the row count bounded. |
| Upsert pattern | **`INSERT ... ON CONFLICT (tenant_id, period_start) DO UPDATE SET col = col + ?`** | Atomic increment without a read-modify-write race. |
| Where to call from | **Query: in `routes/query.ts` after `finalizeAudit`. Ingestion: in `routes/internal/ingest-write.ts` chunks-batch handler.** | Single capture points; failures go to error path which doesn't touch usage. |
| Failure-path writes | **NEVER count failed queries / failed ingestions** | The whole point of cost attribution is that a customer doesn't get billed for failed work. |
| Streamed query writes | **On `done` event success** | Same call point as sync — wrap with a try/finally that fires usage on `synthesisStatus === 'success'`. |

### Bulk enrichment-only admin

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Scope | **Per-namespace** (`POST /v1/admin/namespaces/:slug/enrichment-runs`) | Bulk-across-tenants is operator territory; not in MVP. |
| Auth | **API key with `admin` scope** | Existing scopes plumbing; admin scope gates write paths. |
| Filter | **`{ profile_id?, since?, until?, limit? }`** | All optional. `since` / `until` filter `version_indexes.created_at`. |
| Job mode | **`'enrichment_only'`** existing path | Reuses dispatch; no new mode. |
| Dry-run | **Returns matched count without enqueuing** | Operator can preview blast radius. |
| Rate limit | **10 enqueue batches / min / tenant** (one row in `admin_rate_limits` D1 table — created in this phase as a single shared limiter) | Simple counter; refills per minute. |

### Eval

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Eval set scope | **Per-namespace** | Eval questions only make sense against a corpus. |
| Question shape | **`{ id, question, expected_answer?, must_cite_chunks?, judge_overrides? }`** | Optional fields for "we don't know exactly what we want, just judge it". |
| Run trigger | **Synchronous-with-polling**: `POST .../runs` returns immediately with a `run_id`; `GET .../runs/:run_id` polls. Worker enqueues to a new `EVAL_QUEUE` and a worker handles it. | Eval can take minutes for large sets; sync would tie up the request. |
| Judge invocation | **Per-question, parallel up to N=5 inflight** | Throughput without flooding upstream. |
| Built-in judges | **`relevance`, `groundedness`, `citation_quality`** | Per `1-DESIGN.md` §16. |
| Judge prompt format | **Markdown files in `apps/api/src/eval/judge-prompts/*.md`** with a `{{}}-templated` body | Easy to read + diff. |
| Scoring | **5-point Likert per judge, plus pass/fail boolean per question** | Pass/fail = "all judges ≥ 4". Tunable. |
| Tenant-supplied judges | **`judge_overrides: { judge_id: 'tenant-supplied-prompt-text' }` on the question** | Per-question + per-set hooks. |
| Eval run audit | **Each question's full request/response logged in `eval_results`** | Replay on regression analysis. |
| eval-cli output | **JSON to stdout (machine), human-readable to stderr** | Pipe-friendly. |
| eval-cli config | **`.textralrc` JSON: `{ api_key, base_url, namespace }`** | Simple; env vars override. |

---

## Naming and locations

```
apps/api/
├── migrations/
│   ├── 0004_admin_rate_limits.sql          ← NEW (Phase 6.8)
│   └── 0005_eval.sql                       ← NEW (Phase 7.1)
├── src/
│   ├── routes/
│   │   ├── admin/
│   │   │   ├── ingestion-jobs.ts           ← NEW (Phase 6.2)
│   │   │   └── enrichment-runs.ts          ← NEW (Phase 6.8)
│   │   ├── query.ts                        ← EXTENDED (SSE branch)
│   │   ├── query-stream.ts                 ← NEW (Phase 6.5)
│   │   └── eval.ts                         ← NEW (Phase 7.2)
│   ├── synthesis/
│   │   └── streaming.ts                    ← NEW (Phase 6.5)
│   ├── observability/
│   │   ├── metrics.ts                      ← NEW (Phase 6.3)
│   │   └── usage.ts                        ← NEW (Phase 6.7)
│   ├── eval/
│   │   ├── judges.ts                       ← NEW (Phase 7.3)
│   │   ├── runner.ts                       ← NEW (Phase 7.2)
│   │   └── judge-prompts/
│   │       ├── relevance.md
│   │       ├── groundedness.md
│   │       └── citation_quality.md
│   ├── db/
│   │   ├── usage-records.ts                ← NEW (Phase 6.7)
│   │   ├── admin-rate-limits.ts            ← NEW (Phase 6.8)
│   │   └── eval.ts                         ← NEW (Phase 7.2)
│   ├── middleware/
│   │   └── error-envelope.ts               ← EXTENDED (catalog gating)
│   └── index.ts                            ← EXTENDED (global onError, /admin mount, /eval mount)
├── test/
│   ├── error-envelope-route-snapshot.test.ts   ← NEW (Phase 6.1)
│   ├── admin-ingestion-jobs.test.ts            ← NEW (Phase 6.2)
│   ├── observability-metrics.test.ts           ← NEW (Phase 6.3)
│   ├── ai-gateway-tag-coverage.test.ts         ← NEW (Phase 6.4)
│   ├── query-stream.test.ts                    ← NEW (Phase 6.5)
│   ├── usage-records.test.ts                   ← NEW (Phase 6.7)
│   ├── admin-enrichment-runs.test.ts           ← NEW (Phase 6.8)
│   ├── eval-route.test.ts                      ← NEW (Phase 7.2)
│   ├── eval-judges.test.ts                     ← NEW (Phase 7.3)
│   └── fixtures/eval/
│       └── narrative-baseline.json             ← NEW (Phase 7.5)
docs/
├── runbooks/
│   ├── ALERTS.md                          ← NEW (Phase 6.6)
│   └── dashboards/
│       └── core.json                      ← NEW (Phase 6.3)
packages/
├── contracts/src/
│   ├── error.ts                           ← EXTENDED (new codes)
│   ├── admin.ts                           ← NEW
│   ├── eval.ts                            ← NEW
│   └── streaming.ts                       ← NEW (SSE event shapes)
└── eval-cli/                              ← NEW (Phase 7.4)
    ├── package.json
    ├── tsconfig.json
    ├── bin/textral
    └── src/index.ts
```

---

## Phase 6 — step-by-step

### Step 6.1 — Standardized error envelope: global `onError` + catalog gating

**6.1.1** Wire a global `onError` on `apps/api/src/index.ts` (the
top-level `app`). It mirrors the per-sub-app handlers already in place
on `/internal/*` and `/v1/*`:

```ts
app.onError((err, c) => {
  if (err instanceof TextralError) {
    return c.json(
      err.toEnvelope(c.get('request_id')),
      err.httpStatus as 400 | 401 | 403 | 404 | 422 | 500,
    );
  }
  console.error('unhandled_error', { request_id: c.get('request_id'), message: err.message });
  return c.json(
    { error: { code: 'INTERNAL', message: 'Internal error' } },
    500,
  );
});
```

This catches anything that escaped a sub-app handler.

**6.1.2** Extend `packages/contracts/src/error.ts` with the Phase 6 +
Phase 7 codes:
```
'DLQ_NOT_FOUND', 'DLQ_NOT_DEAD_LETTERED', 'STREAM_INTERRUPTED',
'EVAL_SET_NOT_FOUND', 'EVAL_RUN_FAILED', 'ADMIN_RATE_LIMITED'
```

**6.1.3** New test
`apps/api/test/error-envelope-route-snapshot.test.ts` walks every
route module and snapshots one error path per route, asserting that
the JSON body matches `ErrorEnvelope`. Implementation: a fixture map
of `{ method, path, body, expectedCode, expectedStatus }`. The
expected codes must be in the catalog enum.

**Exit criteria for 6.1**
- `pnpm --filter @textral/api test error-envelope-route-snapshot` green.
- All known thrown error sites appear in the catalog (verified by a
  text-grep test that scans `apps/api/src/**/*.ts` for
  `new TextralError(` and checks each code argument is in the enum).

---

### Step 6.2 — DLQ admin endpoints

**6.2.1** New `apps/api/src/db/jobs.ts` helper additions:
```ts
export async function listDeadLetteredJobs(
  db: D1Database,
  tenant_id: string,
  opts: { limit?: number; cursor?: string },
): Promise<JobRow[]>;

export async function clearDeadLetterAndReenqueue(
  db: D1Database,
  tenant_id: string,
  job_id: string,
): Promise<JobRow | null>;
```

The reenqueue helper does NOT actually post to the queue — it returns
the row, and the route handler does the queue post in a separate step
to keep the helper pure.

**6.2.2** New route module
`apps/api/src/routes/admin/ingestion-jobs.ts` exposing:
- `GET /v1/admin/ingestion-jobs?dead_lettered=1&limit=50&cursor=...`
  — returns `{ items: JobSummary[], next_cursor?: string }`. Tenant-
  scoped automatically via the API-key resolver.
- `POST /v1/ingestion-jobs/:id/retry` — clears `dead_lettered`,
  resets `attempt_count`, reposts to `INGEST_QUEUE`. Returns `200
  { job_id, status: 'pending' }`.

**6.2.3** Mount the admin route in `apps/api/src/index.ts`:
```ts
app.route('/v1/admin/ingestion-jobs', adminIngestionJobsRoute);
app.route('/v1/ingestion-jobs', ingestionJobsRoute); // for /:id/retry, sibling of GET
```

**6.2.4** Tests in `apps/api/test/admin-ingestion-jobs.test.ts`:
- Seed two jobs (one dead-lettered, one not). Listing returns only
  the dead-lettered.
- Retry of a dead-lettered job: row updates, queue mock receives
  message.
- Retry of a non-DLQ job: 400 `DLQ_NOT_DEAD_LETTERED`.
- Cross-tenant retry: 404 `DLQ_NOT_FOUND` (not 403 — don't leak
  existence).

**Exit criteria for 6.2**
- All four assertions pass.
- The retry path is idempotent against double-fire: retrying a
  pending job (already retried) again returns 400.

---

### Step 6.3 — Workers Analytics Engine metrics

**6.3.1** Add to `apps/api/src/types.ts`:
```ts
export interface Env {
  // ... existing ...
  AE_METRICS?: AnalyticsEngineDataset;
}
```

The `?` is critical: AE binding is optional. Tests run without it.

**6.3.2** Create `apps/api/src/observability/metrics.ts`:

```ts
export type MetricDataset =
  | 'query_executions'
  | 'ingestion_stage_outcomes'
  | 'provider_calls';

export function writeMetric(
  env: Env,
  dataset: MetricDataset,
  point: { blobs: string[]; doubles: number[]; indexes: string[] },
): void {
  if (!env.AE_METRICS) return;
  env.AE_METRICS.writeDataPoint({
    blobs: [dataset, ...point.blobs],
    doubles: point.doubles,
    indexes: point.indexes,
  });
}
```

`indexes[0]` should always be `tenant_id` per AE convention (high-
cardinality dimension goes first for sampling friendliness).

**6.3.3** Call sites:
- `routes/query.ts` after sync `finalizeAudit`: `writeMetric(env,
  'query_executions', { blobs: [namespace_id, embedding_profile,
  retrieval_strategy, degradation], doubles: [latency_ms,
  candidates_returned, citations_returned], indexes: [tenant_id] })`.
- `routes/query-stream.ts` (Phase 6.5): same, but only on `done` with
  `synthesis_status='success'`.
- `routes/internal/ingest-write.ts` after each stage commit:
  `writeMetric(env, 'ingestion_stage_outcomes', { blobs: [stage,
  outcome, error_code ?? ''], doubles: [duration_ms], indexes:
  [tenant_id] })`.
- `providers/registry.ts` already logs `provider_call`; have it also
  call `writeMetric` for `provider_calls`.

**6.3.4** All metric writes go through `c.executionCtx.waitUntil(...)`.
The helper signature stays sync; the call site decides:
```ts
c.executionCtx.waitUntil(
  Promise.resolve(writeMetric(env, 'query_executions', ...)),
);
```
(Promise.resolve wraps the sync call so waitUntil is happy.)

**6.3.5** Test `apps/api/test/observability-metrics.test.ts`:
- Inject a fake AE binding (`{ writeDataPoint: vi.fn() }`).
- Hit `/v1/query`. Assert `writeDataPoint` called once with the
  expected blobs/doubles shape.
- Without AE binding, the same path doesn't throw.

**6.3.6** Dashboard JSON: `docs/runbooks/dashboards/core.json` — a
saved dashboard config covering the four panels in the design doc.
This is documentation, not an executable artifact.

**Exit criteria for 6.3**
- Test green.
- `wrangler tail` after a query shows no metric-related errors.
- Dashboard JSON imports cleanly into Cloudflare's dashboard UI
  (manual verification documented in the runbook).

---

### Step 6.4 — AI Gateway tag coverage

**6.4.1** Audit every `resolve(env, opts)` call site in
`apps/api/src/`. Build a list of providers, ensure each is passing
`request_metadata: { tenant_id, query_event_id?, provider_key_id?,
job_id? }`.

**6.4.2** A new test `apps/api/test/ai-gateway-tag-coverage.test.ts`
compiles a list of all `resolve(` invocations and asserts each carries
at least `tenant_id`. Implementation strategy: read every `*.ts` under
`apps/api/src/`, regex-match `resolve\(env,\s*\{`, then assert the
matching arg block contains `tenant_id`. (This is a string test, not
a runtime test — it's a lint-style guardrail.)

**6.4.3** Update any sites missing the tag. Suspects: provider-key
test/validate paths. Add `tenant_id` everywhere the call has it.

**Exit criteria for 6.4**
- The new tag-coverage test passes.
- A live AIG dashboard groups by tenant_id correctly (manual; document
  in `ALERTS.md`).

---

### Step 6.5 — SSE streaming

**6.5.1** New module `apps/api/src/synthesis/streaming.ts`:

```ts
export async function streamSynthesis(args: {
  env: Env;
  prompt: ChatRequest;
  provider: ChatProvider;
  options: ProviderOptions;
}): Promise<ReadableStream<Uint8Array>> {
  // Wrap provider.streamChat() + emit SSE frames.
}
```

The provider abstraction already has a chat path; extend with
`streamChat(req, opts)` returning `AsyncIterable<TokenEvent>`. For
this phase, only Anthropic and OpenAI-compat are required to support
streaming (`Workers AI` no-key tier doesn't stream over the binding;
return a single-token-then-done stub for that case).

**6.5.2** New route `apps/api/src/routes/query-stream.ts` mounted as
the `?stream=sse` branch within `query.ts`. Detection:
```ts
const wantsStream = c.req.query('stream') === 'sse';
if (wantsStream) return queryStreamHandler(c, body);
```

The handler runs the same retrieval + context-assembly path as sync,
then opens the stream. On each token: emit `event: token\ndata:
{"text":"..."}\n\n`. On completion: emit `event: done\ndata: <full
audit object>\n\n`.

**6.5.3** SSE headers:
```ts
const SSE_HEADERS = new Headers({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  'connection': 'keep-alive',
  'x-accel-buffering': 'no',
});
```

**6.5.4** Citation validation runs once at the end. If the streamed
content cites a chunk that wasn't returned in the candidate set, the
`done` event still fires — but with the citation marked dropped in
`audit.citation_integrity='invalid_removed'` and a populated
`dropped_citations` list. The frontend must re-render with the
sanitized citation list at `done`.

**6.5.5** New error code `STREAM_INTERRUPTED`. If the upstream
provider drops mid-stream, emit a `done` event with
`degradation_level='cannot_answer'` and `synthesis_status='failed'`,
no `error` event. This keeps the consumer state machine two-state.

**6.5.6** Test `apps/api/test/query-stream.test.ts`:
- Mock the provider to emit 3 `token` events then `done`.
- POST to `/v1/query?stream=sse`, read the response body as a
  ReadableStream, parse SSE frames.
- Assert: 3 token frames, then 1 done frame with the expected audit
  object.
- Mock a mid-stream provider failure: assert the done frame has
  `synthesis_status='failed'` and `degradation_level='cannot_answer'`.

**Exit criteria for 6.5**
- Tests green.
- A `tools/stream-test.sh` curl script with `Accept: text/event-stream`
  receives interleaved tokens against deployed dev (manual).

---

### Step 6.6 — Alerts runbook

**6.6.1** Author `docs/runbooks/ALERTS.md` covering:
- The four MVP alerts from `1-DESIGN.md` §15.3.
- For each: the metric source (AE dataset + query), threshold, rate-
  limit window, recommended notification destination (Slack channel
  or PagerDuty service).
- A "manual fire" recipe: how to artificially trigger each alert in
  dev for verification.

**6.6.2** No code lands. The runbook is the deliverable.

**Exit criteria for 6.6**
- The runbook exists, has the four alerts, and the manual-fire recipe
  works for one of them (operator verification, captured in commit
  message).

---

### Step 6.7 — Cost rollup writes

**6.7.1** Create `apps/api/src/db/usage-records.ts`:

```ts
export interface UsageBucket {
  tenant_id: string;
  period_start: number;          // ms epoch, day-aligned
  queries: number;
  ingestion_jobs: number;
  input_tokens: number;
  output_tokens: number;
  embedding_tokens: number;
}

export async function incrementUsage(
  db: D1Database,
  tenant_id: string,
  period_start: number,
  delta: Partial<Omit<UsageBucket, 'tenant_id' | 'period_start'>>,
): Promise<void>;

export async function getUsageBucket(
  db: D1Database,
  tenant_id: string,
  period_start: number,
): Promise<UsageBucket | null>;
```

The `incrementUsage` helper does a single SQL upsert:

```sql
INSERT INTO usage_records (tenant_id, period_start, queries, ingestion_jobs,
                           input_tokens, output_tokens, embedding_tokens)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(tenant_id, period_start) DO UPDATE SET
  queries          = queries + excluded.queries,
  ingestion_jobs   = ingestion_jobs + excluded.ingestion_jobs,
  input_tokens     = input_tokens + excluded.input_tokens,
  output_tokens    = output_tokens + excluded.output_tokens,
  embedding_tokens = embedding_tokens + excluded.embedding_tokens
```

**6.7.2** Create `apps/api/src/observability/usage.ts`:

```ts
export function dayBucket(now: number = Date.now()): number {
  return Math.floor(now / 86_400_000) * 86_400_000;
}

export async function recordQueryUsage(
  env: Env,
  tenant_id: string,
  args: { input_tokens: number; output_tokens: number },
): Promise<void> {
  await incrementUsage(env.DB, tenant_id, dayBucket(), {
    queries: 1,
    input_tokens: args.input_tokens,
    output_tokens: args.output_tokens,
  });
}

export async function recordIngestionUsage(
  env: Env,
  tenant_id: string,
  args: { embedding_tokens: number },
): Promise<void> {
  await incrementUsage(env.DB, tenant_id, dayBucket(), {
    ingestion_jobs: 1,
    embedding_tokens: args.embedding_tokens,
  });
}
```

**6.7.3** Wire call sites:
- `routes/query.ts` sync path: after `finalizeAudit`, if
  `synthesisStatus === 'success'`, `c.executionCtx.waitUntil(
  recordQueryUsage(env, tenantId, { input_tokens: a.embeddingInputTokens
  + a.synthInputTokens, output_tokens: a.synthOutputTokens }))`.
- `routes/query-stream.ts` (6.5): same call, on `done` with success.
- `routes/internal/ingest-write.ts` chunks-batch: at the end of a
  successful batch, accumulate `embedding_tokens` (sum of input
  tokens across the batch) and call `recordIngestionUsage` ONCE per
  job — track via the job's `tenant_id` from the stage args.

**6.7.4** Test `apps/api/test/usage-records.test.ts`:
- Seed a tenant + job, run a fake query path that calls
  `recordQueryUsage` directly: assert the row exists with
  `queries=1`.
- Same call twice on the same day: assert `queries=2`,
  `input_tokens` summed, etc.
- Different day: a second row.
- Failed query path: no row written.

**Exit criteria for 6.7**
- Test green.
- The query and ingestion live e2e tests (`make test-live*`) produce
  measurable `usage_records` rows; document in
  `docs/runbooks/COST_RECONCILIATION.md` (this runbook lands in Phase
  8.6).

---

### Step 6.8 — Bulk enrichment-only admin endpoint

**6.8.1** New migration `0004_admin_rate_limits.sql`:

```sql
CREATE TABLE admin_rate_limits (
  tenant_id    TEXT NOT NULL,
  bucket_key   TEXT NOT NULL,         -- e.g. 'enrichment_runs:1715000000'
  window_start INTEGER NOT NULL,      -- minute-aligned
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, bucket_key)
);
CREATE INDEX idx_admin_rate_limits_window ON admin_rate_limits(window_start);
```

Each `bucket_key` is `<scope>:<minute_start_ms>`. Old rows GC'd by a
WHERE `window_start < now - 5min` cleanup at admission time.

**6.8.2** Create `apps/api/src/db/admin-rate-limits.ts` with:

```ts
export async function bumpAndCheck(
  db: D1Database,
  tenant_id: string,
  scope: string,
  limit_per_minute: number,
): Promise<{ allowed: boolean; current: number }>;
```

Implementation: same upsert pattern as usage-records; if
`current > limit`, return `{ allowed: false }`.

**6.8.3** Create `apps/api/src/routes/admin/enrichment-runs.ts`:

```ts
POST /v1/admin/namespaces/:slug/enrichment-runs
Body: {
  filter?: {
    profile_id?: string;
    since?: number;                   // ms
    until?: number;
    limit?: number;                   // default 100, max 1000
  };
  dry_run?: boolean;                  // default false
}
Response: { matched: number; enqueued: number; dry_run: boolean }
```

Selection query:
```sql
SELECT vi.id, vi.version_id, vi.tenant_id
  FROM version_indexes vi
  JOIN namespaces n ON n.tenant_id = vi.tenant_id
                    AND n.id = (SELECT namespace_id FROM documents
                                  WHERE id = (SELECT document_id FROM document_versions
                                                WHERE id = vi.version_id))
 WHERE n.slug = ?
   AND vi.tenant_id = ?
   AND vi.status IN ('ready', 'partial')
   AND (? IS NULL OR vi.corpus_profile = ?)
   AND (? IS NULL OR vi.created_at >= ?)
   AND (? IS NULL OR vi.created_at <= ?)
 ORDER BY vi.created_at DESC
 LIMIT ?
```

For each match, INSERT an `ingestion_jobs` row with `mode='enrichment_only'`,
status `pending`, `config_json='{}'`, then post a queue message.

**6.8.4** Auth: scope check `admin` on the API key (existing scopes
plumbing).

**6.8.5** Test `apps/api/test/admin-enrichment-runs.test.ts`:
- Seed 3 version_indexes (2 ready/partial, 1 building). Dry-run
  reports `matched: 2, enqueued: 0`.
- Real run: `enqueued: 2` and 2 new pending jobs in D1.
- Rate-limit: 11 calls in a minute → 11th returns 429
  `ADMIN_RATE_LIMITED`.
- Non-admin scope: 403 `INSUFFICIENT_SCOPE` (existing code).

**Exit criteria for 6.8**
- All four assertions pass.
- The enqueued jobs run successfully through the `enrichment_only`
  pipeline (verified by spying the queue mock + downstream stage
  attempts).

---

## Phase 7 — step-by-step

### Step 7.1 — Eval D1 migrations

**7.1.1** New migration `0005_eval.sql`:

```sql
CREATE TABLE eval_sets (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  namespace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE(tenant_id, namespace_id, name)
);
CREATE INDEX idx_eval_sets_namespace ON eval_sets(namespace_id);

CREATE TABLE eval_questions (
  id                   TEXT PRIMARY KEY,
  eval_set_id          TEXT NOT NULL REFERENCES eval_sets(id),
  question             TEXT NOT NULL,
  expected_answer      TEXT,
  must_cite_chunk_ids  TEXT,                  -- JSON array, optional
  judge_overrides      TEXT,                  -- JSON, optional
  created_at           INTEGER NOT NULL
);
CREATE INDEX idx_eval_questions_set ON eval_questions(eval_set_id);

CREATE TABLE eval_runs (
  id                  TEXT PRIMARY KEY,
  eval_set_id         TEXT NOT NULL REFERENCES eval_sets(id),
  tenant_id           TEXT NOT NULL,
  status              TEXT NOT NULL,          -- pending | running | completed | failed
  started_at          INTEGER,
  completed_at        INTEGER,
  num_questions       INTEGER NOT NULL,
  num_passed          INTEGER NOT NULL DEFAULT 0,
  num_failed          INTEGER NOT NULL DEFAULT 0,
  error_message       TEXT,
  created_at          INTEGER NOT NULL,
  inference_provider  TEXT,                   -- frozen at run time
  inference_model     TEXT,
  provider_key_id     TEXT
);
CREATE INDEX idx_eval_runs_set ON eval_runs(eval_set_id);
CREATE INDEX idx_eval_runs_tenant_status ON eval_runs(tenant_id, status);

CREATE TABLE eval_results (
  id                  TEXT PRIMARY KEY,
  eval_run_id         TEXT NOT NULL REFERENCES eval_runs(id),
  question_id         TEXT NOT NULL REFERENCES eval_questions(id),
  passed              INTEGER NOT NULL,
  scores_json         TEXT NOT NULL,          -- { judge_id: 1..5 }
  query_event_id      TEXT,                   -- the actual query that ran
  error_message       TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_eval_results_run ON eval_results(eval_run_id);
```

**7.1.2** Apply on test fixture: vitest setup re-applies migrations
before each suite (existing `setup.ts` pattern), so no extra wiring.

**Exit criteria for 7.1**
- `pnpm --filter @textral/api test` runs migrations cleanly.
- Schema supports per-judge scores via the `scores_json` field.

---

### Step 7.2 — Eval API endpoints + contracts

**7.2.1** `packages/contracts/src/eval.ts`:

```ts
export const EvalQuestion = z.object({
  id: z.string(),
  question: z.string().min(1).max(2000),
  expected_answer: z.string().optional(),
  must_cite_chunk_ids: z.array(z.string()).optional(),
  judge_overrides: z.record(z.string(), z.string()).optional(),
});

export const EvalSet = z.object({
  id: z.string(),
  namespace_id: z.string(),
  name: z.string(),
  created_at: z.number(),
});

export const EvalRun = z.object({
  id: z.string(),
  eval_set_id: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  num_questions: z.number().int(),
  num_passed: z.number().int(),
  num_failed: z.number().int(),
  started_at: z.number().nullable(),
  completed_at: z.number().nullable(),
  error_message: z.string().nullable(),
});

export const EvalResult = z.object({
  question_id: z.string(),
  passed: z.boolean(),
  scores: z.record(z.string(), z.number().int().min(1).max(5)),
  query_event_id: z.string().nullable(),
});

export const EvalRunDetail = EvalRun.extend({
  results: z.array(EvalResult),
});
```

**7.2.2** New route `apps/api/src/routes/eval.ts`:

```
POST   /v1/namespaces/:slug/eval-sets             — register a set
GET    /v1/namespaces/:slug/eval-sets             — list
GET    /v1/namespaces/:slug/eval-sets/:id         — fetch + questions
POST   /v1/namespaces/:slug/eval-sets/:id/runs    — kick off a run
GET    /v1/namespaces/:slug/eval-sets/:id/runs    — list runs
GET    /v1/namespaces/:slug/eval-sets/:id/runs/:run_id  — run detail
```

The "kick off" endpoint inserts an `eval_runs` row with status
`pending` and posts to `EVAL_QUEUE`. A new queue handler in
`src/queue/eval.ts` claims the message, sets status to `running`, and
walks each question.

**7.2.3** Queue config in `wrangler.toml`:

```toml
[[queues.producers]]
binding = "EVAL_QUEUE"
queue   = "textral-eval-{env}"

[[queues.consumers]]
queue                = "textral-eval-{env}"
max_batch_size       = 1
max_batch_timeout    = 30
```

**7.2.4** D1 helpers in `apps/api/src/db/eval.ts`:
```ts
insertEvalSet, getEvalSetById, listEvalSets, listEvalQuestions,
insertEvalQuestion, insertEvalRun, getEvalRunById, listEvalRuns,
updateEvalRunStatus, insertEvalResult, listEvalResultsForRun
```

All tenant-scoped, all in `src/db/`.

**7.2.5** Tests `apps/api/test/eval-route.test.ts` cover:
- POST a set with 3 questions → 200 with set id + question ids.
- POST a run → 202 `{ run_id, status: 'pending' }`.
- After a (mocked) eval-runner completion, GET run detail returns
  per-question results + aggregate counts.
- Cross-tenant: 404.

**Exit criteria for 7.2**
- All assertions pass.
- A run that takes 12 questions completes within 60 s of queue claim
  (mocked: 5 ms per judge call ≤ 12 × 3 × 5 ms = 180 ms).

---

### Step 7.3 — Judges + judge prompts

**7.3.1** Three Markdown prompt files in
`apps/api/src/eval/judge-prompts/`:

`relevance.md`:
```markdown
You are an evaluation judge. Score how relevant the assistant's answer
is to the user's question on a 1–5 scale:
- 5: completely on-topic, addresses every part of the question.
- 4: on-topic with minor omissions.
- 3: partially relevant; major aspects missing.
- 2: mostly off-topic.
- 1: irrelevant.

Question:
{{question}}

Answer:
{{answer}}

Respond with a single JSON object: {"score": <int 1-5>, "reasoning":
"<brief>"}.
```

`groundedness.md` and `citation_quality.md` follow the same shape with
content per `1-DESIGN.md` §16.

**7.3.2** Embed the prompts at build time. Because Workers can't read
files at runtime, use a Vite import:

```ts
import relevancePrompt from './judge-prompts/relevance.md?raw';
import groundednessPrompt from './judge-prompts/groundedness.md?raw';
import citationQualityPrompt from './judge-prompts/citation_quality.md?raw';
```

(Vite's `?raw` import suffix; supported in vitest-pool-workers.)

**7.3.3** Create `apps/api/src/eval/judges.ts`:

```ts
export type JudgeId = 'relevance' | 'groundedness' | 'citation_quality';

export async function runJudge(
  env: Env,
  judge: JudgeId,
  ctx: { question: string; answer: string; citations: Citation[] },
  inference: { provider: string; model: string; provider_key_id: string },
  override?: string,
): Promise<{ score: number; reasoning: string }>;
```

Body interpolates the template variables, calls
`provider.llm.chat({response_format: {type:'json_object'}})`, parses
the response, asserts shape via Zod, returns the score.

**7.3.4** Test `apps/api/test/eval-judges.test.ts`:
- Mock provider returning `{score: 5, reasoning: 'good'}`. Judge runs
  end-to-end.
- Mock provider returning malformed JSON: judge throws; the runner
  records `error_message` for that question (and counts as failed).

**Exit criteria for 7.3**
- Tests pass.
- A known-good answer scores ≥ 4 across all three judges (against
  fixture in 7.5).
- A known-bad answer scores ≤ 2 on at least one.

---

### Step 7.4 — `packages/eval-cli`

**7.4.1** New workspace package:

```
packages/eval-cli/
├── package.json     name: "@textral/eval-cli", bin: { textral: "./bin/textral" }
├── tsconfig.json
├── bin/
│   └── textral      #!/usr/bin/env node\nrequire('../dist/index.js')
└── src/
    └── index.ts
```

**7.4.2** `src/index.ts` parses argv:

```
textral eval run <set_id> [--namespace <slug>] [--watch]
textral eval show <run_id>
textral eval ls --namespace <slug>
```

Reads config from `~/.textralrc` JSON or `--api-key` / `--base-url`
flags. Emits machine-readable JSON to stdout, human summary to
stderr. Exit non-zero if any question failed.

**7.4.3** `--watch` polls every 5 s until the run completes; emits a
single final JSON blob.

**7.4.4** No dedicated test suite. The CLI is a thin wrapper; the API
tests cover the underlying behavior. Add a single smoke test that
invokes the CLI binary against the dev API in `make test-live`
(append a `npx --no-install textral eval ls --namespace narrative`
line).

**Exit criteria for 7.4**
- `pnpm build` builds the package.
- `pnpm --filter @textral/eval-cli typecheck` clean.
- The smoke step in `test-live.ts` exits 0 against deployed dev (or
  is gated behind `EVAL_CLI_LIVE=1` for local-only).

---

### Step 7.5 — Baseline fixture eval

**7.5.1** Build `apps/api/test/fixtures/eval/narrative-baseline.json`:

```json
{
  "name": "narrative-baseline-v1",
  "questions": [
    {
      "id": "q01",
      "question": "Who calculated the circumference of the Earth?",
      "expected_answer": "Eratosthenes."
    },
    {
      "id": "q02",
      "question": "Where did Hypatia teach?",
      "expected_answer": "At the museum/library in Alexandria."
    },
    {
      "id": "q03",
      "question": "Why was the library lost?",
      "expected_answer": "It was destroyed during the period of political hostility in Alexandria."
    }
  ]
}
```

This pairs with `narrative-tiny.md` (Phase 5 audit fix #14 fixture).

**7.5.2** A new test
`apps/api/test/eval-baseline.test.ts` (or a step appended to
`test-live-phase5.ts`):
- Register the eval set against the narrative namespace.
- Run it.
- Assert: `num_passed >= 2` (allowing one judge-noise failure for
  determinism reasons).

**7.5.3** Document in `docs/runbooks/EVAL.md` how to add a new eval
set in CI as a regression gate.

**Exit criteria for 7.5**
- The fixture eval produces non-trivial, repeatable scores.
- `num_passed/num_questions >= 0.66` over 3 runs.
- Baseline runs as part of `make test-live`.

---

## Cross-phase verification at close-out

Before declaring Phase 6 + 7 complete:

1. `pnpm -r typecheck` clean.
2. `pnpm -r lint` clean.
3. `pnpm -r test` green: api, contracts, corpus-profiles, eval-cli.
4. `make test-live` (which now includes the eval baseline step) green.
5. `make test-live-phase5` still green.
6. The audit-shape regression test still pins `RerankerAudit` and
   `QueryAudit` shapes (no inadvertent contract changes).
7. The D1 inline-SQL CI guard (`tools/check-no-inline-d1.sh`) still
   passes — every new SQL site added in Phase 6+7 must live in
   `src/db/`.
8. The error-envelope route-snapshot test (Phase 6.1) green.
9. The AI Gateway tag coverage test (Phase 6.4) green.

---

## FAQ — anticipated review questions

| Q | A |
|---|---|
| Why isn't streaming available for `workers_ai`? | The Workers AI binding doesn't expose token-by-token streaming today. We emit a single-chunk pseudo-stream for compatibility (one `token` then `done`). External providers stream natively. |
| Why store the eval run as queue-driven instead of synchronous? | Eval sets can run minutes for sets with 50+ questions × 3 judges. Tying that up in a request would force long polling on the client; queue + poll is cleaner. |
| Why is `judge_overrides` per-question instead of per-set? | Tenants commonly want one custom judge for one tricky question — e.g., they want to test the citation_quality judge on a specific paraphrasing case. Per-question is more expressive; per-set defaults are achievable by populating every question with the same override. |
| Why daily buckets in `usage_records`? | Hourly is over-fine for billing (waste of D1 row count); monthly is too coarse for tenant-facing usage dashboards. Daily is the sweet spot. |
| Why does retry not allow rerouting to a different queue? | DLQ retry is "I fixed the upstream issue, try again." Routing changes belong to dispatch-time choices, not retry. |
| Why is the bulk enrichment endpoint per-namespace? | Cross-tenant or even cross-namespace bulk operations are operator-level. The MVP customer just wants "re-enrich every doc in this namespace under the new profile." |

---

End of Phase 6 + 7 implementation guide. Phase 8 (verification +
sign-off) picks up immediately after.
