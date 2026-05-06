# V3 Phase 2 Steps 1–15 — Architectural Audit

Read-only audit prior to Steps 16–29 (the Node-side runtime).

> **Status: All findings resolved.** This audit was performed after
> Steps 1–15 shipped. Every Critical / High / Medium / Low finding
> below has been addressed in the post-Step-15 audit-remediation
> pass. Verification: `make typecheck` clean, `make lint` clean,
> `pnpm test` 323 passed | 8 skipped (was 322; +1 from B-1 test),
> `wrangler deploy --env dev` produces a live healthy worker
> (version `fbb53e11-5139-4916-a2f7-ec2951507ede`),
> `/openapi.json` user-visible surface unchanged. The audit doc is
> retained as a historical record of the architectural reasoning;
> see the design doc (`docs/v3/PHASE-2_DETAILED_DESIGN.md`) and
> implementation doc (`docs/development/v3/PHASE_2_IMPLEMENTATION.md`)
> for the canonical post-remediation shape.
>
> **Notable architectural changes from this remediation:**
> - `Db` interface gained `batch(statements: DbStatement[])` (D-1).
> - New `SparseSearch` interface; FTS5 SQL lifted out of
>   `db/chunks.ts` into `runtime/cf/fts5-sparse-search.ts` (J-1).
> - Two new structural shapes — `WorkersAiBinding` (M-3) and
>   `VectorizeIndexHandle` (G-2) — keep CF-specific types out of
>   the runtime-shared interface module.
> - `bindings.metrics`, `.vectors`, `.queue`, `.sparseSearch` are
>   now consumed end-to-end (G-1, G-2, G-3, J-1).
> - `runtimeEnv` consumed by `secrets-store.ts` and `health.ts`
>   (L-1); HealthResponse schema accepts `'self-host'`.
> - Workers AI 501 codepath has explicit test coverage (B-1).
>
> The findings below describe the state **before** remediation and
> are kept for context. Do not act on them as if they were open.

Severity legend:
- **Critical** — blocks Phase 2 ship
- **High** — should be fixed before Steps 16–29
- **Medium** — can wait but is real architectural debt
- **Low** — hygiene / nit

---

## Verdict

**Phase 2 Steps 1–15 are sound enough to proceed to Steps 16–29, but with caveats.** The shape of the runtime-shared `Bindings` interface and the per-request `buildCfBindings` plumbing are architecturally correct. The CF-runtime path goes through real adapters (D1Db, R2BlobStore, CfKvStore, CfBackgroundTasks, DigestStreamHasher) and 322 tests pass against it.

However, the migration is **half-finished in a specific way that should be acknowledged before Step 17 lands a parallel Node runtime**:

1. **Five of the eight `Bindings` adapter slots are dead code in the CF path** (`metrics`, `vectors`, `queue`, `containerInvoker`, `ai` — sometimes; see findings B-1, E-1, F-1, G-1, G-2). Routes still reach legacy CF binding fields (`env.AE_METRICS`, `env.VECTORIZE_OPENAI_LARGE`, `env.INGEST_QUEUE`, `env.INGEST_CONTAINER`). Step 17's PgDb-style work will succeed but the resulting Node runtime will only be PARTIALLY exercised by tests until those call sites are migrated. **Either complete the migration before Step 17, or be explicit that the Node runtime ships without metrics, queue producer, vector store factory, or container invoker — the slots exist but nothing reads through them.**

2. **All seven of the new lowercase config keys (`runtimeEnv`, `apiKeyPepper`, `internalHmacSecret`, `adminBootstrapToken`, `auditHashSalt`, `workerInternalUrl`, `qdrantUrl`, `qdrantApiKey`, `pineconeApiKey`) are written by `buildCfBindings` but never read by anything**. (Finding L-1.) When Step 17's Node runtime sets them, no consumer will pick them up. The legacy uppercase fields (`API_KEY_PEPPER`, `INTERNAL_HMAC_SECRET`, ...) are still authoritative everywhere. This is the same shape as #1 but for stateless config rather than adapters.

3. **The chunks-batch escape hatch (`c.env.DB`) and the `vectorStoreFor(env, ...)` direct reads of `env.VECTORIZE_OPENAI_LARGE` are tightly coupled to the CF-binding shape**. (Findings D-1, I-1.) Both will break the moment `Env` collapses to `Bindings` (the post-Phase-2 cleanup the migration anticipates). **Pinecone/Qdrant work in the Node runtime, but `vectorize` will continue to be a CF-only dispatch path** until vectorStoreFor is refactored.

4. **Workers AI 501 path is untested.** (Finding B-1.) `registry.test.ts:fakeEnv` sets `ai: {} as Ai`, bypassing the very gate Step 13 added. The CF-pool harness can't simulate `bindings.ai === undefined` because every per-request rebuild in `buildCfBindings` only sets `ai` when `env.AI` is truthy — and the test wrangler.toml has no AI binding, so the live test path's `bindings.ai` is `undefined`. **The 501 codepath would be exercised by going through worker.fetch with `provider: 'workers_ai'`, but no test does that.** Worth a 5-line test before Step 16.

5. **`Db.transaction` is a no-op in the D1 implementation, and zero callers use it today.** (Finding J-2.) Phase 2 Step 17's PgDb will implement BEGIN/COMMIT — but until a caller actually wraps work in a transaction, there is no behavioral difference. This is fine, but recognize the abstraction is currently aspirational.

None of the findings rise to the level of "rewrite Phase 2 before continuing." The high-priority fixes (B-1 test, D-1 documentation, I-1 sweep) are all small. The dead-adapter findings (E-1, F-1, G-1, G-2) are best framed as Phase 2 acceptance criteria — the migration claims to have shipped 8 adapters, but only 3 are wired through end-to-end.

**Recommendation:** before Step 16, either (a) finish the call-site migration so the dead adapters become live, or (b) explicitly document which adapters are "shape-only, not yet wired" and gate Phase 2 sign-off on completing them before sealing the migration.

---

## A. Bindings cohabitation (`Env extends Bindings`)

