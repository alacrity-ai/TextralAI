# V3 Phase 2 — Detailed Design

> **Versioning context.** V1 = the original book-centric Textral
> (`/home/leif/textral`, fully self-hosted via docker-compose). V2
> = the current Cloudflare-locked SaaS MVP (`TEXTRAL_REFACTOR_WIP/`).
> V3 = the self-hostable evolution that ships **alongside** V2 in
> the same repo. V3 Phase 1 (separate doc) made the vector store
> pluggable and added a dev docker-compose. **V3 Phase 2 (this
> document)** completes the self-host story: replaces every
> remaining Cloudflare binding, ships a full `docker-compose.yml`
> that runs Postgres + Redis + Qdrant + MinIO + api + ingest with
> zero CF dependency, and keeps the V2 Cloudflare deploy working
> from the same source tree.

---

## 1. Problem framing

After Phase 1 the only deployment shape that runs end-to-end is
"Cloudflare account + V2's bindings + a local Qdrant for dev." Any
deploy off Cloudflare still hits nine substrate dependencies that
don't exist outside CF:

1. Workers V8 isolate runtime.
2. D1 (SQLite-flavored, binding-injected).
3. R2 (binding-injected; S3-compatible-ish API).
4. KV (binding-injected; eventually-consistent k/v).
5. Cloudflare Queues (binding-injected; Worker-as-consumer).
6. Container Durable Object (DO-pinned ingest container).
7. AI Gateway URL routing.
8. Workers AI binding (the no-key inference tier).
9. Analytics Engine (telemetry sink).

Phase 2 replaces every one of these with a portable substrate, on
the v1 model:

| V2 (Cloudflare) | V3 self-host |
|-----------------|--------------|
| Workers V8 isolate | Node 24 + Hono |
| D1 | Postgres 16 |
| R2 | MinIO (S3-compatible) |
| KV | Redis 7 |
| Cloudflare Queues | Redis lists (BRPOP, v1's pattern) |
| Container DO | Standalone container, polled via the existing HMAC back-channel |
| AI Gateway | Optional layer; direct provider calls otherwise |
| Workers AI binding | Removed in self-host mode (BYOK only) |
| Analytics Engine | Stdout structured logs (operator scrapes/forwards) |

The acceptance shape is `docker-compose up` against a clean
checkout. From there, deploy targets (single VM, K8s, ECS, Azure
Container Apps, Fly.io) are mechanical translations of the compose
file.

## 2. Current state — what's already abstracted

The post-Phase-5 audit + V3 Phase 1 already isolated substantial
surface area. Confirmed by repo scan:

- **All D1 SQL lives in `apps/api/src/db/*.ts` (14 files).** A CI
  guard (`tools/check-no-inline-d1.sh`) prevents drift. Two
  exceptions are explicitly allowlisted (`ingestion/lease.ts` for
  the CAS lease primitive; `audit/query-events.ts` for the redaction
  + multi-field UPDATE).
- **`VectorStore` interface ships.** Three adapters after Phase 1
  (Vectorize, Qdrant, Pinecone), selected via
  `vectorStoreFor(env, binding: VectorBinding)` where
  `VectorBinding = { backend, index_name, embedding_dimensions }`
  comes from the resolved namespace. Phase 2 uses Qdrant as the
  self-host default but Pinecone remains supported for self-host
  too.
- **R2 access is narrow.** Three source files call `env.BLOBS.*`:
  `routes/documents.ts` (~10 call sites — upload/finalize/source
  read/delete), `audit/query-events.ts` (1 — large-payload
  side-table), `routes/internal/ingest-write.ts` (1 — back-channel
  R2 read for the Container). `lib/r2-presign.ts` does **not** call
  BLOBS directly (it only builds Worker-proxy URLs + has a
  Workers-only `crypto.DigestStream` for streaming SHA-256 — see
  §4.9). All wrappable behind a `BlobStore` interface in one short
  PR.
- **KV access is even narrower.** Three line-level call sites in
  two files — `auth/middleware.ts` (tenant-resolved-key cache, two
  calls) and `lib/secrets-store.ts` (provider-key fallback, one
  call).
- **Queue access is four sites — three producer + one consumer.**
  Producers: `ingestion/dispatch.ts`, `routes/admin/enrichment-runs.ts`,
  `routes/ingestion-jobs.ts` (retry path). Consumer: the
  `processIngestQueue(batch, env)` export in
  `ingestion/queue-handler.ts`, wired by the default-export Worker
  via the \`queue\` handler in `apps/api/src/index.ts`.
- **Container DO orchestration is two sites.** Production:
  `ingestion/queue-handler.ts:25-26` (\`INGEST_CONTAINER.idFromName(...).get(...)\`).
  Dev/debug: `routes/dev/ingest-ping.ts`. Both use the same RPC
  stub pattern (\`stub.fetch()\` to an HTTP endpoint). The HMAC
  back-channel between Worker and Container is the only contract;
  the orchestration shell is replaceable. The DO class itself
  (`lib/container.ts`, 33 lines, imports `@cloudflare/containers`)
  is CF-only and moves to `runtime/cf/` (§4.4).
- **`executionCtx.waitUntil` is six sites.** All for fire-and-forget
  background work; failure-safe via `.catch()` guards.
  `auth/middleware.ts` (×2: cache-write + last-used update),
  `routes/query-stream.ts`, `routes/internal/providers.ts`,
  `routes/internal/ingest-write.ts`, `routes/query.ts`. Replaceable
  with a tiny `BackgroundTasks` shim that tracks promises and
  awaits them on shutdown.

In short: V2's CF-specific surface is already pushed to the edges.
Phase 2 is mostly "swap the binding implementations, swap the
runtime entrypoint, ship a compose file."

## 3. Requirements

### Functional

- **F1.** `docker-compose up` against a fresh checkout brings up
  postgres + redis + qdrant + minio + api + ingest, all healthy
  within ~60 seconds. No Cloudflare dependency.
- **F2.** Every public API endpoint behaves identically on the
  self-host stack as on V2. Cookbook validator (extended in
  Phase 1) passes against the self-hosted target.
- **F3.** Tenants that exist on a V2 deploy can have their data
  exported and re-imported into a self-host deploy via a documented
  procedure (Postgres dump from D1; R2 → MinIO `mc mirror`;
  Vectorize → Qdrant via re-ingest under `mode='embed_only'`).
- **F4.** The `workers_ai` provider value is hidden from
  `POST /v1/provider-keys` validation when running in Node mode
  (no `env.AI` binding available); explicit error message.
- **F5.** AI Gateway routing is optional. A new env
  `AI_GATEWAY_URL` (already exists for V2 via wrangler vars; v3
  generalizes) — when set, providers route through it; when unset,
  direct upstream.
- **F6.** Test suite runs on **both** runtimes. CI matrix:
  `[cf-workers, node]` × `[unit, integration, e2e]`.

### Non-functional

- **NF1.** Single source tree. No "v2 fork" or "v3 fork." Same
  routes, same business logic, same tests. Only the runtime
  bootstrap + binding adapters differ.
- **NF2.** Build pipeline produces two artifacts from one repo:
  the Worker bundle (via wrangler) and the Node container image
  (via Docker).
- **NF3.** A CI guard ensures no `import` of CF-specific runtime
  types appears outside `apps/api/src/runtime/cf/`. (Symmetrically:
  no Node-only imports in `apps/api/src/runtime/node/` leak into
  `core/`.)
- **NF4.** Documentation: a `docs/SELF_HOSTING.md` runbook taking
  an operator from `git clone` to a working query in ≤15 minutes.

### Out of scope

- High-availability primaries (Postgres replicas, Redis cluster
  failover, Qdrant cluster). Operator's responsibility.
- Multi-region / data residency. Orthogonal; tracked separately.
- Helm charts / Kubernetes manifests. Documented as a follow-on;
  Phase 2 ships docker-compose only.
- Rebuilding AI Gateway equivalent. Self-host operators wire any
  AIG-compatible proxy or go direct.
- Workers AI binding parity. Removed in self-host; tenants BYOK.
- Live migration tooling for existing V2 tenants. Documented manual
  procedure only; an automated migration tool comes later if
  there's demand.

## 4. Architecture — the abstraction layer

Phase 2's central design move: every CF binding becomes an
interface, with two implementations (CF + Node). Routes consume
the interfaces only.

### 4.1 The `Bindings` shape

Today V2 (post-Phase-1) has, in `apps/api/src/types.ts`:

```ts
export interface Env {
  // env vars
  ENV: 'dev' | 'prod';
  ENABLE_DEBUG_ROUTES: string;
  ALLOWED_ORIGINS: string;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_BYPASS?: string;

  // CF bindings
  DB: D1Database;
  BLOBS: R2Bucket;
  INGEST_QUEUE: Queue<unknown>;
  VECTORIZE_OPENAI_LARGE: Vectorize;
  CACHE: KVNamespace;
  API_KEY_PEPPER: string;
  INGEST_CONTAINER: DurableObjectNamespace;
  AI: Ai;
  AE_METRICS?: AnalyticsEngineDataset;

  // Worker secrets
  ADMIN_BOOTSTRAP_TOKEN?: string;
  INTERNAL_HMAC_SECRET?: string;
  AUDIT_HASH_SALT?: string;
  WORKER_INTERNAL_URL?: string;

  // V3 Phase 1 — pluggable vector store
  QDRANT_URL?: string;
  QDRANT_API_KEY?: string;
  PINECONE_API_KEY?: string;
}
```

V3 introduces a runtime-agnostic `Bindings` object:

```ts
export interface Bindings {
  // Data layer
  db: Db;
  blobs: BlobStore;
  kv: KvStore;
  queue: QueueProducer;
  vectors: VectorStoreFactory;       // returns VectorStore per namespace
  ai?: WorkersAiBinding;             // CF-only; absent in Node
  metrics?: MetricsSink;              // CF-only AE today; Node version is stdout

  // Stateless config
  env: 'dev' | 'prod' | 'self-host';
  aiGatewayUrl?: string;
  internalHmacSecret: string;
  adminBootstrapToken?: string;
  // ... etc
}
```

Routes consume `c.env.db`, `c.env.blobs`, `c.env.kv`,
`c.env.queue`, `c.env.vectors` — never `D1Database` or `R2Bucket`
directly.

The runtime entrypoints construct `Bindings` differently:

- **CF entrypoint** (`apps/api/src/runtime/cf/bindings.ts:buildCfBindings`):
  ```ts
  const db = new D1Db(env.DB);
  const newShape: Bindings = {
    db,
    blobs: new R2BlobStore(env.BLOBS),
    kv: new CfKvStore(env.CACHE),
    queue: new CfQueueProducer(env.INGEST_QUEUE),
    vectors: { forBinding: (b) => vectorStoreFor(env, b) },
    sparseSearch: new Fts5SparseSearch(db),
    containerInvoker: new DoContainerInvoker(env.INGEST_CONTAINER),
    metrics: env.AE_METRICS ? new AeMetricsSink(env.AE_METRICS) : new NoopMetricsSink(),
    bg: ctx ? new CfBackgroundTasks(ctx) : new NoopBackgroundTasks(),
    hash: new DigestStreamHasher(),
    runtime: 'cf',
    runtimeEnv: env.ENV,
    apiKeyPepper: env.API_KEY_PEPPER,
    ...(env.AI ? { ai: env.AI } : {}),
    ...(env.VECTORIZE_OPENAI_LARGE
      ? { vectorize: env.VECTORIZE_OPENAI_LARGE as unknown as VectorizeIndexHandle }
      : {}),
    // ... remaining optional config / aiGateway
  };
  return { ...env, ...newShape } as Env; // Env extends Bindings
  ```

- **Node entrypoint** (`apps/api/src/runtime/node/bindings.ts`, Step 18):
  ```ts
  const db = new PgDb(pgPool);
  const bindings: Bindings = {
    db,
    blobs: new S3BlobStore(s3, bucket),
    kv: new RedisKvStore(redis),
    queue: new RedisQueueProducer(redis),
    vectors: { forBinding: (b) => vectorStoreFor(/* node env */, b) },
    sparseSearch: new PgSparseSearch(db),
    containerInvoker: new HttpContainerInvoker({ host, hmacSecret }),
    metrics: new StdoutMetricsSink(),
    bg: new NodeBackgroundTasks(),
    hash: new NodeCryptoHasher(),
    runtime: 'node',
    runtimeEnv: 'self-host',
    apiKeyPepper: env.API_KEY_PEPPER ?? '',
    // `ai` and `vectorize` deliberately omitted — the namespace-
    // create gate refuses `vector_backend: 'vectorize'` and the
    // workers_ai provider 501s with PROVIDER_UNAVAILABLE.
    // ... remaining optional config
  };
  ```

The CF builder spreads the source `env` onto the Bindings result so
legacy `c.env.DB` / `c.env.BLOBS` / etc. accesses keep working
through the migration period (`Env extends Bindings`).

### 4.2 Per-binding interface contracts

Each interface is small and 1:1 with what V2's CF API actually
needs. No theoretical generality — exactly the shape the existing
helpers consume.

#### 4.2.1 `Db`

```ts
interface DbStatement {
  sql: string;
  params: unknown[];
}

interface Db {
  one<T>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  /** Execute multiple statements as a single round-trip / atomic
   *  group. CF: wraps `d1.batch(...)`. Node: wraps a single
   *  BEGIN/COMMIT transaction. Used by `insertChunksBatch` and
   *  `deleteChunksByIds`. */
  batch(statements: DbStatement[]): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}
```

Implementations:
- `D1Db` — wraps `D1Database`. `one` → `prepare(sql).bind(...).first<T>()`;
  `all` → `prepare(sql).bind(...).all<T>()`; `batch` →
  `d1.batch(prepared[])` (D1's atomic-batch primitive);
  `transaction` is a no-op wrapper today (D1 doesn't have
  multi-statement transactions in the binding API; we already
  work without them).
- `PgDb` (Step 17) — wraps `pg.Pool`. `one` → `pool.query(...).rows[0] ?? null`;
  `batch` and `transaction` both use `BEGIN/COMMIT/ROLLBACK`
  explicitly.

`?` placeholders are translated to `$1, $2, ...` at the PgDb
boundary so the helpers in `db/*.ts` don't fork by dialect.

The 14 D1 helpers in `apps/api/src/db/*.ts` migrate from
`db.prepare(...).bind(...).first()` to `db.one<T>(sql, params)`.
This is the largest single migration in Phase 2 (~14 files,
mechanical edit). The chunks-batch helpers (`insertChunksBatch`,
`deleteChunksByIds`) use `db.batch(...)` instead of constructing
`D1PreparedStatement[]` directly.

**Dialect note**: `db/chunks.ts:insertChunksBatch` uses SQLite's
`INSERT OR REPLACE INTO ...`, which doesn't translate to Postgres.
Step 17 will need to either rewrite as `INSERT ... ON CONFLICT (id)
DO UPDATE SET ...` (works on both dialects) or introduce dialect-
aware SQL generation. Tracked as a J-1 follow-up in
`V3_PHASE_2_STEPS_1_15_AUDIT.md`.

#### 4.2.2 `BlobStore`

```ts
interface BlobStore {
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, opts?: { contentType?: string; metadata?: Record<string, string> }): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream; contentType?: string } | null>;
  head(key: string): Promise<{ size: number; contentType?: string; metadata?: Record<string, string> } | null>;
  delete(key: string): Promise<void>;
}
```

Implementations:
- `R2BlobStore` — wraps `R2Bucket`. Trivial.
- `S3BlobStore` — wraps `@aws-sdk/client-s3` against MinIO endpoint.
  Bucket name + endpoint from env.

V1 already proved the pattern: v1 uses the `minio` npm package,
which is essentially the same shape. We'll standardize on
`@aws-sdk/client-s3` for portability beyond MinIO (any S3-compatible
endpoint works).

#### 4.2.3 `KvStore`

```ts
interface KvStore {
  get<T = unknown>(key: string, opts?: { type?: 'json' | 'text' }): Promise<T | null>;
  put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Implementations:
- `KvStore_KV` — wraps `KVNamespace`.
- `KvStore_Redis` — wraps `ioredis` Redis client. TTL via `EX`.

Three call sites; each migrates by name swap.

#### 4.2.4 `QueueProducer`

```ts
interface QueueProducer {
  send(message: unknown): Promise<void>;
}
```

Implementations:
- `CfQueueProducer` — wraps `Queue<T>` (`q.send(message)`).
- `RedisQueueProducer` — `LPUSH textral:ingest <json>` against
  `ioredis`.

Three producer call sites (`ingestion/dispatch.ts`,
`routes/ingestion-jobs.ts`, `routes/admin/enrichment-runs.ts`)
read `c.env.queue.send(...)`. The consumer side is more involved
(§4.3).

#### 4.2.5 `VectorStoreFactory`

```ts
interface VectorStoreFactory {
  forBinding(binding: VectorBinding): VectorStore;
}
```

Already exists from Phase 1 as
`vectorStoreFor(env, binding: VectorBinding)` in
`apps/api/src/retrieval/vector-store.ts`, where
`VectorBinding = { backend, index_name, embedding_dimensions }`
is built by callers from the resolved namespace + profile-derived
dimensions. Phase 2 wraps it in a per-runtime factory closure
that callers reach as `c.env.vectors.forBinding(b)`.

Four call sites consume the factory:
`routes/namespaces.ts` (ensureBackingExists),
`routes/internal/ingest-write.ts` (×2 — upsert + delete-by-filter),
`retrieval/vectorize-query.ts` (dense query path).

**Vectorize binding access — structural shape.** To keep the
runtime-shared interface free of CF-specific types,
`apps/api/src/runtime/shared/interfaces.ts` defines a
`VectorizeIndexHandle` structural type matching just the API
surface that `VectorizeV2Adapter` consumes (`upsert`, `query`,
`deleteByIds`). The CF runtime assigns
`env.VECTORIZE_OPENAI_LARGE` directly into `bindings.vectorize`
(Cloudflare's `Vectorize` type satisfies the structural shape;
the assignment casts through `unknown` to bridge a
strict-function-type variance gap on the `query.opts.filter`
parameter). The Node runtime sets `bindings.vectorize = undefined`.

`vectorStoreFor` reads `env.vectorize` (typed as
`VectorizeIndexHandle | undefined`) instead of the CF-specific
`env.VECTORIZE_OPENAI_LARGE`. The `vectorize` case in the switch
fail-fasts with `BAD_REQUEST` if the handle is missing — but
the namespace-create endpoint refuses `vector_backend: 'vectorize'`
when `c.env.runtime === 'node'` (Step 14), so self-host tenants
never reach the dispatch with that backend.

#### 4.2.6 `SparseSearch`

```ts
interface SparseSearchArgs {
  tenant_id: string;
  namespace_id: string;
  version_ids: string[];
  artifact_types: string[];
  /** Pre-built dialect-specific query expression. CF: FTS5 MATCH
   *  syntax. Node: Postgres tsquery (Step 17). */
  match: string;
  top_k: number;
}

