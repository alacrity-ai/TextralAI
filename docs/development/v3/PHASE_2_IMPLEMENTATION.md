# V3 Phase 2 — Implementation Steps

> Companion to `docs/v3/PHASE-2_DETAILED_DESIGN.md`. Concrete,
> ordered steps. A dev follows this end-to-end and at the close
> has shipped everything Phase 2 promises: every Cloudflare
> binding behind a runtime-agnostic interface, two adapter sets
> (CF + Node), a parallel Postgres migration tree, a full
> `docker-compose.yml` that brings up the self-host stack, and CI
> that exercises both runtimes.
>
> **No open questions.** Where the design doc left a choice open,
> this document picks one and stays with it.
>
> ## Status
>
> - **Steps 1-15: SHIPPED** + audit-remediated. Live worker version
>   `fbb53e11-...` (verify via `wrangler deployments list`). Test
>   suite at 323 passing | 8 skipped against the cf-pool target.
>   See `docs/v3/V3_PHASE_2_STEPS_1_15_AUDIT.md` for the audit
>   findings (all resolved). Notable architectural additions during
>   remediation:
>   - `Db.batch(statements: DbStatement[])` for atomic multi-write
>     primitives (CF: D1 batch; Node: BEGIN/COMMIT).
>   - `SparseSearch` interface; FTS5 SQL lifted out of
>     `db/chunks.ts` into `runtime/cf/fts5-sparse-search.ts`.
>   - Structural shapes `WorkersAiBinding`, `VectorizeIndexHandle`
>     keep CF-specific types out of `runtime/shared/interfaces.ts`.
>   - All 9 adapter slots in `Bindings` (db, blobs, kv, queue,
>     vectors, sparseSearch, containerInvoker, metrics, bg, hash)
>     are consumed end-to-end on the CF side.
> - **Steps 16-29: SHIPPED.** Postgres migration tree, full Node
>   adapter set, Hono node-server entrypoint, BRPOP ingest-consumer,
>   8 Node-side adapter test files (36 tests pass via testcontainers),
>   esbuild-bundled multi-stage Node 24 Dockerfile, full self-host
>   docker-compose, CI guard scripts (CF/Node import boundary), CI
>   matrix expansion (cf + node lanes), runtime-aware bootstrap
>   endpoint, `seed-self-host.ts`, `docs/SELF_HOSTING.md` operator
>   runbook, Scalar tag-description runtime conditionalization.
>   Cf-pool tests still 323 passing | 8 skipped (no regressions).
>
> Step listings below describe the as-shipped shape for every step.

---

## At completion, you will have

- A runtime-agnostic `Bindings` shape in
  `apps/api/src/runtime/shared/interfaces.ts` that replaces `Env`
  at every route boundary. `Env` (the CF-binding type) becomes a
  CF-runtime-only detail.
- **Nine** per-resource interfaces — `Db` (with `batch`),
  `BlobStore`, `KvStore`, `QueueProducer`, `ContainerInvoker`,
  `MetricsSink`, `BackgroundTasks`, `Hasher`, `SparseSearch` —
  each with a CF adapter under `runtime/cf/` and a Node adapter
  under `runtime/node/`. Plus the `VectorStoreFactory` and the
  structural shapes `WorkersAiBinding` and `VectorizeIndexHandle`
  that keep CF types out of the shared module.
- The 14 D1 helpers in `apps/api/src/db/*.ts` migrated from
  `db.prepare(sql).bind(...).first/all/run()` to
  `db.one/all/exec/transaction(...)`. The two allowlisted
  exceptions (`ingestion/lease.ts`, `audit/query-events.ts`) also
  migrated; the `tools/check-no-inline-d1.sh` guard collapses to
  just `apps/api/src/db/**`.
- The 6 `executionCtx.waitUntil` sites migrated to
  `c.env.bg.spawn(...)`.
- Streaming SHA-256 (`crypto.DigestStream` in
  `lib/r2-presign.ts`) replaced by `bindings.hash.sha256OfStream(...)`.
- Queue consumer body factored into
  `runIngestMessage(msg, bindings)`. CF wrapper iterates
  `batch.messages`; Node wrapper BRPOPs a Redis list.
- Container DO call sites migrated to
  `bindings.containerInvoker.invoke(...)`. The `IngestContainer`
  DO class moved to `runtime/cf/container.ts` (CF-only).
- A parallel Postgres migration tree
  (`apps/api/migrations/postgres/0001-0006_*.sql`) ported from the
  existing SQLite tree. A schema-diff test pins the two trees
  together; PRs that touch one MUST touch the other.
- `apps/api/Dockerfile` producing a Node container image with two
  entrypoints (`api`, `ingest-consumer`).
- `infrastructure/docker/docker-compose.yml` (full self-host
  stack: postgres + redis + qdrant + minio + api + ingest-worker +
  ingest). The Phase 1
  `infrastructure/docker/docker-compose.dev.yml` (Qdrant + ingest
  only) stays — it's the dev-only variant for Worker-on-CF +
  local-Qdrant workflows.
- Two CI guard scripts (`tools/check-no-cf-imports-in-node.sh`,
  `tools/check-no-node-imports-in-cf.sh`) preventing runtime
  bleed.
- CI matrix expanded to `[cf-pool, node] × [unit, integration]`.
- `docs/SELF_HOSTING.md` operator runbook.
- The cookbook validator passes against the self-host stack.
- `wrangler deploy --env dev` still produces a working V2 deploy
  (zero behavior change for CF tenants).

By the end of this guide a contributor can run
`docker compose -f infrastructure/docker/docker-compose.yml up`
on a clean checkout, point the cookbook validator at the
self-host stack, and pass all 8 patterns with no Cloudflare
account in the loop.

---

## What this implementation specifically does NOT do

- **No HA primitives.** Compose is single-instance for postgres,
  redis, qdrant, minio. Operators wire HA themselves; documented
  in `SELF_HOSTING.md` as a follow-on.
- **No K8s manifests / Helm charts.** Compose only.
- **No automatic V2 → V3 data migration tool.** §8 of the design
  documents a manual runbook (D1 dump → sed-rewrite → psql,
  `mc mirror` for R2 → MinIO, re-ingest under `mode='embed_only'`
  for vectors). One-button tooling is deferred.
- **No AI Gateway substitute shipped with the stack.** Self-host
  operators wire LiteLLM / Helicone / etc. themselves. We support
  any AIG-compatible proxy via `AI_GATEWAY_BASE_URL`.
- **No Workers AI parity.** Self-host operators are BYOK for all
  providers; the `workers_ai` provider 501s at resolve time.
- **No live Qdrant integration test in CI.** Adapter unit tests
  pin wire shape; full integration uses testcontainers in the
  Node CI lane only. CF-side keeps the existing mocked-fetch
  pattern.
- **No license-decision implementation.** §13 of the design lists
  this as a deliverable; the engineering work is to *record* the
  chosen license in `LICENSE` and `package.json`. The decision
  itself is product/legal, not in this implementation guide.

---

## Prerequisites

True at the end of Phase 1:

- `apps/api/src/retrieval/vector-store.ts` exposes
  `vectorStoreFor(env: Env, binding: VectorBinding)` with the
  exhaustive switch + `_exhaustive: never` guard.
- `apps/api/src/retrieval/adapters/{vectorize,qdrant,pinecone}.ts`
  each implement `VectorStore`.
- `apps/api/src/lib/uuidv5.ts` is the shared UUIDv5 helper.
- 14 D1 helpers live in `apps/api/src/db/*.ts`. The
  `tools/check-no-inline-d1.sh` guard allowlists two exceptions
  (`ingestion/lease.ts`, `audit/query-events.ts`).
- `apps/api/migrations/0001-0006_*.sql` exists; migration 0006 is
  the per-namespace vector backend column add.
- `infrastructure/docker/docker-compose.dev.yml` runs Qdrant +
  ingest locally for the `dev-stack` Make target.
- All 322 tests (8 skipped) pass on the CF runtime (vitest pool).

If any of those are not true, fix Phase 1 before starting Phase 2.

---

## Locked-in technology choices

### Postgres driver
**`pg` (node-postgres) ^8.x.** Used via a `pg.Pool` with
`max: 10` default. No Drizzle / Prisma / Kysely on top — the SQL
in `db/*.ts` is hand-written and we keep it that way. The
`PgDb` adapter does parameter substitution (`$1`, `$2` style)
inside `db.one/all/exec(...)`.

### Object storage SDK
**`@aws-sdk/client-s3` ^3.x.** Targets MinIO by default
(`MINIO_ENDPOINT=http://minio:9000`); any S3-compatible endpoint
works. Bucket name + region from env. We don't use the upload
manager; we use the same Worker-proxy upload shape as V2 (the
client PUTs to the api, the api PUTs to S3).

### Redis client
**`ioredis` ^5.x.** Standalone-mode default; sentinel/cluster
modes untested but client supports them — operator's call.

### Hono Node server
**`@hono/node-server` ^1.x.** The same Hono `app` from
`apps/api/src/index.ts` runs under both the Workers default
export and `serve({ fetch: app.fetch })`.

### Image base
**`node:24-alpine`** (matches the user's locked-in Node 24
toolchain). Multi-stage build: `node:24` builder runs tsc +
esbuild; `node:24-alpine` runtime carries only the bundle.

### Migration runner (Postgres)
**`node-pg-migrate` ^7.x.** Sequential SQL files. CLI:
`pnpm migrate-postgres up`. The migration tree
(`apps/api/migrations/postgres/`) carries the same 6 numbered
files as the SQLite tree.

### Schema-diff test
A vitest spec applies both trees against fresh Postgres + SQLite
instances (testcontainers + `better-sqlite3`), introspects each
schema (column types, indexes, foreign keys, constraints), and
fails on any non-equivalence. This is the drift detection guard.

### `Env` ↔ `Bindings` cohabitation strategy
**Additive first, replace last.** The `Bindings` interface
*extends* `Env` for the lifetime of the migration. Old code
calling `c.env.DB.prepare(...)` keeps compiling; new code calls
`c.env.db.one(...)`. Once every call site is migrated, `Env`
collapses to a CF-runtime-internal type and `Bindings` drops the
extension. This avoids a hard cut-over that breaks the build
mid-PR.

---

## Naming and locations

```
apps/api/
├── src/
│   ├── runtime/
│   │   ├── shared/
│   │   │   └── interfaces.ts                   ← Bindings + Db + BlobStore + ...
│   │   ├── cf/
│   │   │   ├── index.ts                        ← default export { fetch, queue }
│   │   │   ├── bindings.ts                     ← buildCfBindings(env, ctx)
│   │   │   ├── d1-db.ts
│   │   │   ├── r2-blob-store.ts
│   │   │   ├── kv-store.ts
│   │   │   ├── cf-queue.ts
│   │   │   ├── do-container-invoker.ts
│   │   │   ├── bg-tasks.ts
│   │   │   ├── digest-stream-hasher.ts
│   │   │   ├── ae-metrics.ts
│   │   │   ├── container.ts                    ← MOVED from src/lib/container.ts
│   │   │   └── queue-consumer.ts               ← processIngestQueue(batch, env)
│   │   └── node/
│   │       ├── index.ts                        ← serve({ fetch: app.fetch })
│   │       ├── bindings.ts                     ← buildNodeBindings(process.env)
│   │       ├── pg-db.ts
│   │       ├── s3-blob-store.ts
│   │       ├── redis-kv.ts
│   │       ├── redis-queue.ts
│   │       ├── http-container-invoker.ts
│   │       ├── bg-tasks.ts
│   │       ├── node-crypto-hasher.ts
│   │       ├── stdout-metrics.ts
│   │       └── workers/
│   │           └── ingest-consumer.ts          ← BRPOP loop entrypoint
│   ├── ingestion/
│   │   └── ingest-message.ts                   ← runIngestMessage(msg, bindings)
│   ├── routes/                                  ← migrated to consume Bindings
│   ├── db/                                      ← migrated to db.one/all/exec
│   ├── retrieval/                               ← unchanged
│   ├── synthesis/                               ← unchanged
│   ├── auth/                                    ← KV migrated
│   ├── observability/                           ← MetricsSink migrated
│   ├── providers/                               ← AIGateway runtime-split
│   ├── lib/
│   │   ├── r2-presign.ts                        ← sha256OfStream removed (moved to Hasher)
│   │   ├── secrets-store.ts                     ← KV migrated
│   │   ├── uuidv5.ts                            ← unchanged
│   │   └── container.ts                         ← REMOVED (moved to runtime/cf/)
│   ├── index.ts                                 ← OpenAPIHono construction only (no fetch/queue)
│   └── types.ts                                 ← Env stays for CF; Bindings is the canonical shape
├── migrations/
│   ├── sqlite/                                  ← MOVED from migrations/*.sql
│   │   └── 0001-0006_*.sql
│   └── postgres/
│       └── 0001-0006_*.sql                      ← NEW
├── Dockerfile                                   ← NEW
├── wrangler.toml                                ← main = src/runtime/cf/index.ts
└── scripts/
    ├── migrate-postgres.ts                      ← NEW (node-pg-migrate wrapper)
    └── validate-cookbook.ts                     ← unchanged surface; --backend already wired

infrastructure/docker/
├── docker-compose.dev.yml                       ← unchanged from Phase 1
└── docker-compose.yml                           ← NEW (full self-host stack)

.env.selfhost.example                            ← NEW (repo root)

tools/
├── check-no-inline-d1.sh                        ← Phase 1; allowlist collapses
├── check-no-cf-imports-in-node.sh               ← NEW
└── check-no-node-imports-in-cf.sh               ← NEW

docs/
└── SELF_HOSTING.md                              ← NEW operator runbook
```