### A-1. Spread order is correct (no collision risk). — **Low / informational**

`apps/api/src/runtime/cf/bindings.ts:63` — `return { ...env, ...newShape } as Env;`

The spread order is right: source CF env first, new shape last. Field names cannot collide because legacy CF binding identifiers are uppercase (`DB`, `BLOBS`, `INGEST_QUEUE`, `AE_METRICS`, ...) while every Bindings field is lowercase (`db`, `blobs`, `queue`, `metrics`, ...). JS object keys are case-sensitive, so `DB` and `db` coexist on the same object without overwriting each other.

The one borderline case is `AI` (uppercase, the CF Workers AI binding) vs `ai` (lowercase, the Bindings field). Both can be present simultaneously and serve distinct purposes (Env keeps the legacy reference; Bindings exposes it through the abstraction). No collision.

**No action.** This is fine and should stay this way.

### A-2. Per-request bg vs env-level Noop bg — no current leak, but document the contract. — **Low**

`apps/api/test/setup.ts:24`, `apps/api/src/runtime/cf/bg-tasks.ts:16`

`test/setup.ts` patches the env-level Bindings via `Object.assign(env, buildCfBindings(e, null))` — the `null` ctx forces `NoopBackgroundTasks`. Per-request paths through worker.fetch rebuild bindings with a real ExecutionContext.

I audited every `bg.spawn` call site:
- `apps/api/src/auth/middleware.ts:38, 46`
- `apps/api/src/routes/query.ts:579`
- `apps/api/src/routes/query-stream.ts:412`
- `apps/api/src/routes/internal/providers.ts:137`
- `apps/api/src/routes/internal/ingest-write.ts:174`

**Every one is `c.env.bg.spawn(...)`, never bare `env.bg.spawn(...)`.** No helper takes `Env` and reaches `.bg`. Tests don't call `bg.spawn` directly. So the env-level Noop never silently drops any spawn today.

**Suggested fix:** add a one-line comment in `test/setup.ts` clarifying that the env-level patch deliberately uses `NoopBackgroundTasks` and that any test which spawns work outside `worker.fetch` would silently drop it — caller responsibility.

### A-3. `runtime: 'cf'` is hardcoded — no test escape valve. — **Medium**

`apps/api/src/runtime/cf/bindings.ts:37` always sets `runtime: 'cf'`. Two routes branch on this (`namespaces.ts:124`, `dev/ingest-ping.ts:22`).

`namespace-vector-backend.test.ts:144-150` explicitly defers Node-mode coverage because the cf-pool harness rebuilds bindings on every fetch — there's no place to inject `runtime: 'node'` that survives the rebuild.

**Suggested fix:** in Step 17/21 when the Node runtime lands, that suite naturally exercises the Node path. Alternatively, expose `buildCfBindings(env, ctx, { runtimeOverride })` for tests, but that's gold-plating; the deferred-coverage comment is honest enough. **Document the test-coverage gap in the Phase 2 sign-off doc** so it isn't lost.

---

## B. Workers AI binding — `env.AI` vs `env.ai`

### B-1. The 501 PROVIDER_UNAVAILABLE path is untested. — **High**

`apps/api/src/providers/registry.ts:71-78` — the gate `if (!env.ai)` throws 501 in self-host. This is the entire point of Step 13.

`apps/api/test/registry.test.ts:26-27` — the `fakeEnv()` test stub sets BOTH `AI: {} as Ai` (legacy) and `ai: {} as Ai` (new). So:

```ts
it('returns Workers AI binding provider — gateway omitted (no key)', () => {
  const r = resolve(fakeEnv(), { provider: 'workers_ai' });  // env.ai is set
  expect(r.llm).toBeDefined();
  ...
});
```

The test always exercises the success path. There is **no test that exercises the `env.ai === undefined → 501` branch**. I checked the entire test/ tree — no `PROVIDER_UNAVAILABLE` assertion ties to workers_ai.

The wrangler.toml `[env.test]` block does NOT bind `AI`, which means the live cf-pool path's `bindings.ai === undefined` (because `buildCfBindings` only sets `ai` when `env.AI` is truthy). So a test that goes through worker.fetch and asks for `provider: 'workers_ai'` would hit the 501. None do.

**Suggested fix:** add a single test against `worker.fetch` using a route that calls `resolve(c.env, { provider: 'workers_ai' })`. The `/v1/provider-keys/:id/test` path would do; or add a registry-test variant that builds the env without an `ai` field and asserts `resolve(env, { provider: 'workers_ai' })` throws TextralError 501.

### B-2. `env.AI` references that are intentional CF-only: 1. Missed migrations: 0. — **Low / informational**

`grep -rn "env\.AI\b\|c\.env\.AI\b" apps/api/src/`:

- `apps/api/src/runtime/cf/bindings.ts:38` — wires `env.AI → bindings.ai`. Intentional, the only legitimate read.
- `apps/api/src/providers/workers-ai-binding.ts:3` — comment string, not code.
- `apps/api/src/runtime/shared/interfaces.ts:157` — comment string, not code.

No missed migrations. Workers AI legacy reads are fully replaced with `env.ai`/`bindings.ai` everywhere except the one bridge in `buildCfBindings`.

---

## C. AI Gateway header migration

### C-1. No cf-aig literals in provider HTTP construction outside the two known files. — **Low / informational**

`grep -rn "cf-aig" apps/api/src/`:

| Hit | Verdict |
|---|---|
| `providers/ai-gateway.ts:11, 25` | Comment string. Fine. |
| `runtime/shared/interfaces.ts:130, 132` | Type literal `'cf-aig-' \| 'x-aig-'`. Fine. |
| `providers/types.ts:138, 140, 157, 197` | Comments + the same type literal. Fine. |
| `runtime/cf/bindings.ts:49` | The CF builder's `metadataHeaderPrefix: 'cf-aig-' as const`. Single source of truth. |
| `middleware/redaction.ts:35` | The header-redaction list includes `cf-aig-authorization`. Used to strip outbound auth. Intentional. |