interface SparseSearch {
  search(args: SparseSearchArgs): Promise<Array<{ id: string; score: number }>>;
}
```

The hybrid retrieval path's sparse arm. Lifted out of
`db/chunks.ts:sparseSearchChunks` (which had hard-coded SQLite
FTS5 SQL) into a runtime-specific adapter so Node code can
compile without SQLite-isms.

Implementations:
- `Fts5SparseSearch` (CF, `runtime/cf/fts5-sparse-search.ts`) —
  runs `chunks_fts` FTS5 virtual-table query with `bm25()`
  ordering, against the supplied `Db`.
- `PgSparseSearch` (Node, Step 17 — deferred) — runs Postgres
  `tsvector` + `ts_rank`. Postgres has no native BM25; Step 17's
  design needs to either accept a different scoring function
  (`ts_rank` with custom weights) or wire in an extension
  (ParadeDB / Tantivy / Elasticsearch sidecar). Documented as a
  J-1 follow-up.

Single call site (`retrieval/hybrid.ts`) reads
`env.sparseSearch.search(args)`.

### 4.3 Queue consumer — the runtime-divergent piece

V2's queue consumer is the Worker's `queue(batch, env)` export. It
runs in the Worker isolate; CF Queues' delivery semantics handle
batching, retries, and dead-lettering at the platform layer.

In self-host mode the same logic runs as a Node process polling
Redis. V1's `apps/rag-core/app/workers/ingestion_worker.py` is the
reference: a `BRPOP textral:ingest` loop, JSON decode, dispatch,
retry-on-failure with attempt counter, dead-letter into Postgres
when attempts exceeded.

V3 introduces:

- `runIngestMessage(msg, bindings): Promise<{ ack: boolean; reason?: string }>`
  — the existing `processIngestQueue` body, factored out and
  un-tied from CF's `MessageBatch<T>` framing. Takes a single
  decoded `IngestQueueMessage`, calls
  `bindings.containerInvoker.invoke(...)`, returns whether to ack
  or retry. The current per-message body in `queue-handler.ts`
  (lines 23-60) becomes the implementation; the outer batch loop
  + `msg.ack()` / `msg.retry()` shim moves to the CF adapter.
- CF adapter: `runtime/cf/queue-consumer.ts` re-exports a
  `processIngestQueue(batch, env)` shape that loops over
  `batch.messages` and calls `runIngestMessage(...)` with the
  CF-built `Bindings`, then calls `msg.ack()` / `msg.retry()`
  based on the result.
- Node adapter: `apps/api/src/runtime/node/workers/ingest-consumer.ts`
  is a separate Node process that connects to Redis, BRPOPs in a
  loop, calls `runIngestMessage(...)` with the Node-built
  `Bindings`, and re-LPUSHes (with attempt incremented) on retry —
  or moves to a `textral:ingest:dead` list when
  `attempt >= max_retries`. Runs in its own container in the
  compose file (same image as the api but a different entrypoint).

### 4.4 Container orchestration — Container DO replaced

V2 uses a Cloudflare-managed Container Durable Object to host the
Python ingest service. The Worker calls
`env.INGEST_CONTAINER.idFromName(...).get(...).fetch(...)` to
exercise it.

Self-host: the ingest container runs as a normal Docker service
(`apps/ingest`'s `Dockerfile` already builds a clean Python
container — same image works in compose). The api Node process
calls it via plain HTTP at the compose-network hostname:
`http://ingest:8000/jobs/run`. The HMAC back-channel between api
and ingest is unchanged.

A new `ContainerInvoker` interface abstracts the call site. The
existing `processIngestQueue` reads both the HTTP status code AND
the JSON outcome to decide ack/retry, so the interface must surface
both:

```ts
type ContainerOutcome =
  | 'full_success'
  | 'partial_ingestion'
  | 'fatal_failure';

interface ContainerInvokeResult {
  /** Raw HTTP status from the Container call. The consumer reads
   *  this to decide ack vs retry: 2xx → ack, 409/423 (lease taken
   *  / job terminal) → ack, 5xx / network → retry. */
  status: number;
  /** Outcome from the Container's response body. Present iff
   *  status is 2xx. */
  outcome?: ContainerOutcome;
}

interface ContainerInvoker {
  /** Invoke the Container's `/jobs/run` endpoint with the given
   *  HMAC-signed payload. Returns the status + parsed outcome so
   *  the runtime-agnostic consumer can drive ack/retry. */
  invoke(args: { job_id: string; attempt: number }): Promise<ContainerInvokeResult>;
}
```

CF adapter: `DoContainerInvoker` calls
`env.INGEST_CONTAINER.idFromName(...).get(...).fetch(...)` — the
existing pattern in `ingestion/queue-handler.ts`.
Node adapter: `HttpContainerInvoker` POSTs to
`http://${CONTAINER_HOST}:8000/jobs/run` with the standard HMAC
headers.

The DO class itself (`apps/api/src/lib/container.ts`, 33 lines,
imports `@cloudflare/containers`) is CF-only and moves to
`runtime/cf/container.ts`. The `IngestContainer` re-export at
`apps/api/src/index.ts:39` becomes `runtime/cf/index.ts`-only.

### 4.5 `executionCtx.waitUntil` → `BackgroundTasks`

```ts
interface BackgroundTasks {
  /** Schedule fire-and-forget work. Awaited on graceful shutdown
   *  in Node mode; tied to the Worker request lifecycle in CF mode. */
  spawn(promise: Promise<unknown>): void;
}
```

CF adapter: `bg.spawn(p)` → `c.executionCtx.waitUntil(p)`.
Node adapter: tracked in a `Set<Promise>`; on `SIGTERM` we drain
with a 30-second timeout, log any pending tasks that didn't finish.

The six call sites in `apps/api/src/` migrate from
`c.executionCtx.waitUntil(...)` to `c.env.bg.spawn(...)`.

### 4.6 AI Gateway

`apps/api/src/providers/registry.ts:computeGateway()` reads the
runtime-built `bindings.aiGateway` instead of CF-specific env
fields directly. `GatewayConfig` (the shape providers consume) is:

```ts
interface GatewayConfig {
  base_url: string;             // pre-built by the runtime
  metadata_header_prefix: 'cf-aig-' | 'x-aig-';
  provider: string;             // dash-cased for CF; identity elsewhere
}
```

The shape splits per runtime:

- **CF runtime** (`runtime/cf/bindings.ts`): builds `aiGateway`
  from `CF_ACCOUNT_ID + AI_GATEWAY_ID` (skipping when
  `AI_GATEWAY_BYPASS=true`):
  ```ts
  baseUrl: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${AI_GATEWAY_ID}`,
  metadataHeaderPrefix: 'cf-aig-',
  providerSegment: (p) => p === 'workers_ai' ? 'workers-ai' : p,
  ```
- **Node runtime** (Step 18): reads `AI_GATEWAY_BASE_URL` env:
  ```ts
  baseUrl: process.env.AI_GATEWAY_BASE_URL,
  metadataHeaderPrefix: 'x-aig-',
  providerSegment: (p) => p,
  ```

`gatewayBaseUrl(cfg)` returns `${cfg.base_url}/${cfg.provider}`.
`gatewayMetadataHeader(cfg)` returns `${cfg.metadata_header_prefix}metadata`.
The provider HTTP clients (`anthropic.ts`, `lib/http-client.ts`)
read both helpers and never hardcode `cf-aig-` literals.

Self-host operators who don't want a gateway just leave
`AI_GATEWAY_BASE_URL` unset; `bindings.aiGateway` is undefined and
`computeGateway` returns undefined → providers go direct.

The snake_case (`base_url`, `metadata_header_prefix`) on
`GatewayConfig` versus camelCase (`baseUrl`, `metadataHeaderPrefix`)
on the `Bindings.aiGateway` field is intentional: `providers/types.ts`
is the wire-format-adjacent layer (matches `provider_keys.provider`
naming), while `runtime/shared/interfaces.ts` follows JS
conventions. The translation lives in
`providers/registry.ts:computeGateway`.

### 4.7 Analytics Engine

`apps/api/src/observability/metrics.ts:writeMetric(env, dataset,
point)` reads `env.metrics.write(...)` (the runtime-shared
`MetricsSink` adapter). The CF runtime constructs `AeMetricsSink`
when `env.AE_METRICS` is bound, otherwise `NoopMetricsSink`
(preserving the existing "absent binding → no-op" behavior). The
Node runtime constructs `StdoutMetricsSink` that emits structured
JSON lines; operators forward to whatever backend they have
(Loki, Datadog, ELK, ClickHouse).

Three call sites of `writeMetric` (in `routes/query.ts`,
`routes/query-stream.ts`, `routes/internal/ingest-write.ts`)
remain unchanged at the call site; only the indirection layer
moves from direct binding access to the adapter.

### 4.8 Workers AI binding — structural shape

The `workers_ai` provider in `apps/api/src/providers/registry.ts`
is the only consumer of the Workers AI binding. To keep the
runtime-shared interface free of CF-specific types, the
`Bindings.ai` field is typed as a structural `WorkersAiBinding`:

```ts
interface WorkersAiBinding {
  run(model: string, args: unknown, options?: unknown): Promise<unknown>;
}
```

CF assigns `env.AI` (which has the real `Ai` type from
`@cloudflare/workers-types`) into `bindings.ai` — `Ai` satisfies
the structural shape. Node sets `bindings.ai = undefined`. The
registry's `workers_ai` branch reads
`if (!env.ai) throw new TextralError('PROVIDER_UNAVAILABLE', 501,
'Workers AI not available in this deploy. Self-hosted Textral
requires BYOK for all providers.')` when invoked.

`WorkersAIBindingProvider`'s constructor takes the structural shape
rather than CF's `Ai` type, so it compiles in Node code that doesn't
have `@cloudflare/workers-types` in tsconfig.

The provider docs (Provider Keys tag) get a runtime-conditional
note: "Workers AI no-key tier available only in Cloudflare-hosted
deployments. Self-hosted Textral requires BYOK for all providers."

### 4.9 Streaming SHA-256 — `Hasher` shim

`apps/api/src/lib/r2-presign.ts:sha256OfStream` uses the
Workers-only `crypto.DigestStream('SHA-256')` to hash uploaded
bytes during finalize without buffering the whole stream in
memory. Node has no DigestStream; it uses `node:crypto`'s
`createHash('sha256')` consuming a `Readable`.

A small `Hasher` interface lives on `Bindings`:

```ts
interface Hasher {
  /** Hex-encoded SHA-256 of the entire stream, computed without
   *  buffering. */
  sha256OfStream(stream: ReadableStream<Uint8Array>): Promise<string>;
}
```

CF adapter wraps `crypto.DigestStream`. Node adapter pipes the
web stream into `Readable.fromWeb(...)` and hashes via
`createHash('sha256')`. The single existing call site in
`routes/documents.ts` (finalize handler) reads
`c.env.hash.sha256OfStream(...)` instead of importing
`sha256OfStream` directly.

### 4.10 Namespace-create runtime gating

Phase 1's namespace-create validator in
`apps/api/src/routes/namespaces.ts` accepts all three
`vector_backend` values regardless of runtime. Phase 2 adds a
runtime-aware guard: when `c.env.runtime === 'node'`, the
endpoint rejects `vector_backend: 'vectorize'` with a 400
("Vectorize backend unavailable in self-host mode; pick `qdrant`
or `pinecone`").

Why `runtime === 'node'` rather than `!c.env.ai` or
`!c.env.vectorize`? The cf-pool test environment unsets `env.AI`
and `env.VECTORIZE_OPENAI_LARGE` (no local Vectorize emulator)
but is logically a CF runtime; the namespace-create flow's
`vectorStoreFor → VectorizeV2Adapter` succeeds in tests (the
Vectorize adapter is constructed but never reaches a real index;
`ensureBackingExists` is undefined for Vectorize so no upstream
call occurs). Gating on `runtime` (which is set to `'cf'` by
`buildCfBindings` regardless of what's bound) preserves test
behavior while still giving Node deploys a clean rejection.

Cf-pool test coverage of the Node-mode gate is **deferred to
Step 21** — the cf-pool harness rebuilds `bindings.runtime: 'cf'`
on every `worker.fetch` so a `runtime: 'node'` mutation can't
survive into the route. The Node-side integration suite naturally
exercises the path.

### 4.11 Deploy-environment label — `runtimeEnv`

`Bindings.runtimeEnv: 'dev' | 'prod' | 'self-host'` is the
runtime-agnostic deploy-environment label. The CF runtime sets it
from `env.ENV` (`'dev' | 'prod'`); the Node runtime hardcodes
`'self-host'`. Two consumers:

- **`apps/api/src/lib/secrets-store.ts:69`** —
  `if (env.runtimeEnv === 'prod') throw SECRETS_STORE_UNAVAILABLE`.
  Refuses to fall back to the in-process Map secrets store on a
  prod deploy. `runtimeEnv === 'self-host'` is treated like dev
  (the in-process Map is single-instance only; multi-instance
  self-host operators must wire a real secrets store via
  Vault / SOPS / SealedSecrets etc.).

- **`apps/api/src/routes/health.ts:22`** —
  `c.json({ status: 'ok', env: c.env.runtimeEnv, ts: ... })`.
  The `HealthResponse` Zod schema accepts all three values.

The `runtimeEnv` field replaces the legacy `env.ENV` reads at
those two sites. The CF binding `Env.ENV` remains in `types.ts`
flagged with a `PHASE_2_CLEANUP_TODO:` marker; once `Env`
collapses to `Bindings`, `Env.ENV` goes away and only
`runtimeEnv` remains.

## 5. Repository organization — the V2/V3 cohabitation

The single biggest design choice is how V2 (Cloudflare) + V3
(self-host) share one source tree without forking.

**Chosen shape:** **shared core + thin runtime adapters at the
edges.** Most code is runtime-agnostic. CF-specific code lives in
`apps/api/src/runtime/cf/`. Node-specific code lives in
`apps/api/src/runtime/node/`.

```
apps/api/
├── src/
│   ├── runtime/
│   │   ├── cf/                       ← Workers entrypoint + binding adapters (Steps 1-15).
│   │   │   ├── bindings.ts           ← buildCfBindings(env, ctx) factory
│   │   │   ├── container.ts          ← IngestContainer DO (moved from lib/)
│   │   │   ├── queue-consumer.ts     ← processIngestQueue batch wrapper
│   │   │   ├── d1-db.ts              ← class D1Db implements Db (incl. batch())
│   │   │   ├── r2-blob-store.ts      ← class R2BlobStore implements BlobStore
│   │   │   ├── kv-store.ts           ← class CfKvStore implements KvStore
│   │   │   ├── cf-queue.ts           ← class CfQueueProducer implements QueueProducer
│   │   │   ├── do-container-invoker.ts ← class DoContainerInvoker implements ContainerInvoker
│   │   │   ├── bg-tasks.ts           ← CfBackgroundTasks (waitUntil) + NoopBackgroundTasks
│   │   │   ├── digest-stream-hasher.ts ← class DigestStreamHasher implements Hasher
│   │   │   ├── ae-metrics.ts         ← AeMetricsSink + NoopMetricsSink
│   │   │   └── fts5-sparse-search.ts ← class Fts5SparseSearch implements SparseSearch
│   │   ├── node/                     ← Steps 17-19 (deferred).
│   │   │   ├── index.ts              ← `serve({ fetch: app.fetch, port })`
│   │   │   ├── bindings.ts           ← buildNodeBindings(process.env)
│   │   │   ├── pg-db.ts              ← class PgDb implements Db (incl. batch via tx)
│   │   │   ├── pg-sparse-search.ts   ← Postgres tsvector + ts_rank
│   │   │   ├── s3-blob-store.ts
│   │   │   ├── redis-kv.ts
│   │   │   ├── redis-queue.ts        ← producer
│   │   │   ├── http-container-invoker.ts
│   │   │   ├── bg-tasks.ts           ← Set<Promise>-backed; drains on SIGTERM
│   │   │   ├── node-crypto-hasher.ts ← createHash + Readable.fromWeb
│   │   │   ├── stdout-metrics.ts
│   │   │   └── workers/
│   │   │       └── ingest-consumer.ts ← BRPOP loop, separate Node entrypoint
│   │   └── shared/
│   │       └── interfaces.ts         ← Bindings, Db (+ DbStatement),
│   │                                    BlobStore, KvStore, QueueProducer,
│   │                                    ContainerInvoker, MetricsSink,
│   │                                    BackgroundTasks, Hasher, SparseSearch,
│   │                                    VectorStoreFactory, AiGatewayConfig,
│   │                                    WorkersAiBinding, VectorizeIndexHandle
│   ├── routes/                       ← consume Bindings via Hono c.env
│   ├── db/                           ← 14 helpers + lease + audit/query-events
│   │                                    use Db; FTS5 sparse search lifted to
│   │                                    runtime/cf/fts5-sparse-search.ts
│   ├── retrieval/                    ← vectorStoreFor reads bindings.vectorize;
│   │                                    callers reach c.env.vectors.forBinding
│   ├── ingestion/
│   │   └── ingest-message.ts         ← runIngestMessage (runtime-agnostic body)
│   ├── synthesis/                    ← unchanged
│   ├── auth/                         ← uses KvStore for tenant-cache
│   ├── observability/
│   │   └── metrics.ts                ← writeMetric reads bindings.metrics
│   ├── providers/                    ← registry uses bindings.aiGateway, .ai
│   ├── lib/                          ← uses BlobStore + Hasher
│   ├── app.ts                        ← runtime-agnostic OpenAPIHono construction
│   ├── index.ts                      ← CF default-export shell (fetch + queue +
│   │                                    IngestContainer re-export). Wraps env
│   │                                    in buildCfBindings(env, ctx).
│   └── types.ts                      ← Env extends Bindings during migration;
│                                       legacy CF fields carry
│                                       PHASE_2_CLEANUP_TODO markers.
├── migrations/
│   ├── sqlite/                       ← NEW. wrangler-applied (existing files moved here).
│   └── postgres/                     ← NEW. self-host migration runner applies.
├── wrangler.toml                     ← unchanged shape
└── Dockerfile                        ← NEW. Node-target image for self-host.

apps/ingest/                          ← unchanged. Same Python service runs in both modes.

infrastructure/docker/
├── docker-compose.dev.yml            ← from Phase 1 — local Qdrant + ingest only
└── docker-compose.yml                ← NEW (Phase 2). Full self-host stack.
```

### 5.1 Why "shared core" beats "runtime fork"

Three options were considered:

1. **Two separate apps** (`apps/api-cf/` + `apps/api-node/`)
   sharing a `packages/core`. Problem: every route file would need
   to be duplicated or moved into `core`, which still leaves the
   Hono app construction split. Maintenance burden compounds with
   every PR.
2. **Build-time conditional imports.** Problem: TS doesn't have
   first-class conditional imports; tools like `vite-plugin-resolve`
   or `tsc-paths` work but introduce build complexity. CI must
   build both targets and compare; a missed conditional becomes a
   silent runtime divergence.
3. **Runtime selection at startup** (the chosen shape). Same
   compiled bundle has both adapter sets; the entrypoint picks
   one. **Problem:** the bundle ships some unused code. Mitigated
   by tree-shaking — the CF entrypoint never imports
   `runtime/node/*`, so wrangler's bundler drops it. The Node
   entrypoint never imports `runtime/cf/*`, so `tsc + esbuild`
   drops it. CI guards verify.

Option 3 wins on simplicity. Runtime selection is one import in
the entrypoint:

```ts
// apps/api/src/index.ts (CF entrypoint — wrangler.toml's `main`)
import app from './app.js';
import { processIngestQueue, type IngestQueueMessage } from './runtime/cf/queue-consumer.js';
import { buildCfBindings } from './runtime/cf/bindings.js';
export { IngestContainer } from './runtime/cf/container.js';
export default {
  async fetch(req, env, ctx) {
    const bindings = buildCfBindings(env, ctx);
    return app.fetch(req, bindings, ctx);
  },
  async queue(batch, env) {
    const bindings = buildCfBindings(env, null); // null ctx → NoopBackgroundTasks
    await processIngestQueue(batch as MessageBatch<IngestQueueMessage>, bindings);
  },
} satisfies ExportedHandler<Env, IngestQueueMessage>;
```

```ts
// apps/api/src/runtime/node/index.ts (Step 18 — deferred)
import { serve } from '@hono/node-server';
import app from '../../app.js';
import { buildNodeBindings } from './bindings.js';
const ctx = await buildNodeBindings(process.env);
serve({ fetch: (req) => app.fetch(req, ctx.bindings), port: 8787 });
process.on('SIGTERM', () => ctx.shutdown());
// + a separate ingest-consumer.ts process, also using buildNodeBindings.
```

`apps/api/src/app.ts` is the OpenAPIHono construction — pure
business logic. Both entrypoints import it.

### 5.2 Build pipeline

V3 ships two artifacts:

- **CF Worker bundle.** `wrangler deploy --env <env>` —
  unchanged from V2. `wrangler.toml`'s `main` points at
  `src/index.ts`.
- **Node container image.** `apps/api/Dockerfile` (new) —
  multi-stage: builder stage runs `tsc` + `esbuild` to produce
  `dist/runtime/node/index.js` + `dist/runtime/node/workers/
  ingest-consumer.js`; runtime stage is a slim `node:24-alpine`
  with the bundle. Two entrypoints in one image:
  `node dist/runtime/node/index.js` (api) and
  `node dist/runtime/node/workers/ingest-consumer.js` (consumer).

### 5.3 Migration files — two trees or portable SQL?

D1 is SQLite-flavored; Postgres needs different SQL. Three
options:

1. **Single portable SQL.** Writing SQL that works on both. Mostly
   feasible (UUIDs vs ULIDs are app-side; `JSON` columns work on
   both as TEXT; `ON CONFLICT` works on both). But subtle
   differences (`AUTOINCREMENT`, `PRAGMA`, `IFNULL` vs `COALESCE`)
   eventually bite.
2. **Parallel migration trees.** `migrations/sqlite/` +
   `migrations/postgres/`. CI runs both against their respective
   targets to detect drift.
3. **Ship Postgres-only migrations after a one-time port + freeze
   D1 at the V2 schema.** D1 deploys would only ever apply v2's
   final migration set; V3 self-host ships the Postgres-only
   tree.

**Chosen:** option 2 — parallel migration trees. The current 6
SQLite files port to Postgres (migration 0001–0006); a CI test
applies each tree against a real Postgres + a real D1 in vitest,
schema-diffs the results, and fails on drift. The drift-detection
test is the regression guard.

Each new feature that needs a schema change ships **both**
migrations in the same PR. The reviewer treats them as one unit.

### 5.4 Co-existence in deployed environments

A V2 deploy on Cloudflare consumes only the CF runtime + SQLite
migrations + wrangler.toml. It never touches the Node tree.

A V3 self-host deploy consumes the Node runtime + Postgres
migrations + the compose file. It never touches wrangler.toml.

The same source tree, the same business logic, the same tests.
Two thin entrypoints + two adapter sets at the edges + two
migration trees.

## 6. The full `docker-compose.yml`

`infrastructure/docker/docker-compose.yml` (lifted from V1's shape
with V3's service set):

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-textral}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-textral_dev}
      POSTGRES_DB: ${POSTGRES_DB:-textral}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER:-textral}"], interval: 5s }

  redis:
    image: redis:7
    volumes: [redisdata:/data]
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 5s }

  qdrant:
    image: qdrant/qdrant:latest
    volumes: [qdrantdata:/qdrant/storage]
    healthcheck: { test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/6333'"], interval: 5s }

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-textral}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-textral_dev}
    volumes: [miniodata:/data]
    healthcheck: { test: ["CMD-SHELL", "curl -sf http://localhost:9000/minio/health/live || exit 1"], interval: 5s }

  api:
    build:
      context: ../..
      dockerfile: apps/api/Dockerfile
      target: runtime
    command: ["node", "dist/runtime/node/index.js"]
    ports: ["8787:8787"]
    env_file: ../../.env.selfhost
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      qdrant: { condition: service_healthy }
      minio: { condition: service_healthy }

  ingest-worker:
    build:
      context: ../..
      dockerfile: apps/api/Dockerfile
      target: runtime
    command: ["node", "dist/runtime/node/workers/ingest-consumer.js"]
    env_file: ../../.env.selfhost
    depends_on:
      api: { condition: service_healthy }

  ingest:
    build:
      context: ../../apps/ingest
    env_file: ../../.env.selfhost
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:8000/health')\""]
      interval: 5s
    depends_on:
      qdrant: { condition: service_healthy }
      minio: { condition: service_healthy }
      postgres: { condition: service_healthy }