---

## Step 1 — Define the runtime-agnostic interfaces

This is additive and safe — nothing consumes the new types yet.

### 1.1 Create `apps/api/src/runtime/shared/interfaces.ts`

The shipped interface module is the single source of truth — read
the canonical version at
`apps/api/src/runtime/shared/interfaces.ts` (≈275 lines). The
shape it ships with (post-Steps 1-15 + audit remediation) declares:

- **`Db`** with `one`, `all`, `exec`, `batch(statements:
  DbStatement[])`, `transaction`. The `batch` method is the
  atomic-multi-write primitive (D1 batch / Postgres BEGIN-COMMIT)
  used by `insertChunksBatch` and `deleteChunksByIds`.
- **`DbStatement`** = `{ sql: string; params: unknown[] }`.
- **`BlobStore`** with `put`, `get`, `head`, `delete`. `BlobBody`
  accepts `ReadableStream | ArrayBuffer | Uint8Array | string`;
  `BlobGet` exposes optional `size` (both R2 and S3 GET responses
  include byte size).
- **`KvStore`** with `get` (`type: 'json' \| 'text'`), `put` (with
  `ttlSeconds`), `delete`.
- **`QueueProducer`** with `send`.
- **`ContainerInvoker`** with `invoke({ job_id, attempt }) → {
  status, outcome?, error? }`. Returns enough for the runtime-
  agnostic queue body to decide ack/retry.
- **`MetricsSink`** with `write({ indexes, doubles, blobs })`.
- **`BackgroundTasks`** with `spawn(promise)`.
- **`Hasher`** with `sha256OfStream(stream)`.
- **`SparseSearch`** with `search(SparseSearchArgs) → Array<{ id,
  score }>`. CF impl runs SQLite FTS5; Node impl (Step 17) Postgres
  tsvector. The `match` field is a pre-built dialect-specific
  query expression.
- **`VectorStoreFactory`** with `forBinding(binding) → VectorStore`.
- **`AiGatewayConfig`** = `{ baseUrl, metadataHeaderPrefix:
  'cf-aig-' \| 'x-aig-', providerSegment }`. Built per-runtime.
- **`WorkersAiBinding`** = `{ run(model: string, args: unknown,
  options?: unknown): Promise<unknown> }`. Structural shape — CF
  assigns `env.AI` directly (the real `Ai` type satisfies it
  structurally); Node sets undefined.
- **`VectorizeIndexHandle`** — structural shape of the Vectorize V2
  binding's `upsert/query/deleteByIds`. CF assigns
  `env.VECTORIZE_OPENAI_LARGE` (cast through `unknown` to bridge
  parameter-variance). Node sets undefined.

The `Bindings` interface composes these:

```ts
export interface Bindings {
  // Data layer (9 adapter slots — all consumed end-to-end on CF)
  db: Db;
  blobs: BlobStore;
  kv: KvStore;
  queue: QueueProducer;
  vectors: VectorStoreFactory;
  sparseSearch: SparseSearch;
  containerInvoker: ContainerInvoker;
  metrics: MetricsSink;
  bg: BackgroundTasks;
  hash: Hasher;

  runtime: 'cf' | 'node';

  // CF-only optional bindings (structural shapes — no CF types)
  ai?: WorkersAiBinding;
  vectorize?: VectorizeIndexHandle;

  // Stateless config. `runtimeEnv` (not `env`) avoids name conflict
  // with the legacy `Env.ENV` field during the migration period.
  runtimeEnv: 'dev' | 'prod' | 'self-host';
  apiKeyPepper: string;
  internalHmacSecret?: string;
  adminBootstrapToken?: string;
  auditHashSalt?: string;
  workerInternalUrl?: string;

  aiGateway?: AiGatewayConfig;

  qdrantUrl?: string;
  qdrantApiKey?: string;
  pineconeApiKey?: string;
}
```

The `apps/api/src/types.ts:Env` type extends `Bindings` for the
duration of the migration. Routes type their Hono generic as
`<{ Bindings: Env; Variables: Variables }>` and pick up both old
(`c.env.DB`, `c.env.BLOBS`) and new (`c.env.db`, `c.env.blobs`)
shapes during the migration period. Post-Phase-2 cleanup drops
the legacy CF-binding fields from `Env` and routes flip to
`<{ Bindings: Bindings }>`.

### 1.2 Acceptance — Step 1

- [x] `pnpm -r typecheck` clean.
- [x] `pnpm -r lint` clean.
- [x] No file imports from `runtime/shared/interfaces.ts` yet —
      it's a leaf module that becomes a hub later.

---

## Step 2 — Move `lib/container.ts` into `runtime/cf/`

This is the only file in `src/lib/` that's hard-bound to a CF
runtime API (`@cloudflare/containers`). Moving it ahead of the
big binding refactor isolates the CF-only-ness up front.

### 2.1 Create `apps/api/src/runtime/cf/container.ts`

Copy `apps/api/src/lib/container.ts` verbatim to
`apps/api/src/runtime/cf/container.ts`. Update its `Env` import
path (`../../types.js` → still works from the new location, but
verify).

### 2.2 Update the `IngestContainer` re-export in `apps/api/src/index.ts`

Change line 39 from:

```ts
export { IngestContainer } from './lib/container.js';
```

to:

```ts
export { IngestContainer } from './runtime/cf/container.js';
```

### 2.3 Delete `apps/api/src/lib/container.ts`

```bash
rm apps/api/src/lib/container.ts
```

### Acceptance — Step 2

- [ ] `pnpm -r typecheck` clean.
- [ ] `pnpm -r lint` clean.
- [ ] `make test` — all tests pass.
- [ ] `wrangler deploy --env dev` succeeds (the DO class binding
      is still found at the same wrangler-toml-named name — only
      the import path changed).

---

## Step 3 — CF binding adapters

Create the eight CF adapters as new files. They wrap the existing
binding shapes; no behavior change yet because no caller consumes
them.

### 3.1 `apps/api/src/runtime/cf/d1-db.ts`

```ts
import type { Db } from '../shared/interfaces.js';

export class D1Db implements Db {
  constructor(private readonly d1: D1Database) {}

  async one<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    const row = await this.d1
      .prepare(sql)
      .bind(...(params as (string | number | null)[]))
      .first<T>();
    return row ?? null;
  }

  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const out = await this.d1
      .prepare(sql)
      .bind(...(params as (string | number | null)[]))
      .all<T>();
    return out.results ?? [];
  }

  async exec(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rowsAffected: number }> {
    const res = await this.d1
      .prepare(sql)
      .bind(...(params as (string | number | null)[]))
      .run();
    return { rowsAffected: res.meta.changes ?? 0 };
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // D1's binding API has no explicit BEGIN/COMMIT. Existing code
    // already operates without multi-statement transactions; this
    // is a no-op wrapper for shape parity with PgDb.
    return fn(this);
  }
}
```

### 3.2 `apps/api/src/runtime/cf/r2-blob-store.ts`

```ts
import type { BlobBody, BlobGet, BlobHead, BlobPutOpts, BlobStore } from '../shared/interfaces.js';

export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: BlobBody, opts?: BlobPutOpts): Promise<void> {
    await this.bucket.put(key, body, {
      ...(opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : {}),
      ...(opts?.metadata ? { customMetadata: opts.metadata } : {}),
    });
  }

  async get(key: string): Promise<BlobGet | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return {
      body: obj.body,
      ...(obj.httpMetadata?.contentType ? { contentType: obj.httpMetadata.contentType } : {}),
    };
  }

  async head(key: string): Promise<BlobHead | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return {
      size: obj.size,
      ...(obj.httpMetadata?.contentType ? { contentType: obj.httpMetadata.contentType } : {}),
      ...(obj.customMetadata ? { metadata: obj.customMetadata } : {}),
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
```

### 3.3 `apps/api/src/runtime/cf/kv-store.ts`

```ts
import type { KvStore } from '../shared/interfaces.js';

export class CfKvStore implements KvStore {
  constructor(private readonly kv: KVNamespace) {}

  async get<T = string>(key: string, opts?: { type?: 'json' | 'text' }): Promise<T | null> {
    if (opts?.type === 'json') {
      return (await this.kv.get<T>(key, 'json')) ?? null;
    }
    return ((await this.kv.get(key, 'text')) as T | null) ?? null;
  }

  async put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void> {
    await this.kv.put(key, value, opts?.ttlSeconds ? { expirationTtl: opts.ttlSeconds } : {});
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
```

### 3.4 `apps/api/src/runtime/cf/cf-queue.ts`

```ts
import type { QueueProducer } from '../shared/interfaces.js';

export class CfQueueProducer implements QueueProducer {
  constructor(private readonly q: Queue<unknown>) {}
  async send(message: unknown): Promise<void> {
    await this.q.send(message);
  }
}
```

### 3.5 `apps/api/src/runtime/cf/do-container-invoker.ts`

```ts
import type {
  ContainerInvokeResult,
  ContainerInvoker,
  ContainerOutcome,
} from '../shared/interfaces.js';

export class DoContainerInvoker implements ContainerInvoker {
  constructor(private readonly ns: DurableObjectNamespace) {}

  async invoke(args: { job_id: string; attempt: number }): Promise<ContainerInvokeResult> {
    const id = this.ns.idFromName(`job:${args.job_id}`);
    const stub = this.ns.get(id);
    const res = await stub.fetch('http://container/jobs/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (res.status >= 200 && res.status < 300) {
      const body = (await res.json()) as { outcome?: ContainerOutcome };
      return { status: res.status, ...(body.outcome ? { outcome: body.outcome } : {}) };
    }
    return { status: res.status, error: (await res.text()).slice(0, 200) };
  }
}
```

### 3.6 `apps/api/src/runtime/cf/bg-tasks.ts`

```ts
import type { BackgroundTasks } from '../shared/interfaces.js';

export class CfBackgroundTasks implements BackgroundTasks {
  constructor(private readonly ctx: ExecutionContext) {}
  spawn(promise: Promise<unknown>): void {
    this.ctx.waitUntil(promise);
  }
}
```

### 3.7 `apps/api/src/runtime/cf/digest-stream-hasher.ts`

```ts
import type { Hasher } from '../shared/interfaces.js';

export class DigestStreamHasher implements Hasher {
  async sha256OfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hashStream = new (globalThis as any).crypto.DigestStream('SHA-256');
    await stream.pipeTo(hashStream);
    const buf: ArrayBuffer = await hashStream.digest;
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}
```

### 3.8 `apps/api/src/runtime/cf/ae-metrics.ts`

```ts
import type { MetricsSink } from '../shared/interfaces.js';

export class AeMetricsSink implements MetricsSink {
  constructor(private readonly ae: AnalyticsEngineDataset) {}
  write(point: { indexes: string[]; doubles: number[]; blobs: string[] }): void {
    this.ae.writeDataPoint({
      indexes: point.indexes,
      doubles: point.doubles,
      blobs: point.blobs,
    });
  }
}

export class NoopMetricsSink implements MetricsSink {
  write(): void {}
}
```

`NoopMetricsSink` covers the case where AE binding is absent
(matches existing `if (!env.AE_METRICS) return;` behavior).