**No provider-specific HTTP client hardcodes `cf-aig-*` in header construction.** voyage-rerank, cohere-rerank, and openai-compat all extend `ProviderHttpClient` and inherit `buildHeaders()` from `lib/http-client.ts:90-97`, which calls `gatewayMetadataHeader(opts.gateway)`. anthropic.ts overrides `buildHeaders()` (line 50-60) but uses the same `gatewayMetadataHeader(opts.gateway)` helper. workers-ai-binding.ts doesn't do HTTP at all.

### C-2. `gatewayMetadataHeader(cfg)` will produce `'undefinedmetadata'` if called with a partially-shaped cfg. — **Low**

`apps/api/src/providers/ai-gateway.ts:27-29`. `metadata_header_prefix` is required by `GatewayConfig`, but a test casting through `as unknown as GatewayConfig` could omit it and produce a header named `'undefinedmetadata'`. I checked test usages (`http-client.test.ts:117, 242`, `registry.test.ts:30, 44`, `ai-gateway.test.ts:9`) — every one provides `metadata_header_prefix`.

**No active hazard.** Worth a defensive `if (!cfg.metadata_header_prefix) throw` if the abstraction ever gets exposed to user code, but it's purely internal today.

---

## D. The chunks.ts batch escape hatch

### D-1. `c.env.DB` direct access in routes will break when Env collapses. — **High**

`apps/api/src/db/chunks.ts:64-107, 209-213` — `insertChunksBatch(db: D1Database, ...)` and `deleteChunksByIds(db: D1Database, ...)` retain the raw `D1Database` type because `Db` doesn't expose `batch(...)`.

`apps/api/src/routes/internal/ingest-write.ts:376` — `await insertChunksBatch(c.env.DB, ...)` reaches the legacy CF binding directly.
`apps/api/src/routes/internal/ingest-write.ts:479` — `await deleteChunksByIds(c.env.DB, ids)` ditto.

The TODO comment in `chunks.ts:60-63` and `chunks.ts:204-208` flags this. It's documented but not actionable yet.

**Two related concerns:**

1. **Post-Phase-2 collapse**: when `Env` collapses to `Bindings`, `c.env.DB` (uppercase) ceases to exist as a typed field. These two call sites would fail typecheck. The comment correctly identifies this but doesn't propose the resolution.

2. **Node runtime**: PgDb has no `batch(D1PreparedStatement[])` API at all — Postgres uses transactions. The `insertChunksBatch` body would need a different implementation per runtime, OR the `Db` interface needs a `bulkInsert` / `transaction-with-multiple-execs` API.

**Suggested fix (pick one before Step 17):**
- Add `batch(stmts: PreparedStatement[]): Promise<void>` (or `bulkInsert(table, rows)`) to the `Db` interface; CF impl wraps `d1.batch(...)`, Node impl wraps a transaction. Migrate the two call sites.
- OR explicitly mark these two endpoints as CF-only and add a runtime guard (`if (c.env.runtime === 'node') return notImplemented()`).
- The current "raw D1Database escape hatch" approach will not survive Phase 2's stated goal.

The README and types comments in `chunks.ts` hint at a follow-up but don't make this a blocking item — it should be.

---

## E. ContainerInvoker abstraction vs the dev/ingest-ping bypass

### E-1. `c.env.containerInvoker` is built but the only production caller is `runIngestMessage`. — **Medium**

`apps/api/src/runtime/cf/bindings.ts:33` builds `containerInvoker: new DoContainerInvoker(env.INGEST_CONTAINER)`. Consumers:

- `apps/api/src/ingestion/ingest-message.ts:31` — `bindings.containerInvoker.invoke(...)` for the queue body. Live.
- `apps/api/src/routes/dev/ingest-ping.ts:23-24` — bypasses, reaches `c.env.INGEST_CONTAINER` directly. Documented intentional.

**The bypass IS reasonable.** The diagnostic ping route hits `/healthz` (different path than `/jobs/run`) and is gated by both `ENABLE_DEBUG_ROUTES === 'true'` AND `runtime === 'cf'`. Adding a generic `fetch(path, init)` method to `ContainerInvoker` to absorb this single-purpose diagnostic bypass would be over-design.

**No action required.** The runtime-gate (`if (c.env.runtime !== 'cf') return c.notFound()`) cleanly handles the Node side — that's the right pattern.

---

## F. NoopBackgroundTasks in queue path

### F-1. NoopBackgroundTasks risks future bg.spawn from queue body silently disappearing. — **Medium**

`apps/api/src/runtime/cf/bindings.ts:35` — `bg: ctx ? new CfBackgroundTasks(ctx) : new NoopBackgroundTasks()`.
`apps/api/src/index.ts:27` — queue handler passes `null` for ctx.
`apps/api/src/runtime/cf/bg-tasks.ts:16-22` — Noop catches rejection but silently completes.

The current `runIngestMessage` body (`apps/api/src/ingestion/ingest-message.ts`) does NOT call `bindings.bg.spawn`. So today the Noop is correct.

**Risk: future regression.** Someone adds a `bg.spawn` to the queue dispatch body for usage tracking or telemetry, expecting `waitUntil` semantics, gets silent-success-and-drop on the Noop. The comment in `bg-tasks.ts:13-16` acknowledges this but is brief.

**Suggested fix:** strengthen the comment to "Calls drop on the floor — DO NOT add bg.spawn calls to the queue path; they will be lost when the Worker isolate is reused. If you need post-message work, call `await` on it directly within `runIngestMessage` (Workers semantics: queue handlers run to completion before isolate reuse)."

Also worth adding to `runIngestMessage`'s docstring since that's where someone is likely to add the offending call.

---

## G. Unused exports / dead code from the migration

### G-1. `MetricsSink` adapter is dead code. — **High** (architectural)

`apps/api/src/runtime/cf/bindings.ts:34` builds `metrics: env.AE_METRICS ? new AeMetricsSink(env.AE_METRICS) : new NoopMetricsSink()`.