volumes: { pgdata: {}, redisdata: {}, qdrantdata: {}, miniodata: {} }
networks:
  default: { driver: bridge }
```

`.env.selfhost` carries the connection strings + secrets:

```
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=textral
POSTGRES_PASSWORD=textral_dev
POSTGRES_DB=textral
REDIS_URL=redis://redis:6379
QDRANT_URL=http://qdrant:6333
MINIO_ENDPOINT=http://minio:9000
MINIO_ROOT_USER=textral
MINIO_ROOT_PASSWORD=textral_dev
MINIO_BUCKET=textral-blobs
INTERNAL_HMAC_SECRET=...
ADMIN_BOOTSTRAP_TOKEN=...
API_KEY_PEPPER=...
AUDIT_HASH_SALT=...
CONTAINER_HOST=ingest
```

## 7. Test strategy

### 7.1 Unit tests

Every adapter has its own unit-test file with mocked underlying
client. Pin the request/response shape. Same tests can be run
against both runtimes; the selector picks the implementation.

### 7.2 Integration tests

V2 already runs vitest tests inside the Workers pool
(`@cloudflare/vitest-pool-workers`). V3 adds a parallel Node-side
test runner: standard vitest + a `testcontainers`-spawned Postgres
+ Redis + MinIO + Qdrant per test suite.

CI matrix: `[cf-pool, node]` × `[unit, integration]`. A divergence
between runtimes is a release blocker.

### 7.3 E2E

The cookbook validator
(`apps/api/scripts/validate-cookbook.ts`, ext. in Phase 1) runs
against:
- A V2 dev deployment (live Cloudflare).
- A V3 self-host deployment (`docker compose up` then validate).

The same 8 patterns must produce identical outputs (modulo
non-deterministic LLM output). Citation counts, audit shape,
degradation level: identical.

## 8. Migration paths

### 8.1 V2 → V3 self-host

A V2 tenant can move data to a V3 self-host deploy via a manual
runbook:

1. **Postgres bootstrap.** `docker compose up postgres`; apply the
   `migrations/postgres/` tree.
2. **D1 dump.** `wrangler d1 export <db> --remote --output v2.sql`,
   sed-rewrite the SQLite-isms (`AUTOINCREMENT` → `serial`,
   `IFNULL` → `COALESCE`, etc.) — most rows go in unchanged.
3. **R2 sync.** `mc mirror cf-r2://<bucket> minio/textral-blobs`
   (Cloudflare R2 has an S3-compatible endpoint; the Cloudflare
   docs cover the credentials shape).