### Acceptance — Step 3

- [ ] All eight new files exist under `apps/api/src/runtime/cf/`.
- [ ] `pnpm -r typecheck` clean.
- [ ] `pnpm -r lint` clean.
- [ ] No code outside `runtime/` imports any of these adapters yet.
- [ ] `make test` — all 322+ tests still pass (zero behavior change).

---

## Step 4 — CF `Bindings` builder + entrypoint

Wire the adapters into a `Bindings` factory; create the new CF
entrypoint that calls it. The old `apps/api/src/index.ts` stays
in place during the transition (shipped two artifacts in parallel
during the migration phase).

### 4.1 Create `apps/api/src/runtime/cf/bindings.ts`

```ts
import type { Env } from '../../types.js';
import type { Bindings, VectorStoreFactory } from '../shared/interfaces.js';
import { vectorStoreFor } from '../../retrieval/vector-store.js';
import { D1Db } from './d1-db.js';
import { R2BlobStore } from './r2-blob-store.js';
import { CfKvStore } from './kv-store.js';
import { CfQueueProducer } from './cf-queue.js';
import { DoContainerInvoker } from './do-container-invoker.js';
import { CfBackgroundTasks } from './bg-tasks.js';
import { DigestStreamHasher } from './digest-stream-hasher.js';
import { AeMetricsSink, NoopMetricsSink } from './ae-metrics.js';

export function buildCfBindings(env: Env, ctx: ExecutionContext): Bindings {
  const factory: VectorStoreFactory = {
    forBinding: (b) => vectorStoreFor(env, b),
  };

  return {
    db: new D1Db(env.DB),
    blobs: new R2BlobStore(env.BLOBS),
    kv: new CfKvStore(env.CACHE),
    queue: new CfQueueProducer(env.INGEST_QUEUE),
    vectors: factory,
    containerInvoker: new DoContainerInvoker(env.INGEST_CONTAINER),
    metrics: env.AE_METRICS ? new AeMetricsSink(env.AE_METRICS) : new NoopMetricsSink(),
    bg: new CfBackgroundTasks(ctx),
    hash: new DigestStreamHasher(),
    runtime: 'cf',
    ai: env.AI,
    env: env.ENV,
    apiKeyPepper: env.API_KEY_PEPPER,
    ...(env.INTERNAL_HMAC_SECRET ? { internalHmacSecret: env.INTERNAL_HMAC_SECRET } : {}),
    ...(env.ADMIN_BOOTSTRAP_TOKEN ? { adminBootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN } : {}),
    ...(env.AUDIT_HASH_SALT ? { auditHashSalt: env.AUDIT_HASH_SALT } : {}),
    ...(env.WORKER_INTERNAL_URL ? { workerInternalUrl: env.WORKER_INTERNAL_URL } : {}),
    ...(env.AI_GATEWAY_BYPASS !== 'true' && env.CF_ACCOUNT_ID && env.AI_GATEWAY_ID
      ? {
          aiGateway: {
            baseUrl: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}`,
            metadataHeaderPrefix: 'cf-aig-' as const,
            providerSegment: (p: string) =>
              p === 'workers_ai' ? 'workers-ai' : p,
          },
        }
      : {}),
    ...(env.QDRANT_URL ? { qdrantUrl: env.QDRANT_URL } : {}),
    ...(env.QDRANT_API_KEY ? { qdrantApiKey: env.QDRANT_API_KEY } : {}),
    ...(env.PINECONE_API_KEY ? { pineconeApiKey: env.PINECONE_API_KEY } : {}),
  };
}
```

### 4.2 Defer Hono construction into `apps/api/src/app.ts`

Move the `OpenAPIHono` construction out of `apps/api/src/index.ts`
into a new `apps/api/src/app.ts` so both runtimes can import it:

```ts
// apps/api/src/app.ts — runtime-agnostic Hono app construction.
// Both runtime/cf/index.ts and runtime/node/index.ts import this.

import { OpenAPIHono } from '@hono/zod-openapi';
import type { Bindings, Variables } from './types.js';
// ... all the existing route imports from index.ts

export const app = new OpenAPIHono<{ Bindings: Bindings; Variables: Variables }>({
  defaultHook: (result, c) => {
    // ... unchanged from the existing index.ts
  },
});

// ... all the existing app.use / app.route / app.notFound / app.onError calls
//     from index.ts, verbatim.

export default app;
```

`apps/api/src/index.ts` becomes (transitional shape — keeps
working through the migration):

```ts
// V2-compatible default export. Re-exports the IngestContainer
// DO class for wrangler discovery; the real entrypoint logic
// lives in runtime/cf/index.ts (Phase 2).

export { IngestContainer } from './runtime/cf/container.js';

import app from './app.js';
import { processIngestQueue, type IngestQueueMessage } from './ingestion/queue-handler.js';
import type { Env } from './types.js';
import { buildCfBindings } from './runtime/cf/bindings.js';

export default {
  async fetch(req, env, ctx) {
    const bindings = buildCfBindings(env, ctx);
    return app.fetch(req, bindings, ctx);
  },
  async queue(batch, env) {
    // Note: queue handler runs without an ExecutionContext in the
    // current Workers runtime API. Build a Bindings that has a
    // no-op `bg.spawn` for that path.
    const bindings = buildCfBindings(env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext);
    await processIngestQueue(batch as MessageBatch<IngestQueueMessage>, bindings);
  },
} satisfies ExportedHandler<Env, IngestQueueMessage>;
```

(The queue handler signature changes in Step 11. For now leave
`processIngestQueue(batch, env)` as-is and the wiring above will
be revised then.)

### 4.3 Update `apps/api/src/types.ts`

Add `Bindings` re-export so consumers can write
`import type { Bindings } from './types.js';`:

```ts
// Existing Env interface stays put — CF-only callsites keep working.

export type { Bindings } from './runtime/shared/interfaces.js';
export type { Variables };  // existing
```

### Acceptance — Step 4

- [ ] `pnpm -r typecheck` clean.
- [ ] `pnpm -r lint` clean.
- [ ] `make test` — all tests pass.
- [ ] `wrangler deploy --env dev` produces a working deploy.
- [ ] `curl /healthz` against the live dev returns 200.
- [ ] Cookbook validator (any backend) passes against live dev.

---

## Step 5 — Migrate `c.env.DB.prepare(...)` to `c.env.db.one/all/exec(...)`

Largest mechanical migration. Done file by file. For the
14 D1-helper files in `src/db/*.ts`:

- Each function takes `db: D1Database` today; change parameter
  type to `db: Db` (from `'../runtime/shared/interfaces.js'`).
- Inside each function, rewrite `db.prepare(sql).bind(...).first<T>()`
  → `db.one<T>(sql, [params])` (and analogous for `.all()` /
  `.run()`).
- Callers (route handlers) currently pass `c.env.DB`; change to
  `c.env.db`. Easier: route handlers already have
  `Bindings { Bindings }` via Hono types, so `c.env.db` resolves
  at the type level once Step 4 is in place.

### 5.1 Migrate `apps/api/src/db/namespaces.ts`

Pattern (one example; the same shape applies to all 14 files):

**Before:**
```ts
export async function getNamespaceBySlug(
  db: D1Database,
  tenantId: string,
  slug: string,
): Promise<Namespace | null> {
  const row = await db
    .prepare(`SELECT * FROM namespaces WHERE tenant_id = ? AND slug = ? AND deleted_at IS NULL`)
    .bind(tenantId, slug)
    .first<NamespaceRow>();
  return row ? rowToNamespace(row) : null;
}
```

**After:**
```ts
import type { Db } from '../runtime/shared/interfaces.js';

export async function getNamespaceBySlug(
  db: Db,
  tenantId: string,
  slug: string,
): Promise<Namespace | null> {
  const row = await db.one<NamespaceRow>(
    `SELECT * FROM namespaces WHERE tenant_id = ? AND slug = ? AND deleted_at IS NULL`,
    [tenantId, slug],
  );
  return row ? rowToNamespace(row) : null;
}
```

Apply the same translation across:
- `admin-rate-limits.ts`
- `api-keys.ts`
- `chunks.ts`
- `documents.ts`
- `eval.ts`
- `jobs.ts`
- `namespaces.ts`
- `provider-keys.ts`
- `query-events.ts` (db helper file — distinct from
  `audit/query-events.ts`)
- `stage-attempts.ts`
- `tenants.ts`
- `upload-intents.ts`
- `usage-records.ts`
- `version-indexes.ts`

For the two D1 inline-SQL allowlisted exceptions:
- `apps/api/src/ingestion/lease.ts` — migrate the same way; use
  `db.one<LeaseRow>(sql, params)` for the SELECT and
  `db.exec(sql, params)` for the UPDATE.
- `apps/api/src/audit/query-events.ts` — same pattern; the
  redaction-aware UPDATE becomes `db.exec(sql, params)`.

After both files migrate, update
`tools/check-no-inline-d1.sh` to drop the two allowlist lines
(only `apps/api/src/db/**` remains allowlisted).

### 5.2 Update every D1-helper caller

Every callsite passing `c.env.DB` or `env.DB` becomes `c.env.db`
or `env.db` (from Bindings, not Env). Easier than it sounds — the
TypeScript compiler walks you through every affected line once
the helper signatures change.

Quick search list:
```bash
grep -rn "env\.DB\|c\.env\.DB" apps/api/src/ | wc -l
```
Expect ~80-100 hits (one per helper invocation). Replace each
verbatim.

### 5.3 Acceptance — Step 5

- [ ] `pnpm -r typecheck` clean.
- [ ] `pnpm -r lint` clean.
- [ ] `make test` — all tests pass.
- [ ] `bash tools/check-no-inline-d1.sh` passes with only
      `src/db/**` allowlisted (the two exceptions removed).
- [ ] Live deploy + cookbook validator against dev: green.

---

## Step 6 — Migrate `executionCtx.waitUntil` → `c.env.bg.spawn`

Six call sites. Each rewrite is one line.

### 6.1 The six sites

| File | Line | Before | After |
|---|---|---|---|
| `auth/middleware.ts` | 38 | `c.executionCtx.waitUntil(writeResolvedKey(...))` | `c.env.bg.spawn(writeResolvedKey(...))` |
| `auth/middleware.ts` | 46 | `c.executionCtx.waitUntil(updateLastUsedAt(...))` | `c.env.bg.spawn(updateLastUsedAt(...))` |
| `routes/query-stream.ts` | 412 | `c.executionCtx.waitUntil(...)` | `c.env.bg.spawn(...)` |
| `routes/internal/providers.ts` | 137 | `c.executionCtx.waitUntil(...)` | `c.env.bg.spawn(...)` |
| `routes/internal/ingest-write.ts` | 174 | `c.executionCtx.waitUntil(...)` | `c.env.bg.spawn(...)` |
| `routes/query.ts` | 579 | `c.executionCtx.waitUntil(...)` | `c.env.bg.spawn(...)` |

### 6.2 Update doc-comment in `auth/middleware.ts:10`

Replace `ctx.waitUntil` reference with `bg.spawn` so future
readers don't get confused about the abstraction layer.

### Acceptance — Step 6

- [ ] `grep -rn "executionCtx\.waitUntil" apps/api/src/` returns
      zero hits.
- [ ] `pnpm -r typecheck` clean; `pnpm -r lint` clean.
- [ ] `make test` — all pass.

---

## Step 7 — Migrate KV call sites

Three line-level call sites in two files. The `lib/secrets-store.ts`
helpers also take `env: Env` today; change to `bindings: Bindings`
or pass the `KvStore` directly.

### 7.1 `apps/api/src/lib/secrets-store.ts`

Change the helper to accept a `KvStore` instead of `Env`:

**Before** (line 59 area):
```ts
export async function readSecret(env: Env, key: string): Promise<string | null> {
  const kv = env.CACHE;
  // ... read logic
}
```

**After:**
```ts
import type { KvStore } from '../runtime/shared/interfaces.js';

export async function readSecret(kv: KvStore, key: string): Promise<string | null> {
  // ... read logic, calling `kv.get(...)` instead of `kv.get(...)` against KVNamespace
}
```

Update all callers (search for `readSecret(env, ...)` or
`readSecret(c.env, ...)` and pass `c.env.kv` instead).

### 7.2 `apps/api/src/auth/middleware.ts`

Three call sites; replace `c.env.CACHE` with `c.env.kv`. The
helpers `readResolvedKey` / `writeResolvedKey` (defined
elsewhere) also need their parameter types changed from
`KVNamespace` to `KvStore`.

### Acceptance — Step 7

- [ ] `grep -rn "env\.CACHE\|c\.env\.CACHE" apps/api/src/`
      returns zero hits.
- [ ] `pnpm -r typecheck` clean; `pnpm -r lint` clean.
- [ ] `make test` — all pass.

---

## Step 8 — Migrate R2 call sites

Three source files: `routes/documents.ts` (~10 calls),
`audit/query-events.ts` (1), `routes/internal/ingest-write.ts`
(1). All become `c.env.blobs.{put,get,head,delete}(...)`.

### 8.1 `apps/api/src/routes/documents.ts`

Replace each `env.BLOBS.put(...)` / `.get(...)` / `.head(...)` /
`.delete(...)` with `env.blobs.put(...)` etc. The `BlobStore`
interface is intentionally a near-clone of `R2Bucket` so the
shape change is mostly mechanical.

A subtle point: today's `R2Bucket.put(...)` takes
`{ httpMetadata: { contentType }, customMetadata: {} }` shape.
The `BlobStore.put(...)` interface flattens this to
`{ contentType, metadata }` for portability. Translate each call:

**Before:**
```ts
await env.BLOBS.put(key, body, {
  httpMetadata: { contentType: 'application/json' },
  customMetadata: { foo: 'bar' },
});
```

**After:**
```ts
await env.blobs.put(key, body, {
  contentType: 'application/json',
  metadata: { foo: 'bar' },
});
```

### 8.2 `apps/api/src/audit/query-events.ts`

Single call (line 205-area). Helper signature changes from
`env: Env` to `bindings: Bindings` (or just the `BlobStore`).

### 8.3 `apps/api/src/routes/internal/ingest-write.ts`

Single call (line 320-area). Same translation.

### Acceptance — Step 8

- [ ] `grep -rn "env\.BLOBS\|c\.env\.BLOBS" apps/api/src/`
      returns zero hits.
- [ ] `pnpm -r typecheck` clean; `pnpm -r lint` clean.
- [ ] `make test` — all pass.

---

## Step 9 — Migrate streaming SHA-256 to `Hasher`

`apps/api/src/lib/r2-presign.ts:sha256OfStream` uses the
Workers-only `crypto.DigestStream`. Move to `Bindings.hash`.

### 9.1 Delete `sha256OfStream` from `apps/api/src/lib/r2-presign.ts`

Strip lines 81-88. Drop the function entirely.

### 9.2 Update the (single) call site in `routes/documents.ts`

Find the `sha256OfStream(...)` call (in the finalize handler):

**Before:**
```ts
import { sha256OfStream } from '../lib/r2-presign.js';
// ...
const hash = await sha256OfStream(stream);
```

**After:**
```ts
// no import — the helper is reached via Bindings
// ...
const hash = await c.env.hash.sha256OfStream(stream);
```

### Acceptance — Step 9

- [ ] `grep -rn "sha256OfStream\|DigestStream" apps/api/src/`
      returns hits only in `runtime/cf/digest-stream-hasher.ts`
      and (later) `runtime/node/node-crypto-hasher.ts`.
- [ ] `pnpm -r typecheck` clean.
- [ ] Documents-route test still passes (finalize uploads).
- [ ] Live deploy: upload + finalize a 1MB file, verify SHA stored
      on the version row matches.

---

## Step 10 — Migrate Container DO call sites to `ContainerInvoker`

Two sites: `ingestion/queue-handler.ts` (production) and
`routes/dev/ingest-ping.ts` (dev/debug).

### 10.1 Migrate `routes/dev/ingest-ping.ts`

The dev ping route currently does:

```ts
const id = c.env.INGEST_CONTAINER.idFromName('ping');
const stub = c.env.INGEST_CONTAINER.get(id);
const res = await stub.fetch(...);
```

Change to:

```ts
const result = await c.env.containerInvoker.invoke({ job_id: 'ping', attempt: 0 });
// adjust the response handling to use result.status / result.outcome
```

(If the dev ping needs a custom path — i.e., not `/jobs/run` —
add a second method to `ContainerInvoker` like `pingFetch(path)`.
Inspect the file before changing to confirm the path.)

### 10.2 Defer `ingestion/queue-handler.ts` to Step 11

The queue handler also needs the consumer-body factor; do both
in Step 11 together.

### Acceptance — Step 10

- [ ] `grep -rn "INGEST_CONTAINER" apps/api/src/` shows hits only
      in `runtime/cf/`, `types.ts`, and `ingestion/queue-handler.ts`
      (which gets fixed in Step 11).
- [ ] `pnpm -r typecheck` clean.
- [ ] Live `/dev/ingest-ping` against deployed dev returns 200.

---

## Step 11 — Factor queue consumer body

The CF-specific batch loop + `msg.ack()` / `msg.retry()` shim
moves to the CF runtime. The per-message body becomes
`runIngestMessage(msg, bindings)`.

### 11.1 Create `apps/api/src/ingestion/ingest-message.ts`

```ts
// Runtime-agnostic per-message body. The CF queue-consumer wrapper
// loops batch.messages and translates the result into ack/retry;
// the Node BRPOP wrapper re-LPUSHes on retry or moves to a dead
// list when attempts are exceeded.

import type { Bindings, ContainerInvokeResult } from '../runtime/shared/interfaces.js';

export interface IngestQueueMessage {
  job_id: string;
  tenant_id: string;
  attempt: number;
}

export interface IngestMessageResult {
  ack: boolean;
  /** Optional reason for telemetry / dead-lettering decisions. */
  reason?: string;
  /** Container outcome when present. */
  outcome?: ContainerInvokeResult['outcome'];
}