`apps/api/src/observability/metrics.ts:31-42` — `writeMetric(env, dataset, point)` reads `env.AE_METRICS` directly, never `env.metrics`.

Every `writeMetric` call site (`routes/query.ts:593`, `routes/query-stream.ts:421`, `routes/internal/ingest-write.ts:295`, plus tests) goes through `env.AE_METRICS`.

**`env.metrics` is built every request and never read.** Step 17's Node runtime will set up a structured-stdout sink that nothing routes through.

**Suggested fix:** before Step 16, migrate `writeMetric` to read `env.metrics` (the abstracted sink). The sink interface already matches AE's `writeDataPoint` shape (indexes/doubles/blobs). The dataset-name-as-blob[0] convention can stay in `writeMetric`.

### G-2. `VectorStoreFactory` is dead code. — **High** (architectural)

`apps/api/src/runtime/cf/bindings.ts:23-25, 32` builds `vectors: { forBinding: (b) => vectorStoreFor(env, b) }`.

But every caller still uses `vectorStoreFor(env, ...)` directly:
- `apps/api/src/routes/namespaces.ts:159`
- `apps/api/src/routes/internal/ingest-write.ts:432, 473`
- `apps/api/src/retrieval/vectorize-query.ts:22`

And `vectorStoreFor(env, binding)` itself reads `env.VECTORIZE_OPENAI_LARGE` (the legacy CF binding) at line 68 of `retrieval/vector-store.ts`. So even if callers DID go through `bindings.vectors.forBinding(...)`, they'd loop right back to the CF-only `env.VECTORIZE_OPENAI_LARGE` access.

**`env.vectors` is built every request and never read.** And `vectorStoreFor` is not actually runtime-agnostic for the `vectorize` backend.

**Suggested fix:** either (a) inject the Vectorize binding into `VectorizeV2Adapter` at Bindings-build time and have call sites read `c.env.vectors.forBinding(...)`, or (b) add a `vectorizeIndex?: VectorBinding` field to Bindings and have `vectorStoreFor` read it. Option (a) is cleaner; aligns with the rest of the adapter pattern.

### G-3. `bindings.queue` is dead code. — **High** (architectural)

`apps/api/src/runtime/cf/bindings.ts:31` builds `queue: new CfQueueProducer(env.INGEST_QUEUE)`.

`grep -rn "env\.queue\b\|c\.env\.queue\b" apps/api/src/` returns nothing.

All three queue producers reach `env.INGEST_QUEUE.send(...)` directly:
- `apps/api/src/ingestion/dispatch.ts:168`
- `apps/api/src/routes/ingestion-jobs.ts:116`
- `apps/api/src/routes/admin/enrichment-runs.ts:115`

**Suggested fix:** migrate the three call sites to `c.env.queue.send(...)` before Step 17. One-line changes. Otherwise the Node-side BRPOP/Redis queue producer will exist as a dead adapter.

### G-4. `env.containerInvoker` is wired through the queue path but bypassed elsewhere. — **Low / informational**

(See E-1.) Already covered. Not a problem.

### G-5. `sha256OfStream` re-import check. — **Low / informational**

The legacy `lib/r2-presign.ts:sha256OfStream` was removed. `grep -rn "sha256OfStream" apps/api/`:
- `apps/api/src/routes/documents.ts:333` — uses `c.env.hash.sha256OfStream(...)`. Migrated.
- `apps/api/src/runtime/shared/interfaces.ts:114` and `apps/api/src/runtime/cf/digest-stream-hasher.ts:11` — interface + impl.

No stale imports anywhere. Clean.

### G-6. `ingestion/queue-handler.ts` import check. — **Low / informational**

`grep -rn "queue-handler" apps/api/`:
- `apps/api/src/runtime/cf/bg-tasks.ts:13` — comment string referring to the deleted file.
- `apps/api/src/runtime/cf/do-container-invoker.ts:3` — comment string referring to the deleted file.

No stale imports, only stale comment references. **Suggested fix:** update the two comments to say "queue-consumer.ts" or just "the queue handler" — the comments are misleading otherwise.

### G-7. `types.ts` legacy CF fields will need explicit removal step. — **Medium**

`apps/api/src/types.ts:32-71` — the legacy CF binding fields (`DB`, `BLOBS`, `INGEST_QUEUE`, `VECTORIZE_OPENAI_LARGE`, `CACHE`, `API_KEY_PEPPER`, `INGEST_CONTAINER`, `AI`, `ADMIN_BOOTSTRAP_TOKEN`, `INTERNAL_HMAC_SECRET`, `AUDIT_HASH_SALT`, `WORKER_INTERNAL_URL`, `AE_METRICS`, plus the env vars `ENV`, `ENABLE_DEBUG_ROUTES`, `ALLOWED_ORIGINS`, `CF_ACCOUNT_ID`, `AI_GATEWAY_ID`, `AI_GATEWAY_BYPASS`, `QDRANT_URL`, `QDRANT_API_KEY`, `PINECONE_API_KEY`).

The migration design says these will be removed when Env collapses to Bindings. The header comment at lines 6-14 explains this, but there's no explicit checklist of every consumer that needs to migrate first.

**Suggested fix:** add a `// PHASE_2_CLEANUP_TODO:` marker on each legacy field that notes which consumer still reads it. E.g.,

```ts
// PHASE_2_CLEANUP_TODO: read by routes/internal/ingest-write.ts:376 (insertChunksBatch);
//   migrate when Db.batch() is added.
DB: D1Database;
```

This makes the post-Phase-2 cleanup mechanical and makes "are we ready to collapse Env?" answerable by `grep`.

---

## H. Test infrastructure

### H-1. `Object.assign(env, buildCfBindings(e, null))` patches env once with NoopBg — non-issue today, fragile tomorrow. — **Low**

`apps/api/test/setup.ts:24-25`. Discussed in A-2 and F-1.

Today every `bg.spawn` is `c.env.bg.spawn(...)` reached only through worker.fetch (which rebuilds bindings with a real ctx). So the env-level Noop is never read.