4. **Vector data.** Re-ingest in the new namespaces under
   `mode='embed_only'`. There is no Vectorize → Qdrant data export
   tool; the embeddings have to be regenerated. (For tenants who
   want to skip re-embedding, run their existing embeddings
   through the Qdrant adapter directly; we'll provide a small
   helper script if there's demand.)
5. **DNS cutover.** Tenant-side change.

This is documented in `docs/SELF_HOSTING.md` §migration. The
runbook is manual; a one-button migration tool is post-Phase-2.

### 8.2 V3 self-host → V2

Symmetric reverse path. Less interesting (most tenants moving in
this direction means going from self-host trial → managed SaaS;
we'd help them through it manually).

## 9. Operational concerns

### 9.1 Single-node assumption

The compose file is single-instance. Operator's responsibility to
add HA (Postgres replicas, Redis Sentinel/Cluster, Qdrant
replicas, MinIO distributed mode). Documented as such; we don't
ship turnkey HA.

### 9.2 Secret management

Self-host has no Cloudflare Secrets Store equivalent built in.
The `Bindings.kv` Redis-backed secrets store works for
single-instance deploys. For multi-instance, operators wire
HashiCorp Vault / SOPS / SealedSecrets and read into env at
container startup. Documented; not a code change.

### 9.3 TLS termination

Compose ships HTTP-only on the api service. Operators put a
reverse proxy (Caddy / Traefik / nginx) in front. Documented in
`docs/runbooks/SELF_HOSTING_TLS.md`.

### 9.4 Backups

`pg_dump` + `mc mirror` for MinIO + Qdrant `snapshot` API. Cron
the operator owns. Documented.

### 9.5 Upgrades

`docker compose pull && docker compose up -d` for image upgrades;
`pnpm migrate-postgres` for schema upgrades. Migrations are
forward-only. Documented.

### 9.6 Logging

Structured JSON to stdout, drained by the operator's log
infrastructure. The redaction middleware (still wired in app.ts
regardless of runtime) keeps provider keys out of logs.

### 9.7 Telemetry

Stdout metrics + the operator's choice of forwarder. `MetricsSink`
defaults to stdout in self-host. Documented forwarder examples for
Loki, Datadog, OTLP.

## 10. Risks + mitigations

| Risk | Mitigation |
|------|------------|
| SQL dialect drift between SQLite and Postgres trees | CI test applies both, schema-diffs them, fails on drift. Reviewers see both migrations in the same PR. |
| Runtime divergence (V2 ≠ V3 behavior) for some niche corner | Cookbook validator runs against both; CI matrix runs the test suite on both; eval contract baseline runs against both. |
| Tree-shaking misses a CF-specific import in a Node bundle | Build-time guard: `tsc + esbuild` for Node target with `paths` excluding `runtime/cf/*`. CI verifies the resulting bundle has zero `cloudflare:`/`@cloudflare/`/`Vectorize`/etc. references. |
| Workers-AI removed in self-host breaks tenant flows that rely on it | Documented + the provider registry returns a clean 501 with a remediation message. |
| Container DO RPC pattern doesn't translate cleanly | The HMAC back-channel **is** the existing protocol — just over plain HTTP instead of DO stub. The Container API is unchanged; only the orchestration layer differs. Verified on V1's pattern. |
| Postgres connection pooling under load | Use `pg.Pool` with sane defaults (10 connections); operators tune via env. Documented. |
| Operators with custom S3-compatible endpoints (Wasabi, Backblaze) | `S3BlobStore` takes a generic endpoint URL. MinIO is the default; any endpoint that speaks S3 works. |
| `executionCtx.waitUntil` semantics on shutdown in Node | Node BackgroundTasks shim drains pending promises with a 30s timeout on `SIGTERM`. Pending tasks log a warning if they don't finish. |
| Live e2e cost regression vs V2 | Phase 2 e2e runs against local containers; no per-call provider charges. Live OpenAI charges are tenant-side same as V2. |

## 11. Acceptance criteria

- [ ] `infrastructure/docker/docker-compose.yml` brings up
      postgres + redis + qdrant + minio + api + ingest-worker +
      ingest, all healthy in ≤60s on a clean checkout.
- [ ] Every cookbook pattern passes against the self-host stack
      (no Cloudflare in the loop).
- [ ] Every existing V2 test still passes against the CF runtime.
- [ ] CI matrix `[cf-pool, node] × [unit, integration]` is green.
- [ ] No `cloudflare:` / `@cloudflare/*` / V2 binding-type imports
      outside `apps/api/src/runtime/cf/` (CI guard).
- [ ] No `pg` / `ioredis` / `@aws-sdk/client-s3` imports outside
      `apps/api/src/runtime/node/` (CI guard).
- [ ] Both migration trees (`migrations/sqlite/` + `migrations/postgres/`)
      apply cleanly and produce equivalent schemas (verified by a
      schema-diff test).
- [ ] `docs/SELF_HOSTING.md` walks an operator from `git clone` to
      a working query in ≤15 minutes.
- [ ] `wrangler deploy --env dev` still produces a working V2
      deploy (no regression).
- [ ] The audit fields (`audit.reranker.executed`, `audit.tokens.*`,
      `audit.degradation_level`) appear identically in both
      runtimes.
- [ ] License decision documented (see §12).

## 12. Open questions

- **License model.** Self-host changes the picture. Options:
  - **MIT/Apache** — fully permissive. Self-host operators can
    do whatever; SaaS competitors can fork freely.
  - **SSPL / BUSL** — copyleft-style; commercial use requires a
    license. Used by MongoDB, Elastic, Sentry, etc.
  - **Source-available** — non-commercial / non-compete clauses;
    used by CockroachDB, Sentry post-FUSL, etc.
  Decision needs to land **before** Phase 2 ships publicly.
- **Pricing.** Hosted SaaS (Cloudflare V2) vs self-host enterprise
  license — separate revenue models. Strategy decision.
- **Support model for self-host.** Community-only via GitHub
  Issues, or a paid SLA tier? Enterprise wants the latter.
- **Migration tooling investment.** §8 documents a manual runbook;
  a one-button migration tool is meaningful engineering. Does the
  first qualified self-host customer trigger building it?
- **AI Gateway substitute.** A self-host operator who *wants* AIG
  semantics (per-tenant routing tags, caching) can wire any
  proxy. Should we provide a reference docker-compose entry for a
  recommended one (LiteLLM proxy, Helicone, etc.)?
- **Workers AI parity.** Self-host loses the no-key inference
  tier. We could ship a "default OpenAI key" pattern (operator-
  configured, all tenants charged through it), but that
  complicates billing + provider-key resolution. Defer until
  asked.
- **Does the Container's Python service stay Python?** The Node
  api could absorb the ingest stages; v1 had a pure-Python rag-
  core because the embedding/chunking ecosystem was Python-strong.
  Today most of that's in TS. Worth a follow-on doc; out of scope
  for Phase 2.

## 13. Phase 2 deliverable shape

A single PR (or short PR series) lands. Status as of audit
remediation (Steps 1-15 + the post-Step-15 audit-remediation
pass; all CF-side adapters are wired through end-to-end):

1. **[SHIPPED]** The runtime-shared interfaces in
   `apps/api/src/runtime/shared/interfaces.ts` — `Db` (with
   `batch(statements: DbStatement[])`), `BlobStore`, `KvStore`,
   `QueueProducer`, `ContainerInvoker`, `MetricsSink`,
   `BackgroundTasks`, `Hasher`, `SparseSearch`,
   `VectorStoreFactory`. Plus the structural shapes
   `WorkersAiBinding` and `VectorizeIndexHandle` (so Node code can
   compile without `@cloudflare/workers-types`). Plus the
   `Bindings` shape that `Env extends` during the migration.
2. **[SHIPPED]** CF adapters in `apps/api/src/runtime/cf/`:
   `bindings.ts` (Env → Bindings factory), `d1-db.ts` (with
   `batch` + `transaction` no-op), `r2-blob-store.ts`,
   `kv-store.ts`, `cf-queue.ts`, `do-container-invoker.ts`,
   `bg-tasks.ts` (CfBackgroundTasks + NoopBackgroundTasks),
   `digest-stream-hasher.ts`, `ae-metrics.ts` (Ae + Noop),
   `fts5-sparse-search.ts`, `queue-consumer.ts` (CF batch wrapper),
   `container.ts` (the moved DO class).
3. **[Step 17 — TODO]** Node adapters in
   `apps/api/src/runtime/node/`: `index.ts` (Hono node-server),
   `bindings.ts`, `pg-db.ts` (with `batch` via BEGIN/COMMIT;
   translates `?` → `$1`-style placeholders),
   `pg-sparse-search.ts` (Postgres tsvector + ts_rank),
   `s3-blob-store.ts`, `redis-kv.ts`, `redis-queue.ts`,
   `http-container-invoker.ts`, `bg-tasks.ts`,
   `node-crypto-hasher.ts`, `stdout-metrics.ts`,
   `workers/ingest-consumer.ts` (BRPOP loop entrypoint).
4. **[SHIPPED]** The 14 D1 helpers in `apps/api/src/db/*.ts`
   migrated from `db.prepare(...).bind(...)` to
   `db.one/all/exec/batch/transaction(...)`. The two allowlisted
   exceptions (`ingestion/lease.ts`, `audit/query-events.ts`)
   migrate too. The chunks-batch helpers (`insertChunksBatch`,
   `deleteChunksByIds`) consume `db.batch(statements)`. The CI
   guard's allowlist collapses to just `apps/api/src/db/**`.
5. **[SHIPPED]** The 6 `executionCtx.waitUntil` sites migrated
   to `c.env.bg.spawn(...)`. The CF adapter ties `bg.spawn` to
   `executionCtx.waitUntil`; the Node adapter (Step 17) to a
   tracked promise set with 30s drain on SIGTERM.
6. **[SHIPPED]** The queue consumer body factored into
   `apps/api/src/ingestion/ingest-message.ts:runIngestMessage(msg,
   bindings)`. CF wrapper (`runtime/cf/queue-consumer.ts`) iterates
   `batch.messages`; Node wrapper (Step 19) BRPOPs.
7. **[SHIPPED]** Streaming SHA-256 ported off `crypto.DigestStream`.
   New `Hasher.sha256OfStream(...)` replaces the legacy
   `sha256OfStream` import. CF: `DigestStreamHasher`. Node (Step
   17): `NodeCryptoHasher` (createHash via Readable.fromWeb).
8. **[SHIPPED]** Namespace-create gates `vector_backend: 'vectorize'`
   on `c.env.runtime === 'node'` (rejecting in self-host mode).
   Cf-pool tests cover the CF-mode happy path; Node-mode case
   deferred to Step 21's integration suite.
9. **[SHIPPED]** AI Gateway runtime split. `computeGateway()` reads
   `bindings.aiGateway` (built per-runtime). `gatewayMetadataHeader`
   helper replaces literal `cf-aig-metadata` in providers. CF
   builds from `CF_ACCOUNT_ID + AI_GATEWAY_ID + AI_GATEWAY_BYPASS`;
   Node (Step 17) reads `AI_GATEWAY_BASE_URL` and emits `x-aig-`
   header prefix.
9a. **[SHIPPED — post-audit remediation]** FTS5 sparse search
    abstracted out of `db/chunks.ts:sparseSearchChunks` into
    `runtime/cf/fts5-sparse-search.ts:Fts5SparseSearch` (CF) +
    pending `runtime/node/pg-sparse-search.ts` (Node, Step 17).
    Caller (`retrieval/hybrid.ts`) reads
    `c.env.sparseSearch.search(args)`.
9b. **[SHIPPED — post-audit remediation]** All 9 adapter slots
    in `Bindings` are consumed end-to-end: `metrics`, `vectors`,
    `queue`, and `sparseSearch` were dead in the initial Steps
    1-15 ship; remediation wired them through. `runtimeEnv`
    (replaces `env.ENV` reads in `secrets-store.ts` and
    `health.ts`). Workers AI 501 path (`PROVIDER_UNAVAILABLE`)
    has direct test coverage.
10. Postgres migration tree (port of all 6 SQLite migrations).
    Schema-diff test against the SQLite tree as drift-detection.
11. The full `infrastructure/docker/docker-compose.yml` (the
    Phase 1 `docker-compose.dev.yml` stays — it's the dev-only
    Qdrant+ingest variant for hybrid Worker-on-CF + local-Qdrant
    workflows). Plus `.env.selfhost.example`.
12. `apps/api/Dockerfile` for the Node container image. Two
    entrypoints in one image: `node dist/runtime/node/index.js`
    (api), `node dist/runtime/node/workers/ingest-consumer.js`
    (consumer).
13. Migrations split: existing `apps/api/migrations/*.sql` move to
    `apps/api/migrations/sqlite/`; new
    `apps/api/migrations/postgres/*.sql` tree lands in parallel.
    `wrangler.toml`'s `migrations_dir` updates accordingly.
14. CI matrix expansion: `[cf-pool, node] × [unit, integration]`.
    Two new guard scripts:
    `tools/check-no-cf-imports-in-node.sh` (refuses
    `cloudflare:` / `@cloudflare/*` / `Vectorize` / `MessageBatch`
    types under `runtime/node/` or in shared code) and
    `tools/check-no-node-imports-in-cf.sh` (refuses `pg`, `ioredis`,
    `@aws-sdk/client-s3`, `node:*` under `runtime/cf/`).
15. Self-host quickstart (`docs/SELF_HOSTING.md`).
16. License decision recorded.

The current source tree is small enough + the post-Phase-5 audit +
Phase-1 already left the abstractions in the right places that
this lands in one push given disciplined sequencing. Phase 1's
vector pluggability + dev compose ship first; Phase 2 builds on
that foundation.

---

End of V3 Phase 2 design. Implementation work splits naturally
into the 12 numbered deliverables in §13. Each is small enough to
review independently; the order in §13 reflects dependency
order (interfaces → adapters → migration → entrypoints → compose
→ docs).