export async function runIngestMessage(
  msg: IngestQueueMessage,
  bindings: Bindings,
): Promise<IngestMessageResult> {
  try {
    const r = await bindings.containerInvoker.invoke({
      job_id: msg.job_id,
      attempt: msg.attempt,
    });
    if (r.status >= 200 && r.status < 300) {
      if (r.outcome === 'fatal_failure') {
        console.warn('ingest_job_fatal', { job_id: msg.job_id });
      }
      return { ack: true, ...(r.outcome ? { outcome: r.outcome } : {}) };
    }
    if (r.status === 409 || r.status === 423) {
      // Lease taken / job already terminal.
      return { ack: true, reason: 'lease-or-terminal' };
    }
    console.error('ingest_container_5xx', {
      job_id: msg.job_id,
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
    });
    return { ack: false, reason: 'container-5xx' };
  } catch (e) {
    console.error('ingest_dispatch_failed', {
      job_id: msg.job_id,
      message: String((e as Error)?.message ?? e),
    });
    return { ack: false, reason: 'dispatch-error' };
  }
}
```

### 11.2 Create `apps/api/src/runtime/cf/queue-consumer.ts`

```ts
// CF wrapper: iterate a Workers MessageBatch, dispatch each message
// to runIngestMessage, then call msg.ack() / msg.retry().

import { runIngestMessage, type IngestQueueMessage } from '../../ingestion/ingest-message.js';
import type { Bindings } from '../shared/interfaces.js';

export async function processIngestQueue(
  batch: MessageBatch<IngestQueueMessage>,
  bindings: Bindings,
): Promise<void> {
  for (const msg of batch.messages) {
    const result = await runIngestMessage(msg.body, bindings);
    if (result.ack) msg.ack();
    else msg.retry();
  }
}
```

### 11.3 Delete `apps/api/src/ingestion/queue-handler.ts`

Its content is now split between `ingest-message.ts` (per-message
body) and `runtime/cf/queue-consumer.ts` (batch wrapper).

### 11.4 Update `apps/api/src/index.ts`

Replace `processIngestQueue` import + wiring:

```ts
// V2-compatible default export.
export { IngestContainer } from './runtime/cf/container.js';

import app from './app.js';
import { buildCfBindings } from './runtime/cf/bindings.js';
import { processIngestQueue } from './runtime/cf/queue-consumer.js';
import type { IngestQueueMessage } from './ingestion/ingest-message.js';
import type { Env } from './types.js';

export default {
  async fetch(req, env, ctx) {
    const bindings = buildCfBindings(env, ctx);
    return app.fetch(req, bindings, ctx);
  },
  async queue(batch, env) {
    const bindings = buildCfBindings(env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext);
    await processIngestQueue(batch as MessageBatch<IngestQueueMessage>, bindings);
  },
} satisfies ExportedHandler<Env, IngestQueueMessage>;
```

### 11.5 Migrate the Container DO call site in queue-handler

Already covered by the new `processIngestQueue` calling
`runIngestMessage` which calls `bindings.containerInvoker.invoke`.
The old `env.INGEST_CONTAINER.idFromName(...)` pattern is gone.

### Acceptance — Step 11

- [ ] `apps/api/src/ingestion/queue-handler.ts` deleted.
- [ ] `apps/api/src/ingestion/ingest-message.ts` exists.
- [ ] `apps/api/src/runtime/cf/queue-consumer.ts` exists.
- [ ] `pnpm -r typecheck` clean; `pnpm -r lint` clean.
- [ ] `make test` — all pass (existing queue-handler tests
      migrate to test `runIngestMessage` directly).
- [ ] Live deploy: register a doc + ingest, verify the job
      reaches `completed`.

---

## Step 12 — AI Gateway runtime split

`computeGateway()` becomes runtime-conditional via `Bindings.aiGateway`.

### 12.1 Update `apps/api/src/providers/registry.ts`

**Before:**
```ts
function computeGateway(env: Env, provider: string): GatewayConfig | undefined {
  if (env.AI_GATEWAY_BYPASS === 'true') return undefined;
  if (!env.CF_ACCOUNT_ID || !env.AI_GATEWAY_ID) return undefined;
  return {
    account_id: env.CF_ACCOUNT_ID,
    gateway_id: env.AI_GATEWAY_ID,
    provider: gatewayProviderFor(provider),
  };
}
```

**After:**
```ts
import type { Bindings } from '../runtime/shared/interfaces.js';