**Risk:** if a future test calls a helper directly with `env`-shape and that helper does `env.bg.spawn(...)`, the spawn drops silently. Adding a test for that would require changing setup.ts to never patch bg, but that breaks the convenience of `import { env }` from cloudflare:test for tests that DO want adapters available outside fetch.

**No action.** Document the limitation in setup.ts (one-line comment).

### H-2. `bootstrap.test.ts:14` mutates `env.ADMIN_BOOTSTRAP_TOKEN` without restoring. — **Low**

Vitest pool-workers isolates tests per file, and `env` is per-worker-isolate; mutations don't leak across test files. The mutation IS picked up by per-request `buildCfBindings` rebuild because the same `env` object is what fetch sees.

The `cloudflare:test` env IS shared within a file. `bootstrap.test.ts` doesn't reset the token between tests, but since every test in that file expects the token to be set, it works out. **Not a bug.** Worth noting that the Phase 2 cleanup should migrate `c.env.ADMIN_BOOTSTRAP_TOKEN` (read in `routes/admin/bootstrap.ts:47`) to `c.env.adminBootstrapToken` simultaneously.

### H-3. `namespace-vector-backend.test.ts:56` resets `QDRANT_URL` in beforeEach — fine. — **Low / informational**

The test uses beforeEach (not afterEach), so test ordering within the file is robust. Across files there's no leak (per-worker isolation).

### H-4. `observability-metrics.test.ts:18` constructs a partial env — fine. — **Low / informational**

It's a unit test on `writeMetric(env, ...)` with a hand-rolled fake env. Once G-1 lands and `writeMetric` reads `env.metrics` instead of `env.AE_METRICS`, this test will need to construct `metrics: { write: ... }` instead. Trivial change, but flag it as part of G-1's migration.

### H-5. `registry.test.ts` cheats around the workers_ai 501 path. — **High**

Already covered as B-1. The fakeEnv sets both `AI` and `ai`, so the gate `if (!env.ai)` is never tripped.

---

## I. Forgotten call sites / hidden assumptions

### I-1. `env.VECTORIZE_OPENAI_LARGE` — only in vectorStoreFor, but blocks Phase 2 collapse. — **High**

`grep -rn "VECTORIZE_OPENAI_LARGE\|env\.VECTORIZE" apps/api/src/`:

- `apps/api/src/retrieval/vector-store.ts:68` — `return new VectorizeV2Adapter(env.VECTORIZE_OPENAI_LARGE);`
- `apps/api/src/types.ts:38` — type declaration.

Single source. Discussed in G-2. **Has to be migrated before Env collapse OR the vectorize adapter has to gain a way to be constructed without a CF-typed binding (e.g., accept the binding through Bindings).**

### I-2. `env.DB` — three legitimate uses. — **Medium**

`grep -rn "env\.DB\b\|c\.env\.DB\b" apps/api/src/`:

| Hit | Verdict |
|---|---|
| `runtime/cf/bindings.ts:28` | Source: `db: new D1Db(env.DB)`. Bridge. |
| `routes/internal/ingest-write.ts:376, 479` | Chunks-batch escape hatch (D-1). Will break on collapse. |
| `db/chunks.ts:63, 208` | Doc comments. |
| `db/README.md:9`, `index.ts:12`, `runtime/cf/bindings.ts:3, 60-61`, `runtime/shared/interfaces.ts:8`, `types.ts:4` | Comment strings only. |

All other db calls go through `c.env.db` / the `Db` interface. Only the chunks-batch escape needs surgery (D-1).

### I-3. `env.BLOBS` — single source-of-truth read. — **Low / informational**

`grep -rn "env\.BLOBS\|c\.env\.BLOBS" apps/api/src/`:

- `runtime/cf/bindings.ts:29` — bridge.
- All other hits are comments.

**Fully migrated.** Every write/read goes through `c.env.blobs`.

### I-4. `env.CACHE` — single SecretsStore read remains. — **Medium**

`apps/api/src/lib/secrets-store.ts:63` — `const cacheBinding = env.CACHE;` is used as a "is the KV binding present" probe before falling back to the in-memory test map. The actual operations use `env.kv` (line 87).

**Suggested fix:** the probe could read `env.kv` instead — `if (!env.kv || typeof env.kv.put !== 'function') {...}`. Then secrets-store has no CF-binding-shape dependency at all.

### I-5. `env.INGEST_QUEUE` — three live producer call sites. — **High**

Discussed in G-3. Three live call sites (`ingestion/dispatch.ts:168`, `routes/ingestion-jobs.ts:116`, `routes/admin/enrichment-runs.ts:115`) reach `env.INGEST_QUEUE.send(...)` directly, bypassing the `queue: QueueProducer` adapter.

### I-6. `env.INGEST_CONTAINER` — two reads. — **Low / informational**

`grep -rn "env\.INGEST_CONTAINER\|c\.env\.INGEST_CONTAINER" apps/api/src/`:

- `runtime/cf/bindings.ts:33` — bridge.
- `routes/dev/ingest-ping.ts:23-24` — diagnostic bypass (E-1, intentional).

Live production path goes through `bindings.containerInvoker.invoke(...)`. Clean.

### I-7. `env.AE_METRICS` — three reads, all going around the new sink. — **High**

Discussed in G-1. `observability/metrics.ts:32, 37` reads it directly. The MetricsSink abstraction is dead until those call sites migrate.

### I-8. Provider HTTP clients build URLs only through `gatewayBaseUrl()`. — **Low / informational**

`grep -rn "gateway\.ai\.cloudflare\.com\|gatewayBaseUrl" apps/api/src/`:

- `runtime/cf/bindings.ts:48` — sole literal URL construction.
- `providers/types.ts:134` — comment.
- `providers/ai-gateway.ts:21` — `gatewayBaseUrl()` definition.
- `providers/lib/http-client.ts:85` — `if (opts.gateway) return { url: gatewayBaseUrl(opts.gateway), ... }`.

Voyage, Cohere, OpenAICompat, and Anthropic all extend `ProviderHttpClient` and rely on `resolveBaseUrl()` for gateway routing. Anthropic streaming (`anthropic.ts:91`) also goes through `resolveBaseUrl`. **No provider hardcodes a gateway URL.** Clean.

### I-9. `providers/types.ts` — no other AIG fields missed migration. — **Low / informational**

Reviewed `providers/types.ts:128-148`. The `GatewayConfig` shape is consistent with `AiGatewayConfig` in `runtime/shared/interfaces.ts`. Field names differ (`base_url` vs `baseUrl`, `metadata_header_prefix` vs `metadataHeaderPrefix`, `provider` vs `providerSegment`); the resolver in `providers/registry.ts:96-100` translates correctly.

**One nit:** the snake_case-vs-camelCase split is intentional (the `providers/` layer uses snake to match wire-format, the `runtime/` layer uses camel for the JS-conventional shape) but could surprise a reader. Worth one comment in `registry.ts:computeGateway` explaining that the field renames are intentional.

---

## J. Interface design assumptions

### J-1. SQL is mostly portable; FTS5 is the one hard SQLite dependency. — **Critical** (for Node runtime; not for current CF deploy)

`grep -rni "IFNULL|JSON_EXTRACT|PRAGMA|AUTOINCREMENT|INSERT OR|ON CONFLICT"` and related:

- **`INSERT OR REPLACE INTO chunks` at `db/chunks.ts:72`** — SQLite-specific. Postgres equivalent: `INSERT ... ON CONFLICT (pk) DO UPDATE SET ...`. Will break on PgDb.
- **`bm25(chunks_fts)` and `MATCH` at `db/chunks.ts:145, 148, 153`** — SQLite FTS5. **Postgres has no equivalent.** Either Step 17 needs to translate this to Postgres `tsvector` / `to_tsquery`, OR sparse search is a CF-only feature, OR a separate FTS service is plumbed in.
- `db/usage-records.ts:47-52` and `db/stage-attempts.ts:32-38` use `ON CONFLICT(col) DO UPDATE SET col = excluded.col`. This is supported by both SQLite and Postgres. Fine.
- `migrations/*` files include `PRAGMA foreign_keys = ON;` — SQLite-specific but only in migrations, which are runtime-specific. Fine.
- No `IFNULL`, `JSON_EXTRACT`, `AUTOINCREMENT`, `RANDOM()`, `DATETIME()` in SQL.
- All placeholders are `?`. No mixed `$1`/`?` style. Translation `?` → `$1, $2, ...` is mechanical; PgDb adapter can handle it positionally.

**Suggested fix:** before Step 17 starts, decide:
1. How sparse search (FTS5 / chunks_fts) maps onto Postgres. This is the single hardest portability question. Options: `tsvector` + GIN index (loses BM25 scoring; PG ranks differently), or `pg_trgm`, or a separate Postgres-side `bm25` extension (e.g., ParadeDB), or Elasticsearch alongside.
2. How `INSERT OR REPLACE` becomes `INSERT ... ON CONFLICT` in PgDb. Either the `Db` interface gains an `upsert` primitive, or callers rewrite their SQL.

The current `Db` shape (`one`/`all`/`exec`) does not signal that callers are writing dialect-specific SQL. **Step 17 will hit FTS5 on day one.**

### J-2. `Db.transaction` no-op is fine because nothing uses it. — **Low / informational**

`db.transaction` is implemented as `return fn(this)` in D1Db (no real transaction). Zero callers across the codebase. PgDb in Step 17 can implement real BEGIN/COMMIT, and the no-op is forward-compatible. **No action.**

### J-3. `D1Param` parameter type is over-restrictive. — **Low**

`apps/api/src/runtime/cf/d1-db.ts:10` — `type D1Param = string | number | null;`. The cast `params as D1Param[]` would mask undefined or boolean params. D1 actually accepts `null | string | number | boolean | ArrayBuffer`, with undefined coerced to null.

In practice every caller passes string/number/null (I checked all `db.exec`/`db.one`/`db.all` calls). No active hazard. But if a caller passes `false` (e.g., `revoked = false`), it would be cast through D1's auto-conversion silently. Worth widening the type to match D1's actual contract, OR raising a runtime check.

**Suggested fix:** widen `D1Param` to `string | number | boolean | null | ArrayBuffer`. Cosmetic; no behavioral change.

---

## K. Hono Bindings type generic

### K-1. 27 routes type their sub-app as `<{ Bindings: Env }>`. — **Low** (future concern)

`grep -rln "Bindings: Env" apps/api/src/` returns 27 files. After Env collapses to Bindings (post-Phase-2), every one will need a find-replace. Since `Env extends Bindings`, no type errors today.

**Suggested fix:** when the collapse lands, a single find-replace from `Bindings: Env` → `Bindings: Bindings` does it. No deeper type dependencies because routes only read fields, never construct Env values. Safe to defer.

---

## L. The `runtimeEnv` rename

### L-1. `runtimeEnv` is set but never read. — **Medium**

`grep -rn "runtimeEnv"` returns:
- `runtime/shared/interfaces.ts:161, 164` — declaration.
- `runtime/cf/bindings.ts:39` — assignment from `env.ENV`.

**Zero read sites.** `env.ENV` is read at `lib/secrets-store.ts:69` and `routes/health.ts:22`.

**Concern:** the type declares `runtimeEnv: 'dev' | 'prod' | 'self-host'` (3 values) but assigns from `env.ENV: 'dev' | 'prod'` (2 values). When the Node runtime sets `runtimeEnv: 'self-host'`, the `Env.ENV` field will not exist there. Currently both `secrets-store.ts:69` and `health.ts:22` would break.

**Suggested fix:** before Step 17:
1. Migrate `secrets-store.ts:69` (`env.ENV === 'prod'`) and `health.ts:22` (`env: c.env.ENV`) to `env.runtimeEnv === 'prod'` and `env: c.env.runtimeEnv`.
2. Update `HealthResponse` Zod schema to allow `'self-host'` if it doesn't already.

Otherwise `runtimeEnv` is a phantom field. Either delete it (and have callers continue to read `env.ENV`) or wire it up.

---