function computeGateway(bindings: Bindings, provider: string): GatewayConfig | undefined {
  if (!bindings.aiGateway) return undefined;
  return {
    base_url: bindings.aiGateway.baseUrl,
    metadata_header_prefix: bindings.aiGateway.metadataHeaderPrefix,
    provider: bindings.aiGateway.providerSegment(provider),
  };
}
```

The `GatewayConfig` shape changes from `{ account_id, gateway_id,
provider }` to `{ base_url, metadata_header_prefix, provider }`.
The downstream consumers (`apps/api/src/providers/openai-direct.ts`,
`anthropic.ts`, etc. — wherever the gateway URL gets stitched
together) need updates: instead of building
`https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/{provider}/...`,
build `${base_url}/${provider}/...`. The header prefix replaces
the hardcoded `cf-aig-`.

### 12.2 Update `resolve(env, args)` callers

`resolve()` now takes `bindings` instead of `env`. Search:

```bash
grep -rn "resolve(env\|resolve(c\.env" apps/api/src/
```

and update each call site.

### 12.3 Provider HTTP client header changes

In each provider file (`openai-direct.ts`, `anthropic.ts`,
`voyage.ts`, `cohere.ts`, etc.), replace literal `'cf-aig-metadata'`
with `${gateway.metadata_header_prefix}metadata`:

```ts
const headers: Record<string, string> = {
  ...(gateway?.metadata_header_prefix
    ? { [`${gateway.metadata_header_prefix}metadata`]: JSON.stringify(metadata) }
    : {}),
  // ... other headers
};
```

### Acceptance — Step 12

- [ ] `pnpm -r typecheck` clean; `pnpm -r lint` clean.
- [ ] `make test` — all pass.
- [ ] Live deploy + cookbook validator: gateway path still works
      (verify via Cloudflare AIG dashboard or via the
      `cf-aig-metadata` header on the live request).
- [ ] `AI_GATEWAY_BYPASS=true` verify: providers go direct.

---

## Step 13 — Workers AI runtime gating

`providers/registry.ts:67` constructs `WorkersAIBindingProvider(env.AI)`
unconditionally. Add a runtime gate.

### 13.1 Update the `workers_ai` switch arm

**Before:**
```ts
case 'workers_ai': {
  const p = new WorkersAIBindingProvider(env.AI);
  return { llm: p, embedding: p, options: opts };
}
```

**After:**
```ts
case 'workers_ai': {
  if (!bindings.ai) {
    throw new TextralError(
      'PROVIDER_UNAVAILABLE',
      501,
      'Workers AI not available in this deploy. ' +
        'Self-hosted Textral requires BYOK for all providers.',
    );
  }
  const p = new WorkersAIBindingProvider(bindings.ai);
  return { llm: p, embedding: p, options: opts };
}
```

Add the `PROVIDER_UNAVAILABLE` error code to
`packages/contracts/src/error-codes.ts` (if not already present).

### 13.2 Update `routes/dev/workers-ai-ping.ts`

The dev ping route reads `c.env.AI` directly. Either:
- Drop the route in self-host (gate at registration time on
  `bindings.runtime === 'cf'`), or
- Change to `c.env.ai` and 404 cleanly when undefined.

Pick the second option for diagnostic value.

### Acceptance — Step 13

- [ ] `pnpm -r typecheck` clean; `pnpm -r lint` clean.
- [ ] `make test` — all pass.
- [ ] Live deploy + workers-ai cookbook pattern still works.
- [ ] (Verified later in Step 21 / Step 23) Self-host stack
      returns 501 from `workers_ai` provider with the documented
      message.

---

## Step 14 — Namespace-create runtime gating for `vectorize`

`routes/namespaces.ts` POST handler needs an extra check.

### 14.1 Update the validator block

After the existing Phase 1 validation rules:

```ts
if (data.vector_backend === 'vectorize' && !c.env.ai) {
  throw new TextralError(
    'BAD_REQUEST',
    400,
    'Vectorize backend unavailable in this deploy (no Vectorize binding); ' +
      'pick `qdrant` or `pinecone`.',
  );
}
```

(`bindings.ai` co-presence implies a CF deploy with a Vectorize
binding; we use it as the proxy for "Vectorize is available".)

### 14.2 Add a test case

Append to `apps/api/test/namespace-vector-backend.test.ts`:

```ts
it('rejects vectorize when runtime has no Vectorize binding (self-host mode)', async () => {
  const e = env as unknown as Env;
  // Simulate a self-host runtime by clearing the Workers AI binding.
  // (In the test env, CACHE/Vectorize are absent already; the
  // important guard is the `bindings.ai` check.)
  // ... use a custom test setup that builds Bindings with ai: undefined
});
```

(Test wiring depends on how the test harness builds `Bindings`;
the cf-pool tests already use a real `env`, so this case may be
better covered in the Node-side integration tests added later.)

### Acceptance — Step 14

- [ ] `pnpm -r typecheck` clean; `pnpm -r lint` clean.
- [ ] `make test` — all pass.

---

## Step 15 — CF runtime regression check

Before touching the Node side, verify the CF runtime is fully
green.

### 15.1 Local checks

```bash
make typecheck && make lint && make test
```

### 15.2 Deploy + live e2e

```bash
make deploy-dev
LIVE_WORKER_URL=https://textral-api-dev.<account>.workers.dev \
LIVE_API_KEY=<dev-key> \
make test-live
```

Plus run the cookbook validator across all three backends:
```bash
LIVE_WORKER_URL=... LIVE_API_KEY=... \
  pnpm --filter @textral/api exec tsx scripts/validate-cookbook.ts --backend vectorize
# repeat for qdrant + pinecone
```

### 15.3 Spot-check `/openapi.json`

Confirm path / schema counts unchanged from Phase 1 baseline (26
paths, 30 schemas, 10 tags).

### Acceptance — Step 15

- [ ] All local checks green.
- [ ] All three cookbook backends pass against deployed dev.
- [ ] Test count: ≥ 322 passed (Phase 1 baseline preserved).
- [ ] OpenAPI surface unchanged.

---

## Step 16 — Migration tree split + Postgres port

### 16.1 Move the SQLite tree

```bash
mkdir -p apps/api/migrations/sqlite
git mv apps/api/migrations/0001_baseline.sql apps/api/migrations/sqlite/
git mv apps/api/migrations/0002_documents_jobs_chunks.sql apps/api/migrations/sqlite/
git mv apps/api/migrations/0003_phase5_enrichment.sql apps/api/migrations/sqlite/
git mv apps/api/migrations/0004_admin_rate_limits.sql apps/api/migrations/sqlite/
git mv apps/api/migrations/0005_eval.sql apps/api/migrations/sqlite/
git mv apps/api/migrations/0006_namespace_vector_backend.sql apps/api/migrations/sqlite/
```

### 16.2 Update `apps/api/wrangler.toml`

Three places (`[env.test]`, `[env.dev]`, `[env.prod]`):
```toml
migrations_dir = "migrations/sqlite"
```

### 16.3 Create `apps/api/migrations/postgres/`

Port each SQLite migration to Postgres syntax. Major translations:

| SQLite | Postgres |
|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` (or `BIGSERIAL`) |
| `TEXT` | `TEXT` (same) |
| `INTEGER` | `BIGINT` (Textral uses 64-bit timestamps) |
| `IFNULL(x, y)` | `COALESCE(x, y)` |
| `ON CONFLICT(col) DO NOTHING` | same (Postgres ≥9.5) |
| `ON CONFLICT(col) DO UPDATE SET ... WHERE excluded.x` | same |
| `JSON` columns (TEXT in SQLite) | `JSONB` |
| `CURRENT_TIMESTAMP` literal default | same |
| `CHECK(...)` | same |
| `CREATE INDEX IF NOT EXISTS` | same |
| `CREATE VIRTUAL TABLE chunks_fts USING fts5(...)` (`0002`) | **Replace with**: a generated `tsvector` column on `chunks` + a GIN index. See below. |

**FTS5 → tsvector migration.** SQLite's FTS5 virtual table has no
direct Postgres analogue. The Postgres `0002_documents_jobs_chunks.sql`
file replaces the FTS5 virtual table block with:

```sql
ALTER TABLE chunks ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;
CREATE INDEX chunks_tsv_idx ON chunks USING GIN (tsv);
```

The `chunks_fts` virtual table and its triggers (used to keep the
FTS index in sync with the `chunks` table) are SQLite-only — the
Postgres tree omits them entirely; the generated column +
trigger-free maintenance is what makes Postgres FTS work out of
the box.

Keep filenames identical (`0001_baseline.sql`, etc.) so the
schema-diff test pairs them by filename.

For each file:
1. Open the SQLite version.
2. Apply the translations above.
3. Save under `apps/api/migrations/postgres/`.

### 16.4 Add `apps/api/scripts/migrate-postgres.ts`

```ts
// node-pg-migrate wrapper. Reads PG_* env vars, applies all files
// in apps/api/migrations/postgres/ in numeric order.
import migrate from 'node-pg-migrate';

await migrate.default({
  databaseUrl: process.env.POSTGRES_URL ??
    `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}` +
    `@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DB}`,
  dir: 'migrations/postgres',
  direction: 'up',
  migrationsTable: '_pg_migrations',
});
```

### 16.5 Add Makefile targets

```makefile
migrate-postgres-local: ## Apply the postgres migration tree to a local pg
	$(PNPM) --filter @textral/api exec tsx scripts/migrate-postgres.ts

migrate-postgres-selfhost: ## Apply postgres migrations to the docker-compose pg
	docker compose -f infrastructure/docker/docker-compose.yml run --rm api \
	  node dist/scripts/migrate-postgres.js
```

### 16.6 Schema-diff test

Create `apps/api/test/migrations-schema-diff.test.ts`. The test:
1. Spins up a fresh Postgres via testcontainers; applies the
   postgres tree.
2. Spins up a fresh `better-sqlite3` instance; applies the
   sqlite tree.
3. Introspects both schemas (table list, column types, indexes,
   foreign keys, constraints).
4. Diffs the introspections; fails on any difference beyond
   acknowledged dialect mappings (`SERIAL` ↔ `INTEGER PK`,
   `JSONB` ↔ `TEXT`, etc.).

This test runs in the Node-side CI lane (Step 26).

### Acceptance — Step 16

- [ ] `apps/api/migrations/sqlite/` contains the 6 original files.
- [ ] `apps/api/migrations/postgres/` contains 6 ported files.
- [ ] `wrangler.toml` references `migrations/sqlite`.
- [ ] `pnpm migrate-postgres-local` (against a local docker pg)
      succeeds.
- [ ] Schema-diff test passes.
- [ ] `make migrate-dev` (against remote D1) still succeeds.

---

## Step 17 — Node binding adapters

Nine new adapters under `apps/api/src/runtime/node/`. These mirror
the CF adapters from Step 3 plus add `pg-sparse-search.ts` (the
Postgres counterpart of `runtime/cf/fts5-sparse-search.ts`).

**Pre-Step-17 design decision (J-1):** `db/chunks.ts:insertChunksBatch`
uses SQLite's `INSERT OR REPLACE INTO ...`, which has no Postgres
equivalent. **Before this step ships, rewrite that SQL to use
`INSERT ... ON CONFLICT (id) DO UPDATE SET ... = excluded.*`** —
which both SQLite (since 3.24) and Postgres support natively. The
rewrite is mechanical (~25 lines in one file).

### 17.1 `pg-db.ts`

```ts
import type { Pool, PoolClient } from 'pg';
import type { Db, DbStatement } from '../shared/interfaces.js';

export class PgDb implements Db {
  constructor(private readonly pool: Pool) {}

  async one<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    const r = await this.pool.query(translate(sql), params);
    return (r.rows[0] as T) ?? null;
  }

  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(translate(sql), params);
    return r.rows as T[];
  }

  async exec(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number }> {
    const r = await this.pool.query(translate(sql), params);
    return { rowsAffected: r.rowCount ?? 0 };
  }

  /** Wrap N statements in a single BEGIN/COMMIT/ROLLBACK so callers
   *  get atomic-batch semantics matching D1's `batch(...)`. */
  async batch(statements: DbStatement[]): Promise<void> {
    if (statements.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of statements) {
        await client.query(translate(s.sql), s.params);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txDb = makeTxDb(client);
      const result = await fn(txDb);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

function makeTxDb(client: PoolClient): Db {
  return {
    one: async (sql, params = []) => {
      const r = await client.query(translate(sql), params);
      return (r.rows[0] as never) ?? null;
    },
    all: async (sql, params = []) => {
      const r = await client.query(translate(sql), params);
      return r.rows as never;
    },
    exec: async (sql, params = []) => {
      const r = await client.query(translate(sql), params);
      return { rowsAffected: r.rowCount ?? 0 };
    },
    batch: async (statements) => {
      // Already inside a transaction — just sequence the statements.
      for (const s of statements) {
        await client.query(translate(s.sql), s.params);
      }
    },
    transaction: async () => {
      throw new Error('Nested transactions are not supported');
    },
  };
}

/** D1 helpers use ?-placeholders; Postgres uses $1, $2, ...
 *  Translate at the boundary so the helpers in `db/*.ts` don't
 *  fork by dialect. */
function translate(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
```

**Cookbook test for `batch`:** insert 100 rows via
`db.batch(stmts)` and observe that all 100 land or none do (force a
mid-batch failure with a duplicate-key conflict and assert
`rowsAffected = 0` on the table).

### 17.1b `pg-sparse-search.ts`

The Postgres counterpart to `runtime/cf/fts5-sparse-search.ts`.
Postgres has no native BM25, so this implementation uses
`tsvector` + `ts_rank` against a generated stored column.

**Schema requirement (Step 16's Postgres migration tree must
add):**
```sql
ALTER TABLE chunks ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;
CREATE INDEX chunks_tsv_idx ON chunks USING GIN (tsv);
```

**Adapter:**
```ts
import type { Db, SparseSearch, SparseSearchArgs }
  from '../shared/interfaces.js';

export class PgSparseSearch implements SparseSearch {
  constructor(private readonly db: Db) {}

  async search(args: SparseSearchArgs): Promise<Array<{ id: string; score: number }>> {
    if (args.version_ids.length === 0 || args.artifact_types.length === 0) {
      return [];
    }
    const versionPh = args.version_ids.map(() => '?').join(',');
    const artifactPh = args.artifact_types.map(() => '?').join(',');
    // ts_rank returns higher = better; we sort DESC for the topK.
    // The CF FTS5 impl returns lower bm25 = better; the abstraction
    // hides this — callers compare scores within a single arm only,
    // and the RRF fusion (in retrieval/rrf.ts) treats both as
    // ordinal lists where rank, not absolute score, drives the
    // fused result. Both impls return rows sorted best-first so
    // RRF's positional logic stays valid.
    const sql = `
      SELECT id,
             ts_rank(tsv, query) AS score
        FROM chunks,
             plainto_tsquery('english', ?) AS query
       WHERE tsv @@ query
         AND tenant_id = ?
         AND namespace_id = ?
         AND version_id IN (${versionPh})
         AND artifact_type IN (${artifactPh})
       ORDER BY score DESC
       LIMIT ?`;
    return await this.db.all<{ id: string; score: number }>(sql, [
      args.match,
      args.tenant_id,
      args.namespace_id,
      ...args.version_ids,
      ...args.artifact_types,
      args.top_k,
    ]);
  }
}
```

**Caller-side translation:** `apps/api/src/retrieval/fts5-query.ts`
currently builds an FTS5 MATCH expression
(`"foo" OR "bar" AND NEAR(...)`-style). The Node side will accept
the same caller-supplied `match: string` but interpret it as
`plainto_tsquery` input — Postgres' parser is more forgiving and
the FTS5 expressions degrade gracefully. The Step 17 PR includes a
`pg-query-translate.ts` helper that smooths over the niche FTS5
operators (`*` wildcards, NEAR, column qualifiers) that
`plainto_tsquery` doesn't accept.

**Cookbook fan-out:** the existing `fts5-query.test.ts` covers the
CF-side query builder. The Node-side test
(`pg-sparse-search.test.ts`) goes against testcontainers Postgres
with a known set of chunks and asserts a known top-K ordering.

### 17.2 `s3-blob-store.ts`

```ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { BlobBody, BlobGet, BlobHead, BlobPutOpts, BlobStore } from '../shared/interfaces.js';
import { Readable } from 'node:stream';

export class S3BlobStore implements BlobStore {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}

  async put(key: string, body: BlobBody, opts?: BlobPutOpts): Promise<void> {
    const Body =
      body instanceof ReadableStream ? Readable.fromWeb(body as never) :
      body instanceof Uint8Array ? body :
      new Uint8Array(body as ArrayBuffer);
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body,
      ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
      ...(opts?.metadata ? { Metadata: opts.metadata } : {}),
    }));
  }

  async get(key: string): Promise<BlobGet | null> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!r.Body) return null;
      const body = Readable.toWeb(r.Body as Readable) as ReadableStream<Uint8Array>;
      return {
        body,
        ...(r.ContentType ? { contentType: r.ContentType } : {}),
      };
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async head(key: string): Promise<BlobHead | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: r.ContentLength ?? 0,
        ...(r.ContentType ? { contentType: r.ContentType } : {}),
        ...(r.Metadata ? { metadata: r.Metadata } : {}),
      };
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
```

### 17.3 `redis-kv.ts`

```ts
import type Redis from 'ioredis';
import type { KvStore } from '../shared/interfaces.js';

export class RedisKvStore implements KvStore {
  constructor(private readonly redis: Redis) {}

  async get<T = string>(key: string, opts?: { type?: 'json' | 'text' }): Promise<T | null> {
    const v = await this.redis.get(key);
    if (v === null) return null;
    if (opts?.type === 'json') return JSON.parse(v) as T;
    return v as unknown as T;
  }

  async put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void> {
    if (opts?.ttlSeconds) await this.redis.set(key, value, 'EX', opts.ttlSeconds);
    else await this.redis.set(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
```

### 17.4 `redis-queue.ts`

```ts
import type Redis from 'ioredis';
import type { QueueProducer } from '../shared/interfaces.js';

const QUEUE_KEY = 'textral:ingest';

export class RedisQueueProducer implements QueueProducer {
  constructor(private readonly redis: Redis) {}

  async send(message: unknown): Promise<void> {
    await this.redis.lpush(QUEUE_KEY, JSON.stringify(message));
  }
}
```

### 17.5 `http-container-invoker.ts`

```ts
import type {
  ContainerInvokeResult,
  ContainerInvoker,
  ContainerOutcome,
} from '../shared/interfaces.js';

interface HttpContainerInvokerCfg {
  host: string;
  hmacSecret: string;
}

export class HttpContainerInvoker implements ContainerInvoker {
  constructor(private readonly cfg: HttpContainerInvokerCfg) {}

  async invoke(args: { job_id: string; attempt: number }): Promise<ContainerInvokeResult> {
    const body = JSON.stringify(args);
    const sig = await sign(body, this.cfg.hmacSecret);
    const res = await fetch(`http://${this.cfg.host}:8000/jobs/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-textral-internal-signature': sig,
      },
      body,
    });
    if (res.status >= 200 && res.status < 300) {
      const out = (await res.json()) as { outcome?: ContainerOutcome };
      return { status: res.status, ...(out.outcome ? { outcome: out.outcome } : {}) };
    }
    return { status: res.status, error: (await res.text()).slice(0, 200) };
  }
}

async function sign(body: string, secret: string): Promise<string> {
  // Match the existing internal-auth scheme used by the Container.
  // See apps/api/src/middleware/internal-auth.ts for the spec.
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

### 17.6 `bg-tasks.ts`

```ts
import type { BackgroundTasks } from '../shared/interfaces.js';

const DRAIN_TIMEOUT_MS = 30_000;

export class NodeBackgroundTasks implements BackgroundTasks {
  private readonly pending = new Set<Promise<unknown>>();

  spawn(promise: Promise<unknown>): void {
    this.pending.add(promise);
    promise
      .catch((e) => console.error('bg_task_failed', e))
      .finally(() => this.pending.delete(promise));
  }

  async drain(): Promise<void> {
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        if (this.pending.size > 0) {
          console.warn('bg_drain_timeout', { pending: this.pending.size });
        }
        resolve();
      }, DRAIN_TIMEOUT_MS),
    );
    await Promise.race([Promise.allSettled([...this.pending]), timer]);
  }
}
```

### 17.7 `node-crypto-hasher.ts`

```ts
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Hasher } from '../shared/interfaces.js';

export class NodeCryptoHasher implements Hasher {
  async sha256OfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const hash = createHash('sha256');
    const node = Readable.fromWeb(stream as never);
    for await (const chunk of node) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }
}
```

### 17.8 `stdout-metrics.ts`

```ts
import type { MetricsSink } from '../shared/interfaces.js';

export class StdoutMetricsSink implements MetricsSink {
  write(point: { indexes: string[]; doubles: number[]; blobs: string[] }): void {
    console.log(JSON.stringify({ kind: 'metric', ...point }));
  }
}
```

### Acceptance — Step 17

- [ ] All nine files exist under `apps/api/src/runtime/node/`
      (pg-db, pg-sparse-search, s3-blob-store, redis-kv,
      redis-queue, http-container-invoker, bg-tasks,
      node-crypto-hasher, stdout-metrics).
- [ ] `pnpm -r typecheck` clean (Node deps resolve via
      `package.json`).
- [ ] `pnpm -r lint` clean.
- [ ] `db/chunks.ts:insertChunksBatch` rewritten to use
      `INSERT ... ON CONFLICT (id) DO UPDATE SET ...` so the SQL
      runs on both SQLite and Postgres.

---

## Step 18 — Node entrypoint

### 18.1 Create `apps/api/src/runtime/node/bindings.ts`

```ts
import { Pool } from 'pg';
import Redis from 'ioredis';
import { S3Client } from '@aws-sdk/client-s3';
import type { Bindings, VectorStoreFactory } from '../shared/interfaces.js';
import { vectorStoreFor, type VectorBinding } from '../../retrieval/vector-store.js';
import type { Env } from '../../types.js';
import { PgDb } from './pg-db.js';
import { PgSparseSearch } from './pg-sparse-search.js';
import { S3BlobStore } from './s3-blob-store.js';
import { RedisKvStore } from './redis-kv.js';
import { RedisQueueProducer } from './redis-queue.js';
import { HttpContainerInvoker } from './http-container-invoker.js';
import { NodeBackgroundTasks } from './bg-tasks.js';
import { NodeCryptoHasher } from './node-crypto-hasher.js';
import { StdoutMetricsSink } from './stdout-metrics.js';

export interface NodeRuntimeContext {
  bindings: Bindings;
  bg: NodeBackgroundTasks;
  pgPool: Pool;
  redis: Redis;
  s3: S3Client;
}

export async function buildNodeBindings(env: NodeJS.ProcessEnv): Promise<NodeRuntimeContext> {
  const pgPool = new Pool({
    host: env.POSTGRES_HOST,
    port: Number(env.POSTGRES_PORT ?? 5432),
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB,
    max: Number(env.POSTGRES_MAX_CONNECTIONS ?? 10),
  });

  const redis = new Redis(env.REDIS_URL ?? 'redis://localhost:6379');

  const s3 = new S3Client({
    endpoint: env.MINIO_ENDPOINT ?? 'http://localhost:9000',
    region: env.S3_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: env.MINIO_ROOT_USER ?? 'textral',
      secretAccessKey: env.MINIO_ROOT_PASSWORD ?? 'textral_dev',
    },
    forcePathStyle: true,
  });

  const factory: VectorStoreFactory = {
    forBinding: (b: VectorBinding) =>
      vectorStoreFor(
        // Construct a minimal Env-like shape from the Node env vars.
        {
          QDRANT_URL: env.QDRANT_URL ?? '',
          ...(env.QDRANT_API_KEY ? { QDRANT_API_KEY: env.QDRANT_API_KEY } : {}),
          ...(env.PINECONE_API_KEY ? { PINECONE_API_KEY: env.PINECONE_API_KEY } : {}),
        } as unknown as Env,
        b,
      ),
  };

  const bg = new NodeBackgroundTasks();
  const db = new PgDb(pgPool);

  const bindings: Bindings = {
    db,
    blobs: new S3BlobStore(s3, env.MINIO_BUCKET ?? 'textral-blobs'),
    kv: new RedisKvStore(redis),
    queue: new RedisQueueProducer(redis),
    vectors: factory,
    sparseSearch: new PgSparseSearch(db),
    containerInvoker: new HttpContainerInvoker({
      host: env.CONTAINER_HOST ?? 'ingest',
      hmacSecret: env.INTERNAL_HMAC_SECRET ?? '',
    }),
    metrics: new StdoutMetricsSink(),
    bg,
    hash: new NodeCryptoHasher(),
    runtime: 'node',
    // `ai` and `vectorize` deliberately omitted — Node deploys
    // BYOK for inference (workers_ai 501s) and use `qdrant` /
    // `pinecone` for vector backends (vectorize gated at create).
    runtimeEnv: 'self-host',
    apiKeyPepper: env.API_KEY_PEPPER ?? '',
    ...(env.INTERNAL_HMAC_SECRET ? { internalHmacSecret: env.INTERNAL_HMAC_SECRET } : {}),
    ...(env.ADMIN_BOOTSTRAP_TOKEN ? { adminBootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN } : {}),
    ...(env.AUDIT_HASH_SALT ? { auditHashSalt: env.AUDIT_HASH_SALT } : {}),
    ...(env.WORKER_INTERNAL_URL ? { workerInternalUrl: env.WORKER_INTERNAL_URL } : {}),
    ...(env.AI_GATEWAY_BASE_URL
      ? {
          aiGateway: {
            baseUrl: env.AI_GATEWAY_BASE_URL,
            metadataHeaderPrefix: 'x-aig-' as const,
            providerSegment: (p: string) => p,
          },
        }
      : {}),
    ...(env.QDRANT_URL ? { qdrantUrl: env.QDRANT_URL } : {}),
    ...(env.QDRANT_API_KEY ? { qdrantApiKey: env.QDRANT_API_KEY } : {}),
    ...(env.PINECONE_API_KEY ? { pineconeApiKey: env.PINECONE_API_KEY } : {}),
  };

  return { bindings, bg, pgPool, redis, s3 };
}
```

### 18.2 Create `apps/api/src/runtime/node/index.ts`

```ts
// Self-host api entrypoint.
import { serve } from '@hono/node-server';
import app from '../../app.js';
import { buildNodeBindings } from './bindings.js';

const ctx = await buildNodeBindings(process.env);

const server = serve({
  fetch: (req) => app.fetch(req, ctx.bindings),
  port: Number(process.env.PORT ?? 8787),
});

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  server.close();
  await ctx.bg.drain();
  await ctx.pgPool.end();
  ctx.redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

### Acceptance — Step 18