## M. Other architectural smells

### M-1. `apps/api/src/runtime/cf/digest-stream-hasher.ts:13` — `eslint-disable any cast`. — **Low**

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hashStream = new (globalThis as any).crypto.DigestStream('SHA-256');
```

Workers global types lack `DigestStream`. The cast is necessary today. **No action**, but worth a comment ("Workers-runtime-only API not in lib.dom or lib.webworker") for the next reader.

### M-2. `apps/api/src/lib/secrets-store.ts:63-87` — dual-shape access (`env.CACHE` for probe, `env.kv` for ops). — **Medium**

Discussed in I-4. The presence-probe uses the legacy field; the ops use the new field. After collapse, the probe breaks. Single-line fix: `if (!env.kv) {...}`.

### M-3. `Bindings.ai?: Ai` carries a CF-specific type (`Ai`) into the runtime-shared interface. — **Medium**

`apps/api/src/runtime/shared/interfaces.ts:159` — `ai?: Ai;`. The `Ai` type comes from `@cloudflare/workers-types`. The Node runtime cannot construct or expose this type without pulling Workers types into Node code.

**Suggested fix:** define a runtime-shared `WorkersAiBinding` interface in `runtime/shared/interfaces.ts` that mirrors `Ai`'s `run(model, args)` signature. The CF impl uses the actual `env.AI` (which satisfies the shape structurally). The Node runtime never sets it. `WorkersAIBindingProvider`'s constructor takes the abstract shape.

This doesn't block today (Bindings imports Ai from the global Workers types); it blocks Step 17 when Node code tries to compile against `runtime/shared/interfaces.ts` without `@cloudflare/workers-types` in tsconfig.

### M-4. `Env extends Bindings` will produce confusing autocomplete during the migration. — **Low**

In a route handler `c.env.` autocompletes to BOTH the legacy uppercase fields AND the new lowercase fields (and the new Bindings-only camelCase secret keys that nothing reads). 27 routes. New contributors will reach for whichever field appears first in their IDE.

**No action.** This is the cost of the migration period; it goes away on collapse.

### M-5. Provider streaming methods bypass the centralized retry loop — intentional, but worth noting. — **Low**

`anthropic.ts:90-168` and `openai-compat.ts:111-183` implement `stream()` independently of `withRetries`. Comment in `openai-compat.ts:108-110` explains streaming can't retry mid-token. Fair design call.

**No action.** Mentioning here so the audit is complete.

### M-6. `D1Db.exec` returns `{ rowsAffected: res.meta.changes ?? 0 }`. — **Low / informational**

D1's `meta.changes` is the count of rows changed by the most recent statement. For multi-statement / batch, this would only reflect the last. Since `exec` runs a single statement and `chunks.ts` uses raw `db.batch()` for multi-statement inserts, this is fine.

The PgDb implementation in Step 17 will need to return a comparable count from `pg.Result.rowCount`. Trivial mapping. **No action.**

### M-7. `apps/api/src/routes/dev/workers-ai-ping.ts` reaches `c.env.ai` and 404s on absence. Good migration — but doesn't 501. — **Low**

`workers-ai-ping.ts:16` — `if (!c.env.ai) return c.notFound();`

Diagnostic, debug-routes-gated. 404 vs 501 is fine for a probe. Different policy from `registry.ts:71` (which 501s on absence) — both make sense given the call sites' purposes. **Worth a tiny comment** clarifying the 404-vs-501 split is intentional.

### M-8. Telemetry emission is centralized in `http-client.ts:268-298` for HTTP providers but bypassed by streaming + workers-ai-binding. — **Low / informational**

`emitProviderTelemetry` is called in `finalize()`. Streaming paths and the binding provider don't emit telemetry. Pre-existing behavior, not a Phase-2 regression. Worth tracking as a future consistency point but out of scope here.

---

## Summary table

| ID | Severity | File:Line | Synopsis |
|---|---|---|---|
| A-1 | Low | `runtime/cf/bindings.ts:63` | Spread order is correct; case-sensitive keys mean no collision. No-op finding. |
| A-2 | Low | `test/setup.ts:24` | Add comment that env-level NoopBg is by design. |
| A-3 | Medium | `runtime/cf/bindings.ts:37` | `runtime: 'cf'` hardcoded; Node-mode test coverage deferred. |
| **B-1** | **High** | `test/registry.test.ts:26-27` | The 501 PROVIDER_UNAVAILABLE path for workers_ai is untested. Add a 5-line test. |
| B-2 | Low | — | No missed `env.AI` migrations. |
| C-1 | Low | — | No cf-aig literals outside types/comments and the single bridge in bindings.ts. |
| C-2 | Low | `providers/ai-gateway.ts:27` | `gatewayMetadataHeader` defensive check could be added; no active hazard. |
| **D-1** | **High** | `db/chunks.ts:64,209`, `routes/internal/ingest-write.ts:376,479` | Chunks-batch escape uses `c.env.DB`. Will break on Env collapse and on Node runtime. Must add `Db.batch` (or runtime-gate). |
| E-1 | Medium | `routes/dev/ingest-ping.ts:23-24` | Bypass is reasonable; runtime-gated. No action. |
| F-1 | Medium | `runtime/cf/bg-tasks.ts:13-22` | Strengthen comment so a future contributor doesn't add a queue-path bg.spawn. |
| **G-1** | **High** | `observability/metrics.ts:32,37` + `runtime/cf/bindings.ts:34` | `bindings.metrics` is dead; `writeMetric` reads `env.AE_METRICS` directly. |
| **G-2** | **High** | `runtime/cf/bindings.ts:32`, `retrieval/vector-store.ts:68` + 4 callers | `bindings.vectors` is dead; `vectorStoreFor` reads `env.VECTORIZE_OPENAI_LARGE` directly. |
| **G-3** | **High** | `runtime/cf/bindings.ts:31` + 3 callers | `bindings.queue` is dead; producers reach `env.INGEST_QUEUE.send` directly. |
| G-4 | Low | — | E-1 dup. |
| G-5 | Low | — | `sha256OfStream` migration clean; no stale imports. |
| G-6 | Low | `runtime/cf/bg-tasks.ts:13`, `do-container-invoker.ts:3` | Comments still reference deleted `queue-handler.ts`. Update strings. |
| G-7 | Medium | `types.ts:32-71` | Add `PHASE_2_CLEANUP_TODO:` markers per legacy field with consumer pointers. |
| H-1 | Low | `test/setup.ts:24` | A-2 dup. |
| H-2 | Low | `test/bootstrap.test.ts:14` | Token mutation is fine; will need migration alongside `c.env.ADMIN_BOOTSTRAP_TOKEN` reads. |
| H-3 | Low | `test/namespace-vector-backend.test.ts:56` | beforeEach reset; no leak. |
| H-4 | Low | `test/observability-metrics.test.ts:18` | Will need shape update once G-1 lands. |
| H-5 | High | `test/registry.test.ts:26-27` | B-1 dup. |
| **I-1** | **High** | `retrieval/vector-store.ts:68` | G-2 dup; flagged as call-site sweep. |
| I-2 | Medium | `routes/internal/ingest-write.ts:376,479` | D-1 dup. |
| I-3 | Low | — | `env.BLOBS` migration clean. |
| I-4 | Medium | `lib/secrets-store.ts:63` | KV presence probe still uses `env.CACHE`. One-line fix. |
| **I-5** | **High** | `ingestion/dispatch.ts:168`, `routes/ingestion-jobs.ts:116`, `routes/admin/enrichment-runs.ts:115` | G-3 dup; three live `env.INGEST_QUEUE.send` sites. |
| I-6 | Low | — | Container reads clean except the documented dev-ping bypass. |
| **I-7** | **High** | `observability/metrics.ts:32,37` | G-1 dup. |
| I-8 | Low | — | All providers route through `gatewayBaseUrl`. |
| I-9 | Low | `providers/types.ts:128-148` | snake/camel split is intentional; comment in registry.ts could clarify. |
| **J-1** | **Critical (for Step 17)** | `db/chunks.ts:72` (`INSERT OR REPLACE`), `db/chunks.ts:145-153` (FTS5 `bm25`/`MATCH`) | Pre-Step-17 design decision needed: how do these become Postgres-native? |
| J-2 | Low | `runtime/cf/d1-db.ts:42-47` | Db.transaction no-op fine; zero callers. |
| J-3 | Low | `runtime/cf/d1-db.ts:10` | `D1Param` over-restrictive; widen to match D1's actual contract. |
| K-1 | Low | 27 route files | `Bindings: Env` → `Bindings: Bindings` is one find-replace post-collapse. |
| **L-1** | **Medium** | `lib/secrets-store.ts:69`, `routes/health.ts:22` | `runtimeEnv` set but never read; current readers use `env.ENV` which won't have `'self-host'`. |
| M-1 | Low | `runtime/cf/digest-stream-hasher.ts:13` | `any` cast is necessary for `crypto.DigestStream`. Add comment. |
| M-2 | Medium | `lib/secrets-store.ts:63-87` | I-4 dup. |
| M-3 | Medium | `runtime/shared/interfaces.ts:159` | `Bindings.ai: Ai` pulls Workers types into the runtime-shared interface. Define a structural shape instead. |
| M-4 | Low | — | Autocomplete pollution during migration; no fix needed. |
| M-5 | Low | `anthropic.ts:90`, `openai-compat.ts:111` | Streaming bypasses retry loop by design. |
| M-6 | Low | `runtime/cf/d1-db.ts:39` | `meta.changes` only counts last statement; not used in problematic ways. |
| M-7 | Low | `routes/dev/workers-ai-ping.ts:16` | 404 vs 501 split intentional; one-line clarifying comment. |
| M-8 | Low | — | Streaming + workers-ai-binding skip telemetry; pre-existing. |

---

## Recommended action sequence (before Step 16)

**Must-do (blocks the spirit of Phase 2):**
1. **G-1**: migrate `writeMetric` to read `env.metrics`. Three call sites + the test. ~30 minutes.
2. **G-2**: rework `vectorStoreFor` to receive the Vectorize binding through Bindings, OR injec `c.env.vectors.forBinding(b)` at the four call sites. ~1–2 hours.
3. **G-3**: migrate three `env.INGEST_QUEUE.send` sites to `env.queue.send`. ~15 minutes.
4. **B-1**: add a single test that the workers_ai 501 path triggers when `bindings.ai` is undefined. ~10 minutes.
5. **I-4 / M-2**: migrate the secrets-store KV presence probe from `env.CACHE` to `env.kv`. ~5 minutes.
6. **L-1**: migrate `secrets-store.ts:69` and `health.ts:22` to `env.runtimeEnv`. Update HealthResponse schema. ~20 minutes.

**Should-do (clear the path for Step 17):**
7. **J-1**: design decision — how does FTS5 sparse search map to Postgres? Block Step 17 on this.
8. **D-1**: extend `Db` with `batch` (or `bulkInsert`) and migrate `chunks.ts`. ~1–2 hours.
9. **G-7**: add `PHASE_2_CLEANUP_TODO:` markers to `types.ts` legacy fields. ~15 minutes.
10. **M-3**: define a runtime-shared `WorkersAiBinding` shape so Node code can compile without Workers types. ~30 minutes.

**Nice-to-have (cleanup):**
11. **G-6**: update two stale "queue-handler.ts" comment references.
12. **F-1**: strengthen NoopBackgroundTasks doc.
13. **A-2 / H-1**: comment in `test/setup.ts`.
14. **J-3**: widen `D1Param`.
15. **M-1, M-7**: minor comments.

The "must-do" set above is roughly 3 hours of work. Doing it before Step 17 means the Node runtime PR will exercise the same adapter slots the CF runtime does, instead of shipping seven dead adapters that nobody noticed.

After "must-do" lands, Phase 2 Steps 1–15 are genuinely complete — every adapter is consumed end-to-end on the CF side, and Step 17 has a clear interface contract to satisfy.