- [ ] `pnpm -r typecheck` clean.
- [ ] `pnpm -r lint` clean.
- [ ] `pnpm --filter @textral/api exec tsc --noEmit src/runtime/node/index.ts`
      compiles cleanly.

---

## Step 19 — Node ingest-consumer entrypoint

### 19.1 Create `apps/api/src/runtime/node/workers/ingest-consumer.ts`

```ts
// Self-host queue consumer. BRPOP loop on the same Redis the api
// LPUSHes to. Decode message → call runIngestMessage → re-enqueue
// or dead-letter on failure.

import { buildNodeBindings } from '../bindings.js';
import { runIngestMessage, type IngestQueueMessage } from '../../../ingestion/ingest-message.js';

const QUEUE_KEY = 'textral:ingest';
const DEAD_KEY = 'textral:ingest:dead';
const MAX_ATTEMPTS = 3;
const POLL_TIMEOUT_SEC = 5;

const ctx = await buildNodeBindings(process.env);

let stopped = false;
const stop = async (signal: string) => {
  stopped = true;
  console.log(JSON.stringify({ event: 'consumer_shutdown', signal }));
  await ctx.bg.drain();
  await ctx.pgPool.end();
  ctx.redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

while (!stopped) {
  const popped = await ctx.redis.brpop(QUEUE_KEY, POLL_TIMEOUT_SEC);
  if (!popped) continue;
  const [, raw] = popped;
  let msg: IngestQueueMessage;
  try {
    msg = JSON.parse(raw) as IngestQueueMessage;
  } catch (e) {
    console.error('consumer_bad_message', { raw, message: String((e as Error).message) });
    await ctx.redis.lpush(DEAD_KEY, raw);
    continue;
  }
  const result = await runIngestMessage(msg, ctx.bindings);
  if (!result.ack) {
    if (msg.attempt + 1 >= MAX_ATTEMPTS) {
      await ctx.redis.lpush(DEAD_KEY, JSON.stringify({ ...msg, dead_reason: result.reason }));
      console.warn('consumer_dead_lettered', { job_id: msg.job_id, attempt: msg.attempt });
    } else {
      await ctx.redis.lpush(QUEUE_KEY, JSON.stringify({ ...msg, attempt: msg.attempt + 1 }));
    }
  }
}
```

### Acceptance — Step 19

- [ ] File exists.
- [ ] `pnpm -r typecheck` clean.
- [ ] `pnpm -r lint` clean.

---

## Step 20 — Node adapter unit tests

For each Node adapter, a vitest spec under
`apps/api/test/runtime/node/`:

- `pg-db.test.ts` — testcontainers Postgres; one of each method.
- `s3-blob-store.test.ts` — testcontainers MinIO; put/get/head/delete
  round-trip.
- `redis-kv.test.ts` — testcontainers Redis; TTL; get-missing.
- `redis-queue.test.ts` — testcontainers Redis; LPUSH + BRPOP
  round-trip via the consumer.
- `http-container-invoker.test.ts` — mocked `fetch`; HMAC header
  check.
- `bg-tasks.test.ts` — pure unit; spawn + drain semantics.
- `node-crypto-hasher.test.ts` — known-input → known-output
  vector against `crypto.subtle` for parity.
- `stdout-metrics.test.ts` — captures stdout and asserts shape.

### Acceptance — Step 20

- [ ] All eight tests pass under the Node-side vitest config (Step 26).

---

## Step 21 — Node integration tests

A Node-side `vitest` config (separate from the cf-pool one) runs
the same `apps/api/test/*.test.ts` route-level tests against a
testcontainers-backed stack (postgres + redis + qdrant + minio).
The cookbook validator runs against this stack as e2e.

### 21.1 Create `apps/api/vitest.node.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', 'test/live-smoke.test.ts'],
    setupFiles: ['./test/setup.node.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
```

### 21.2 Create `apps/api/test/setup.node.ts`

Sets up testcontainers fixtures (Postgres, Redis, MinIO, Qdrant)
shared across the Node-side suite. Uses `testcontainers` ^11.x.

### 21.3 `package.json` script

```json
"test:node": "vitest run --config vitest.node.config.ts"
```

### Acceptance — Step 21

- [ ] `pnpm --filter @textral/api test:node` passes against
      a clean testcontainers spin-up.
- [ ] Test count parity: every cf-pool test that's runtime-agnostic
      also passes under Node.

---

## Step 22 — `apps/api/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24 AS builder
WORKDIR /work
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages ./packages
RUN corepack enable && pnpm install --frozen-lockfile

COPY apps/api ./apps/api
COPY tsconfig.json ./
RUN pnpm --filter @textral/api build:node

# ── runtime stage ──────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=builder /work/apps/api/dist ./dist
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/apps/api/migrations ./migrations
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s \
  CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1))"
CMD ["node", "dist/runtime/node/index.js"]
```

### 22.1 Add the `build:node` script to `apps/api/package.json`

```json
"build:node": "tsc -p tsconfig.node.json && esbuild dist/**/*.js --bundle --platform=node --target=node24 --outdir=dist --allow-overwrite=true"
```

(Approach: tsc to JS first, then bundle with esbuild for clean
production deploy. The exact command can be tuned.)

### 22.2 Create `apps/api/tsconfig.node.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "esnext",
    "target": "es2022",
    "outDir": "dist",
    "rootDir": "src",
    "noEmit": false,
    "declaration": false,
    "types": ["node"]
  },
  "include": [
    "src/runtime/node/**/*",
    "src/runtime/shared/**/*",
    "src/app.ts",
    "src/routes/**/*",
    "src/db/**/*",
    "src/retrieval/**/*",
    "src/ingestion/**/*",
    "src/synthesis/**/*",
    "src/auth/**/*",
    "src/observability/**/*",
    "src/providers/**/*",
    "src/lib/**/*",
    "src/middleware/**/*",
    "src/openapi/**/*",
    "src/types.ts"
  ],
  "exclude": ["src/runtime/cf/**/*", "src/index.ts"]
}
```

The `exclude` is the key — the Node bundle never sees CF-only
code.

### Acceptance — Step 22

- [ ] `docker build -f apps/api/Dockerfile -t textral-api:dev .`
      succeeds.
- [ ] `docker run --rm textral-api:dev node -e "console.log('ok')"`
      runs.

---

## Step 23 — `infrastructure/docker/docker-compose.yml`

The full self-host stack. Lifted from §6 of the design doc with
the build context wired in.

### 23.1 Create `infrastructure/docker/docker-compose.yml`

(Copy verbatim from design doc §6; verified during Step 24.)

### 23.2 Create `.env.selfhost.example` at repo root

```
# Required
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
CONTAINER_HOST=ingest

# Worker secrets — generate via `openssl rand -hex 32`
INTERNAL_HMAC_SECRET=
ADMIN_BOOTSTRAP_TOKEN=
API_KEY_PEPPER=
AUDIT_HASH_SALT=

# Optional
PORT=8787
POSTGRES_MAX_CONNECTIONS=10
S3_REGION=us-east-1
QDRANT_API_KEY=
PINECONE_API_KEY=
AI_GATEWAY_BASE_URL=
WORKER_INTERNAL_URL=http://api:8787
```

### Acceptance — Step 23

- [ ] `docker compose -f infrastructure/docker/docker-compose.yml config`
      validates.
- [ ] `docker compose -f infrastructure/docker/docker-compose.yml up -d --wait`
      brings up all six services healthy in ≤60s on a 4-core,
      8GB-RAM dev machine.
- [ ] `curl http://localhost:8787/healthz` returns 200.
- [ ] Cookbook validator pointed at `http://localhost:8787` passes
      all 8 patterns.

### 23.3 Makefile targets

```makefile
selfhost-up: ## V3 Phase 2 — bring up the full self-host stack
	docker compose -f infrastructure/docker/docker-compose.yml up -d --wait

selfhost-down: ## V3 Phase 2 — stop and remove the self-host stack
	docker compose -f infrastructure/docker/docker-compose.yml down

selfhost-logs: ## Tail logs from the self-host stack
	docker compose -f infrastructure/docker/docker-compose.yml logs -f

selfhost-validate: ## Run the cookbook validator against the local self-host stack
	LIVE_WORKER_URL=http://localhost:8787 LIVE_API_KEY=$$SELFHOST_API_KEY \
	  $(PNPM) --filter @textral/api exec tsx scripts/validate-cookbook.ts
```

---

## Step 24 — CI guard scripts

Two new bash guards under `tools/`.

### 24.1 `tools/check-no-cf-imports-in-node.sh`

```bash
#!/usr/bin/env bash
# CI guard: refuse CF-runtime imports outside runtime/cf/*.
# Catches accidental `cloudflare:`, `@cloudflare/*`, Workers-specific
# globals, and binding types in shared / Node-runtime code.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PATTERN='cloudflare:|@cloudflare/|D1Database\b|R2Bucket\b|KVNamespace\b|DurableObject(?:Namespace|Stub)\b|Vectorize\b|MessageBatch\b|AnalyticsEngineDataset\b|crypto\.DigestStream'

HITS=$(grep -rEn "$PATTERN" apps/api/src/ \
  | grep -vE 'apps/api/src/runtime/cf/' \
  | grep -vE 'apps/api/src/runtime/shared/interfaces\.ts:.*types' \
  | grep -vE '\.md:' \
  || true)

if [ -n "$HITS" ]; then
  echo "ERROR: Cloudflare-runtime imports found outside runtime/cf/."
  echo "Move runtime-specific code into runtime/cf/, or shape the"
  echo "import through a Bindings interface in runtime/shared/interfaces.ts."
  echo
  echo "$HITS"
  exit 1
fi

echo "OK: no CF-runtime imports outside runtime/cf/"
```

The guard intentionally permits the binding-type names to appear
in `runtime/shared/interfaces.ts` (since `Bindings.ai?: Ai`
references the global `Ai` type). The exclusion in the second
`grep -v` allows that.

### 24.2 `tools/check-no-node-imports-in-cf.sh`

```bash
#!/usr/bin/env bash
# CI guard: refuse Node-runtime imports outside runtime/node/*.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PATTERN="from '(pg|ioredis|@aws-sdk/client-s3|node:[a-z]+|@hono/node-server)'"

HITS=$(grep -rEn "$PATTERN" apps/api/src/ \
  | grep -vE 'apps/api/src/runtime/node/' \
  | grep -vE '\.md:' \
  || true)

if [ -n "$HITS" ]; then
  echo "ERROR: Node-runtime imports found outside runtime/node/."
  echo
  echo "$HITS"
  exit 1
fi

echo "OK: no Node-runtime imports outside runtime/node/"
```

### 24.3 Wire into `make lint`

Update the `Makefile`'s `lint` target:
```makefile
lint: ## Lint all packages + placement guards
	$(PNPM) -r lint
	bash tools/check-no-inline-d1.sh
	bash tools/check-no-cf-imports-in-node.sh
	bash tools/check-no-node-imports-in-cf.sh
```

### Acceptance — Step 24

- [ ] All three guard scripts exit 0 on the current tree.
- [ ] `make lint` runs them all and exits 0.

---

## Step 25 — CI matrix expansion

GitHub Actions workflow gains a Node lane.

### 25.1 Update `.github/workflows/ci.yml`

```yaml
jobs:
  cf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: make typecheck
      - run: make lint
      - run: make test           # cf-pool tests
  node:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_USER: textral, POSTGRES_PASSWORD: textral_dev, POSTGRES_DB: textral }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U textral" --health-interval 5s
      redis:
        image: redis:7
        ports: ['6379:6379']
      minio:
        image: minio/minio:latest
        env: { MINIO_ROOT_USER: textral, MINIO_ROOT_PASSWORD: textral_dev }
        ports: ['9000:9000']
        options: '--entrypoint "minio server /data"'
      qdrant:
        image: qdrant/qdrant:latest
        ports: ['6333:6333']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @textral/api migrate-postgres-local
      - run: pnpm --filter @textral/api test:node
```

### Acceptance — Step 25

- [ ] CI workflow runs both `cf` and `node` jobs in parallel.
- [ ] Both jobs pass on `main` after Phase 2 lands.

---

## Step 26 — Node-side cookbook + smoke validation

The cookbook validator already exists from Phase 1
(`apps/api/scripts/validate-cookbook.ts`). It takes a base URL
and an API key.

### 26.1 Run against `make selfhost-up` locally

```bash
make selfhost-up
# Bootstrap a tenant + key in the running stack
docker compose -f infrastructure/docker/docker-compose.yml exec api \
  node -e 'await import("./dist/scripts/seed-self-host.js")'
# Note the API key it prints; export
export SELFHOST_API_KEY=<printed-key>
make selfhost-validate
```

### 26.2 Add a `seed-self-host.ts` script

Mirror of `apps/api/scripts/seed-dev.ts` but using the Node
bindings + Postgres. One-shot tenant + namespace + API key creation
for first-boot bootstrapping.

### Acceptance — Step 26

- [ ] All 8 cookbook patterns pass against the self-host stack.
- [ ] Audit shape matches CF deploy (`audit.tokens.*`,
      `audit.degradation_level`, `audit.reranker.executed` all
      present and identical-shape).

---

## Step 27 — `docs/SELF_HOSTING.md`

Operator-facing runbook. Sections:

1. **Prerequisites** — Docker 24+, 4 GB RAM minimum, 10 GB disk.
2. **Quickstart** — `cp .env.selfhost.example .env.selfhost`,
   fill in secrets (HMAC, salt, pepper, bootstrap token), run
   `make selfhost-up`. Curl `/healthz`. Bootstrap a tenant. Run
   the cookbook.
3. **Configuration reference** — every env var in
   `.env.selfhost.example`, what it controls, defaults.
4. **Vector backend choice** — Qdrant (default) vs Pinecone vs
   "external Qdrant Cloud + leave the local one off." Same
   guidance as Phase 1's `PHASE_1_QUICKSTART.md` but in the
   self-host context.
5. **AI Gateway proxy (optional)** — point at LiteLLM /
   Helicone / etc. via `AI_GATEWAY_BASE_URL`.
6. **TLS termination** — operator wires Caddy / Traefik /
   nginx in front; example Caddyfile.
7. **Backups** — `pg_dump`, `mc mirror`, Qdrant `snapshots` API.
8. **Upgrades** — `docker compose pull && docker compose up -d`,
   then `pnpm migrate-postgres-selfhost`.
9. **Migration from V2** — manual runbook (D1 export → sed →
   psql; R2 → MinIO via mc; re-ingest under `mode='embed_only'`
   for vectors).
10. **Troubleshooting** — common stacks of "service didn't come
    up" errors and the diagnostics for each.

### Acceptance — Step 27

- [ ] File exists.
- [ ] A first-time reader can follow the quickstart in ≤15
      minutes on a clean machine and reach a working query.

---

## Step 28 — Scalar docs runtime conditionalization

Two specific surfaces:

### 28.1 Provider Keys tag — Workers AI runtime conditional

Update `apps/api/src/openapi/tag-descriptions.ts:Provider Keys`:

> **Workers AI no-key tier** — available only in Cloudflare-hosted
> deployments. Self-hosted Textral requires BYOK for all
> providers. Self-host operators who want the same "no-key"
> experience can wire LiteLLM with a deploy-side OpenAI key as a
> tenant-shared default.

### 28.2 Namespaces tag — vector backend availability per runtime

Add to the existing Phase-1 §"Vector backend selection":

> Backend availability per runtime:
>
> | Backend | Cloudflare runtime | Self-host runtime |
> |---|---|---|
> | `vectorize` | ✓ default | ✗ — `BAD_REQUEST` at create |
> | `qdrant` | ✓ optional | ✓ default |
> | `pinecone` | ✓ optional | ✓ optional |

### Acceptance — Step 28

- [ ] Live `/openapi.json` rendered description carries both notes.
- [ ] Scalar UI shows them on Provider Keys + Namespaces tag pages.

---

## Step 29 — Phase 2 close-out

### 29.1 Cross-cutting verification

```bash
make typecheck && make lint && make test
make test:node
make selfhost-up
make selfhost-validate
make selfhost-down

make deploy-dev
make test-live
```

All green is the close-out gate.

### 29.2 Live e2e regression vs V2 baseline

Run the cookbook against deployed dev (CF runtime) AND against
local self-host. Capture the audit.tokens / audit.reranker /
audit.degradation_level for each pattern; diff. Identical shape
is the parity proof.

### 29.3 Final tree audit

```bash
bash tools/check-no-inline-d1.sh
bash tools/check-no-cf-imports-in-node.sh
bash tools/check-no-node-imports-in-cf.sh
grep -rn "executionCtx\.waitUntil" apps/api/src/        # → no hits
grep -rn "env\.DB\|c\.env\.DB" apps/api/src/             # → only runtime/cf/
grep -rn "env\.BLOBS\|c\.env\.BLOBS" apps/api/src/       # → only runtime/cf/
grep -rn "env\.CACHE\|c\.env\.CACHE" apps/api/src/       # → only runtime/cf/
grep -rn "env\.INGEST_QUEUE" apps/api/src/               # → only runtime/cf/
grep -rn "env\.INGEST_CONTAINER" apps/api/src/           # → only runtime/cf/
grep -rn "env\.AE_METRICS" apps/api/src/                 # → only runtime/cf/
grep -rn "env\.AI\b" apps/api/src/                       # → only runtime/cf/, types.ts, registry.ts
```

### 29.4 Phase 2 ships when

- [ ] All 29 step acceptance gates green.
- [ ] CF deploy + cookbook validator green.
- [ ] Self-host compose-up + cookbook validator green.
- [ ] CI matrix `[cf, node] × [unit, integration]` green.
- [ ] `docs/SELF_HOSTING.md` walks a fresh operator end-to-end.
- [ ] License recorded in `LICENSE` + `package.json`.
- [ ] `wrangler deploy --env dev` produces a working V2 deploy
      with no behavior change in `/openapi.json` user-visible
      content.

---

## Files added / modified — summary

**Added — Steps 1-15 (SHIPPED):**
- `apps/api/src/runtime/shared/interfaces.ts`
- `apps/api/src/runtime/cf/{bindings,d1-db,r2-blob-store,kv-store,cf-queue,do-container-invoker,bg-tasks,digest-stream-hasher,ae-metrics,container,queue-consumer,fts5-sparse-search}.ts`
- `apps/api/src/ingestion/ingest-message.ts`
- `apps/api/src/app.ts` (extracted from `index.ts`)

**Added — Steps 16-29 (PENDING):**
- `apps/api/src/runtime/node/{bindings,pg-db,pg-sparse-search,s3-blob-store,redis-kv,redis-queue,http-container-invoker,bg-tasks,node-crypto-hasher,stdout-metrics,index}.ts`
- `apps/api/src/runtime/node/workers/ingest-consumer.ts`
- `apps/api/migrations/postgres/0001-0006_*.sql`
- `apps/api/scripts/migrate-postgres.ts`
- `apps/api/scripts/seed-self-host.ts`
- `apps/api/test/runtime/node/{9 adapter test files}.ts`
- `apps/api/test/migrations-schema-diff.test.ts`
- `apps/api/test/setup.node.ts`
- `apps/api/vitest.node.config.ts`
- `apps/api/Dockerfile`
- `apps/api/tsconfig.node.json`
- `infrastructure/docker/docker-compose.yml`
- `.env.selfhost.example`
- `tools/check-no-cf-imports-in-node.sh`
- `tools/check-no-node-imports-in-cf.sh`
- `docs/SELF_HOSTING.md`
- `LICENSE` (per chosen license)

**Modified — Steps 1-15 (SHIPPED):**
- `apps/api/src/db/{14 helper files}.ts` — `D1Database` → `Db`
- `apps/api/src/db/chunks.ts` — `insertChunksBatch` /
  `deleteChunksByIds` use `Db.batch(DbStatement[])`;
  `sparseSearchChunks` removed (moved to `runtime/cf/fts5-sparse-search.ts`)
- `apps/api/src/ingestion/lease.ts` — `D1Database` → `Db`
- `apps/api/src/audit/query-events.ts` — `D1Database` → `Db`; BLOBS → blobs
- `apps/api/src/auth/middleware.ts` — KV + waitUntil migrations
- `apps/api/src/auth/tenant-cache.ts` — `KVNamespace` → `KvStore`
- `apps/api/src/lib/secrets-store.ts` — KV probe via `env.kv`; runtimeEnv
- `apps/api/src/lib/r2-presign.ts` — drop `sha256OfStream`
- `apps/api/src/retrieval/hybrid.ts` — sparse arm reads `env.sparseSearch.search`
- `apps/api/src/retrieval/vector-store.ts` — reads `env.vectorize`
- `apps/api/src/retrieval/vectorize-query.ts` — `c.env.vectors.forBinding`
- `apps/api/src/retrieval/adapters/vectorize.ts` — `VectorizeIndexHandle`
- `apps/api/src/routes/documents.ts` — BLOBS → blobs; hash
- `apps/api/src/routes/health.ts` — reads `runtimeEnv`
- `apps/api/src/routes/namespaces.ts` — vectorize runtime gate; `vectors.forBinding`
- `apps/api/src/routes/internal/ingest-write.ts` — BLOBS + waitUntil; chunks-batch via `Db.batch`; `vectors.forBinding`
- `apps/api/src/routes/{query,query-stream,internal/providers}.ts` — waitUntil
- `apps/api/src/routes/dev/{ingest-ping,workers-ai-ping}.ts` — runtime + AI gating
- `apps/api/src/ingestion/dispatch.ts` — `c.env.queue.send`
- `apps/api/src/routes/ingestion-jobs.ts` — `c.env.queue.send`
- `apps/api/src/routes/admin/enrichment-runs.ts` — `c.env.queue.send`
- `apps/api/src/observability/metrics.ts` — reads `bindings.metrics`
- `apps/api/src/providers/registry.ts` — Workers AI 501 gate; AI Gateway runtime split
- `apps/api/src/providers/types.ts` — `GatewayConfig` shape (`base_url`, `metadata_header_prefix`)
- `apps/api/src/providers/ai-gateway.ts` — `gatewayMetadataHeader` helper
- `apps/api/src/providers/{anthropic,workers-ai-binding}.ts` — header prefix; `WorkersAiBinding`
- `apps/api/src/providers/lib/http-client.ts` — header prefix
- `apps/api/src/openapi/components.ts` — `HealthResponse` env adds `'self-host'`
- `apps/api/src/index.ts` — CF entrypoint shell; wraps env in `buildCfBindings`
- `apps/api/src/types.ts` — `Env extends Bindings`; `PHASE_2_CLEANUP_TODO` markers
- `tools/check-no-inline-d1.sh` — drop the two allowlisted exceptions
- `apps/api/test/setup.ts` — patches env with `buildCfBindings`; stubs `vectorize`
- `apps/api/test/registry.test.ts` — fakeEnv populates `aiGateway`, `ai`; +501 test
- `apps/api/test/observability-metrics.test.ts` — uses `MetricsSink` shape
- `apps/api/test/ai-gateway.test.ts` — uses new `GatewayConfig` shape
- `apps/api/test/http-client.test.ts` — uses new `GatewayConfig` shape
- `apps/api/test/retrieval/vector-store-selector.test.ts` — populates `vectorize` field

**Modified — Steps 16-29 (PENDING):**
- `apps/api/wrangler.toml` — `migrations_dir = migrations/sqlite`
- `apps/api/package.json` — `build:node`, `test:node`, `migrate-postgres-*` scripts; pg + ioredis + @aws-sdk/client-s3 + @hono/node-server + node-pg-migrate + testcontainers deps
- `apps/api/src/db/chunks.ts` — `INSERT OR REPLACE` →
  `INSERT ... ON CONFLICT (id) DO UPDATE SET ...` (J-1 follow-up)
- `Makefile` — selfhost-* + migrate-postgres-* targets; lint guards extended
- `.github/workflows/ci.yml` — add `node` job

**Deleted — Steps 1-15:**
- `apps/api/src/lib/container.ts` (moved to `runtime/cf/container.ts`)
- `apps/api/src/ingestion/queue-handler.ts` (replaced by
  `ingestion/ingest-message.ts` + `runtime/cf/queue-consumer.ts`)

**Moved — Step 16:**
- `apps/api/migrations/*.sql` → `apps/api/migrations/sqlite/`

---

End of V3 Phase 2 implementation steps. Each step has a clear
acceptance gate. Steps 1-15 land the abstractions on the CF
runtime (zero behavior change for V2 tenants); 16 splits
migrations; 17-29 land the Node runtime. The order is dependency-
sound: every step's prerequisites are completed by earlier steps.
