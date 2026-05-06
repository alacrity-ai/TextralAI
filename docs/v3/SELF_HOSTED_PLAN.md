# Self-Hosted Plan — escaping Cloudflare lock-in

## Problem

Textral v2's MVP is a single-vendor deployment. Every layer of the
stack is bound to Cloudflare-specific infrastructure:

| Layer | Today | Lock-in shape |
|-------|-------|---------------|
| Worker runtime | Cloudflare Workers (V8 isolate) | `executionCtx.waitUntil`, scheduled handlers, request lifecycle |
| Metadata DB | D1 (SQLite-flavored) | `env.DB` binding, wrangler-managed migrations, SQLite dialect |
| Vector store | Vectorize V2 | `env.VECTORIZE_OPENAI_LARGE` binding |
| Object store | R2 | `env.BLOBS` binding (S3-compatible API but bound at the runtime) |
| Cache | Workers KV | `env.CACHE` binding |
| Queue | Cloudflare Queues | `env.INGEST_QUEUE` binding + Worker-as-consumer |
| Container orch | Cloudflare Containers (Durable Object-managed) | `env.INGEST_CONTAINER`, DO-pinned instances |
| AI Gateway | Cloudflare AIG | `gateway.ai.cloudflare.com/v1/...` URL prefix |
| No-key inference | Workers AI | `env.AI` binding |
| Secrets | Cloudflare Secrets Store (KV fallback today) | `env.CACHE` |

That's nine layers. Even with the post-Phase-5 audit's abstraction
work (the `VectorStore` interface, the `src/db/*.ts` SQL layer + CI
guard), the runtime itself + most bindings are bare CF.

**Why this matters:**

1. **Enterprise sales.** Every enterprise procurement process asks
   "can we self-host this?" Today the answer is no. That kills
   regulated-industry deals (finance, healthcare, government,
   sovereign-cloud requirements like EU GDPR or US FedRAMP),
   air-gapped environments, and any tenant whose security review
   forbids new SaaS dependencies.
2. **Competitive moat.** RAG-as-a-service competitors are mostly
   hosted-only. A self-hostable Textral is a real differentiator.
3. **Tenant-trust.** "We're vendor-locked to Cloudflare" raises the
   "what if Cloudflare decides we violated TOS?" risk for tenants.
4. **Developer experience.** A contributor today needs a Cloudflare
   account + a wrangler login + several bindings provisioned to
   bring the stack up. A `docker-compose up` would shrink that to
   minutes.

## What v1 already proved

The v1 textral repo (the "book-centric" predecessor sitting at the
root of `/home/leif/textral`, `apps/api` + `apps/rag-core` +
`apps/frontend`) was already fully self-hosted. Its
`infrastructure/docker/docker-compose.yml` runs:

| Service | Image | Role |
|---------|-------|------|
| `postgres` | `postgres:16` | Metadata DB (replaces D1) |
| `redis` | `redis:7` | Cache + ingestion queue (replaces KV + CF Queues) |
| `qdrant` | `qdrant/qdrant:latest` | Vector store (replaces Vectorize) |
| `minio` | `minio/minio:latest` | S3-compatible blob store (replaces R2) |
| `api` | local Node build | API surface (replaces the Worker) |
| `rag-core` | local Python/FastAPI build | Ingestion pipeline (≈ today's `apps/ingest`) |
| `frontend` | local React build | Admin UI (item #2 in `NEXT_MOST_IMPORTANT_THINGS.md`) |

Volumes: `pgdata`, `redisdata`, `qdrantdata`, `miniodata`. One
bridge network: `textral-net`. Health checks on every service.

**Why this is decisive evidence:** an earlier iteration of this
exact product already worked self-hosted with this exact set of
substrates. We're not designing a new system; we're porting v2's
features onto v1's runtime shape. The dependency graph, the
operational model, the docker-compose layout — they're all known
to work.

The v1 ingestion worker used a **Redis list** as the queue
(`BRPOP` consumer in `apps/rag-core/app/workers/ingestion_worker.py`).
That collapses two CF dependencies (KV + Queues) into one
substrate (Redis), and it's the same pattern we'd use in v2.

---

## Phase 1 — Pluggable vector store + dev docker-compose

**Goal:** support Qdrant and Pinecone alongside Vectorize. Bring up
a `docker-compose` that runs the api Worker (via `wrangler dev
--remote`), the ingest Container, and Qdrant locally — so contributors
can iterate without round-tripping every change to the deployed
dev environment. CF still owns D1 / R2 / Queues / AI bindings.

### Why this first

- The post-Phase-5 audit already extracted `VectorStore` as an
  interface in `apps/api/src/retrieval/vector-store.ts`. There's
  exactly one `VectorizeV2Adapter` and a `vectorStoreFor(env,
  embeddingProfile)` selector. Adding two more adapters is
  ~80% mechanical.
- Pinecone is the most-asked-for managed alternative; Qdrant is
  the most-asked-for self-hostable alternative. Together they
  cover the two most common "we need to switch" requests.
- Local Qdrant in docker-compose unblocks faster contributor
  workflows and faster CI integration tests — independent of the
  full self-host story.
- Phase 1's blast radius is small: only the read+write paths
  through `vector-store.ts` change. D1, R2, Queues, AI bindings,
  the Worker runtime — all untouched.

### Concrete work

#### 1.1 — Qdrant adapter

`apps/api/src/retrieval/vector-store.ts` currently has:

```ts
class VectorizeV2Adapter implements VectorStore { ... }
function vectorStoreFor(env, embeddingProfile): VectorStore { ... }
```

Add a sibling `QdrantAdapter`. Qdrant's REST API is documented at
`<host>/collections/{name}/points/search` (dense),
`/scroll` (filter-by-metadata), `/upsert` (write). Map our
`VectorStore` methods 1:1.

Required env additions (`Env` interface in `apps/api/src/types.ts`):

```ts
QDRANT_URL?: string;       // e.g. http://qdrant:6333 (compose) or https://...
QDRANT_API_KEY?: string;   // optional for local; required for cloud Qdrant
```

The `vectorStoreFor` selector reads a new namespace-level field
`namespaces.vector_backend` (`'vectorize' | 'qdrant' | 'pinecone'`)
and dispatches. Default is `'vectorize'` for back-compat with
existing tenants. Add a D1 migration `0006_namespace_vector_backend.sql`.

#### 1.2 — Pinecone adapter

Same shape. Pinecone's Serverless API:
- `https://<index>-<project>.svc.<region>.pinecone.io/query` (search)
- `/vectors/upsert`, `/vectors/delete`, `/vectors/fetch`

Required env additions:

```ts
PINECONE_API_KEY?: string;
PINECONE_ENVIRONMENT?: string;
PINECONE_INDEX_HOST_TEMPLATE?: string;
```

The Pinecone API key is in `DO_NOT_COMMIT.md` (or will be added
there) for end-to-end validation.

#### 1.3 — Per-namespace vector backend selection

Migration:

```sql
ALTER TABLE namespaces ADD COLUMN vector_backend TEXT NOT NULL DEFAULT 'vectorize';
ALTER TABLE namespaces ADD COLUMN vector_index_name TEXT;
```

`POST /v1/namespaces` accepts `vector_backend: 'vectorize' |
'qdrant' | 'pinecone'` + optional `vector_index_name`. The
namespace's choice is locked in at creation; switching backends
after data is indexed requires `mode='embed_only'` re-ingest under
a new namespace (documented in the Namespaces tag).

#### 1.4 — Docker-compose for local dev

New `infrastructure/docker/docker-compose.dev.yml`:

```yaml
services:
  qdrant:
    image: qdrant/qdrant:latest
    ports: ["6333:6333", "6334:6334"]
    volumes: [qdrantdata:/qdrant/storage]
    healthcheck: ...

  ingest:
    build:
      context: ../..
      dockerfile: apps/ingest/Dockerfile
    ports: ["8000:8000"]
    env_file: ../../.env.local
    environment:
      WORKER_INTERNAL_URL: ${WORKER_INTERNAL_URL}      # the deployed dev Worker
      INTERNAL_HMAC_SECRET: ${INTERNAL_HMAC_SECRET}
    healthcheck: ...

volumes:
  qdrantdata:

networks:
  textral-dev: { driver: bridge }
```

The api Worker stays under `wrangler dev --remote --env dev`,
which gives it real CF bindings (D1/R2/Queues/AI) but runs the
Worker code locally. The Worker reaches local Qdrant at
`http://host.docker.internal:6333` (via `wrangler dev`'s host
networking).

A new `make dev-stack` target brings the whole thing up:

```makefile
dev-stack:
	docker-compose -f infrastructure/docker/docker-compose.dev.yml up -d
	(cd apps/api && pnpm exec wrangler dev --remote --env dev) &
	@echo "stack up: api=http://localhost:8787, qdrant=http://localhost:6333, ingest=http://localhost:8000"
```

#### 1.5 — Validation harness

Extend `apps/api/scripts/validate-cookbook.ts` to run against a
`vector_backend=qdrant` namespace and a `vector_backend=pinecone`
namespace. Each cookbook pattern asserts identical behaviour
across the three backends. CI gate: any backend that breaks parity
is a release blocker.

### Phase 1 scope estimate

| Task | Effort |
|------|--------|
| 1.1 Qdrant adapter + tests | 3 days |
| 1.2 Pinecone adapter + tests | 3 days |
| 1.3 Namespace-level backend selection (migration + route + Zod) | 1.5 days |
| 1.4 docker-compose.dev.yml + `make dev-stack` | 1 day |
| 1.5 Cookbook parity harness | 1.5 days |
| Docs (Provider Keys + Namespaces tag updates) | 0.5 day |
| **Total** | **~2 weeks** |

### Phase 1 acceptance criteria

- [ ] `POST /v1/namespaces` accepts `vector_backend` ∈
      `vectorize | qdrant | pinecone`.
- [ ] All cookbook patterns pass against all three backends.
- [ ] `make dev-stack` brings up Qdrant + ingest locally and
      `wrangler dev --remote` connects to it for vector reads/writes.
- [ ] The existing `tests/check-no-inline-d1.sh` style guard, the
      docs-regression test, and the typecheck/lint sweep all stay
      green.
- [ ] Docs updated: Provider Keys tag's table now lists "Vector
      stores" alongside "Provider Keys"; Namespaces tag explains
      backend selection.

---

## Phase 2 — Full self-host portability

**Goal:** ship a `docker-compose.yml` that brings up an entire
working Textral stack with **zero** Cloudflare dependency. From
that point, lift-and-shift to a VM, K8s, ECS, Azure Container
Apps, or any other Docker-compatible runtime is mechanical.

### Why this second

Phase 2 is large because it touches every layer. We do it after
Phase 1 because:

1. Phase 1 derisks the vector store layer (the most-likely-to-have-
   surprises layer) before we tear up the runtime.
2. Phase 2 should be triggered by a real customer ask. A qualified
   enterprise prospect saying "we'll sign if you can deploy on-prem"
   tells us their **actual** constraints (Postgres flavor? K8s vs
   ECS vs VMware? air-gapped? data residency in a specific region?).
   Without that signal we'd guess wrong on a half-dozen abstraction
   shapes.

### Substrate map (target shape, lifted from v1)

| v2 today | Phase-2 substrate | Notes |
|----------|-------------------|-------|
| Cloudflare Workers (V8) | **Node 24** (Hono runs portably) | Replace `executionCtx.waitUntil` with `Promise.allSettled` + lifecycle hooks. Replace scheduled handlers with `node-cron`. |
| D1 | **Postgres 16** | Drizzle or Kysely as the SQL builder. Migration runner replaces `wrangler d1 migrations`. |
| Workers KV | **Redis 7** | Auth-resolver cache + Secrets Store fallback both move to Redis. |
| R2 | **MinIO** (S3-compatible) | `@aws-sdk/client-s3` works against MinIO unchanged. |
| Cloudflare Queues | **Redis lists** (BRPOP), exactly v1's pattern | One substrate handles both cache + queue, like v1. SQS/RabbitMQ optional later. |
| `IngestContainer` (DO-managed) | **Standalone container** running the Python ingest service, polled from the Node api via the same internal back-channel | The HMAC contract stays identical; only the orchestrator changes. |
| AI Gateway | **Optional layer**. Self-hosted deploys call providers directly | An `ai_gateway_url` config field; if set, route through it; if not, direct. |
| Workers AI binding | **Removed in self-host mode** | The `workers_ai` provider tier requires a CF binding. In self-host mode it's hidden from the provider list. Tenants must BYOK. |

### Concrete work, broken down

#### 2.1 — Database abstraction + Postgres adapter

The `src/db/*.ts` helpers all use D1's `prepare/bind/run` /
`first` / `all` API. Migrate to a thin `db` interface:

```ts
interface Db {
  one<T>(sql: string, params: unknown[]): Promise<T | null>;
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
  exec(sql: string, params: unknown[]): Promise<{ rowsAffected: number }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}
```

Two implementations: `D1Db` (wraps `env.DB.prepare(...)`) and
`PgDb` (wraps `pg.Pool.query`). Both implement `Db`; the rest of
`src/db/*.ts` is dialect-agnostic SQL.

**SQL dialect work.** SQLite (D1) and Postgres are mostly aligned
but: `INSERT ... ON CONFLICT DO UPDATE` is the same syntax in
both modern versions. `JSON_EXTRACT` differs (PG: `->`/`->>`).
`AUTOINCREMENT` differs (we use ULIDs so this is moot).
`IFNULL` → `COALESCE`. `printf` → `format`. ~40 helpers to audit.

**Migration runner.** A small Node script that replays the
existing `apps/api/migrations/*.sql` files against either D1 or
Postgres. The migration content needs a one-time port to portable
SQL (or two parallel migration trees: `migrations/sqlite/` +
`migrations/postgres/`).

Estimate: 2 weeks.

#### 2.2 — KV → Redis

Two consumers:
- `apps/api/src/auth/tenant-cache.ts` — `(api_key_hash → tenant)`
  with 60-second TTL.
- `apps/api/src/lib/secrets-store.ts` — KV-backed fallback when
  Secrets Store binding isn't present.

Replace both with a `KvLike` interface implemented by either
`WorkersKvAdapter` or `RedisAdapter`.

Estimate: 4 days.

#### 2.3 — R2 → MinIO (S3-compatible)

`apps/api/src/lib/r2-presign.ts` and the read/write paths in
`apps/api/src/routes/internal/ingest-write.ts` use `env.BLOBS.put`
/ `.get` / `.delete`. Wrap behind a `BlobStore` interface,
implement `R2BlobStore` and `S3BlobStore` (using
`@aws-sdk/client-s3` against the configured endpoint).

Estimate: 4 days.

#### 2.4 — Queue: Cloudflare Queues → Redis lists

Today: the api Worker is the queue producer
(`env.INGEST_QUEUE.send(...)`); the same Worker is the consumer
via the `queue(batch, env)` export. Container is a side-channel
the consumer DO-mints.

Self-host shape (v1's pattern): the api writes to
`LPUSH ingest:queue <job_json>`; an ingest worker process
`BRPOP`s from it. The Container we already have can host the
worker loop; one new entry point in `apps/ingest/app/workers/`.

A `Queue` interface keeps the api side platform-agnostic.

Estimate: 1 week.

#### 2.5 — Worker runtime → Node + Hono

Hono's docs already cover the Node adapter:

```ts
// node-server.ts
import { serve } from '@hono/node-server';
import app from './index.js';   // existing OpenAPIHono
serve({ fetch: app.fetch, port: 8787 });
```

The hard parts are runtime APIs not on Node:

| API | Today | Self-host equivalent |
|-----|-------|----------------------|
| `executionCtx.waitUntil(promise)` | CF runtime | A small `BackgroundTasks` helper that tracks promises and awaits them on shutdown |
| Scheduled handlers | CF cron triggers | `node-cron` |
| `MessageBatch` queue handler | CF Queues consumer | The new Redis worker (§2.4) |
| `Vectorize` / `D1Database` / `R2Bucket` / `KVNamespace` runtime types | CF bindings | Replaced by §2.1–2.4 |
| `Ai` binding | Workers AI | Hidden in self-host mode |

Estimate: 2 weeks. The bulk is plumbing the abstractions in
§2.1–2.4 into a Node entrypoint and proving the existing test
suite passes against it.

#### 2.6 — `docker-compose.yml` (full stack)

Lift v1's `infrastructure/docker/docker-compose.yml` into v2 with
the new service set:

```yaml
services:
  postgres:    # postgres:16; v1 config unchanged
  redis:       # redis:7; same
  qdrant:      # qdrant/qdrant:latest
  minio:       # minio/minio:latest
  api:         # v2's apps/api built as a Node container
  ingest:      # v2's apps/ingest (already Python/FastAPI)
  console:     # the admin UI from NEXT_MOST_IMPORTANT_THINGS #2 (when ready)
```

Single `docker-compose up`. Health checks on every service. One
bridge network. Volumes for each datastore.

Estimate: 3 days (most of it is repeated v1 work).

#### 2.7 — Deploy targets beyond docker-compose

Once the compose file works, derivative deploys are mechanical:

- **VM:** `docker-compose up -d` on a single host, plus reverse
  proxy (Caddy/Traefik). Document in a runbook.
- **Kubernetes:** translate compose → Helm chart. ~3 days.
- **ECS / Azure Container Apps / Fly.io / Render:** publish the
  images to a registry, write a sample `docker-compose` that
  matches each platform's expectations.

Phase 2 ships the docker-compose; Helm + cloud-specific deploy
docs are follow-ons.

### Phase 2 scope estimate

| Task | Effort |
|------|--------|
| 2.1 DB abstraction + Postgres + migration porting | 2 weeks |
| 2.2 KV → Redis | 0.5 week |
| 2.3 R2 → S3-compatible | 0.5 week |
| 2.4 Queue → Redis lists | 1 week |
| 2.5 Worker runtime → Node | 2 weeks |
| 2.6 Full `docker-compose.yml` + healthchecks | 0.5 week |
| 2.7 Deploy-target runbooks (VM + Helm) | 1 week (post-launch) |
| Cross-platform CI matrix | 0.5 week |
| Docs (deployment runbooks, self-host quickstart, license) | 0.5 week |
| **Total** | **~9 weeks** for one engineer |

### Phase 2 acceptance criteria

- [ ] `docker-compose up` against a fresh checkout brings up
      postgres + redis + qdrant + minio + api + ingest, all healthy
      within 60 seconds.
- [ ] Every cookbook pattern passes against the self-hosted stack
      (no Cloudflare in the loop).
- [ ] The full `pnpm test` suite passes against both runtimes
      (CF Workers via vitest-pool-workers; Node via standard
      vitest).
- [ ] Live e2e suite passes against the self-hosted stack on a
      single-VM deploy.
- [ ] No CF-specific imports outside a clearly-bounded `runtime/cf`
      directory; an `runtime/node` directory holds the Node-side
      shims. A CI guard enforces this.
- [ ] Docs: a `docs/SELF_HOSTING.md` runbook covering compose,
      single-VM, K8s notes; a self-host quickstart that gets a new
      operator to a working query in under 15 minutes.

### Phase 2 trigger

Phase 2 is a 2+ month investment. Trigger it when one of:

1. A qualified enterprise prospect commits ("contract pending
   self-host capability"). Their constraints shape the deploy
   target priorities (Postgres flavor, K8s vs ECS, region).
2. We close a sale that depends on it (the strongest signal).
3. We decide enterprise self-host is the **primary** GTM motion,
   not the Cloudflare-hosted SaaS one. (At which point Phase 2
   moves up in `NEXT_MOST_IMPORTANT_THINGS.md`.)

Until one of those fires, Phase 1 is enough — vector pluggability
satisfies most "we want options" asks without rewriting nine
abstractions.

---

## Out of scope (explicit)

- **Multi-region / data residency.** Captured separately in
  `NEXT_MOST_IMPORTANT_THINGS.md` #10; orthogonal to self-host.
  Self-host inherently solves data residency for the operator
  who chose where to deploy, but multi-region as a managed
  feature is its own work.
- **High-availability primaries.** The compose file is single-instance
  Postgres / Redis / Qdrant. Production HA (replicas, failover) is
  the operator's responsibility post-Phase-2; we document the
  shape but don't ship managed HA.
- **A dedicated AI Gateway substitute.** Self-host operators can
  point at any AIG-compatible proxy or just go direct to
  providers. We don't build our own.
- **Workers AI no-key tier in self-host.** Removed; tenants BYOK.
  The `workers_ai` provider value is gated behind a runtime check
  and hidden from the provider list when running on Node.
- **Cloudflare-only features.** The post-Phase-5 cleanup left some
  niceties tied to CF (AIG metadata propagation, `cf-aig-metadata`
  headers). In self-host these become no-ops. Documented as such.

## Non-goals

- We are not deprecating the Cloudflare deployment. Cloudflare
  stays the primary hosted offering. Self-host is **alongside**,
  not **instead of**.
- We are not promising feature parity in self-host on day one.
  Some advanced features (e.g., live Vectorize index resizing,
  CF Workers AI, AI Gateway analytics) are CF-specific and won't
  port. The compose stack supports the **canonical** flow:
  ingest → query (sync + streaming + structured) → eval. That's
  the contract.

---

## Sequencing recommendation

This doc supersedes items adjacent to it in
`NEXT_MOST_IMPORTANT_THINGS.md`:

- **Phase 1 (vector pluggability + dev compose) becomes #1.**
  ~2 weeks. Small lift, high-leverage, prep already 90% done. Real
  competitive differentiator without committing to the full
  rewrite.
- **Phase 2 (full self-host) becomes #2 with an enterprise-trigger
  gate.** ~9 weeks. Run it when the first qualified enterprise
  prospect signals this is the unlock.

Everything else in `NEXT_MOST_IMPORTANT_THINGS.md` (marketing site,
admin console, prod deploy + status page, Stripe metering,
reference apps, document-format support, SDKs, webhooks, GDPR,
multi-region) keeps its existing relative order, just shifted down
two slots.

---

## Open questions

1. **License model for self-host.** Open-source MIT vs
   commercial-use license vs SSPL? Self-host is the moment this
   decision becomes load-bearing — until then, the hosted SaaS
   was the only product surface and the license was implicit.
2. **Pricing for self-host vs hosted.** Per-node? Per-tenant?
   Per-CPU? A separate revenue model lives in this conversation.
3. **Support model.** Self-host customers expect SLAs / response
   times. Setting up a paid support tier (vs community / GitHub
   Issues) is a separate motion.
4. **Backport policy for security fixes.** Once a self-host
   release is out, security patches need a backport process. Mark
   as TODO when Phase 2 ships.

---

## First-week tasks (Phase 1 kick-off)

When work begins, the first PRs to ship:

1. `apps/api/src/retrieval/vector-store.qdrant.ts` — Qdrant
   adapter implementing `VectorStore`.
2. `apps/api/src/retrieval/vector-store.pinecone.ts` — Pinecone
   adapter.
3. Migration `0006_namespace_vector_backend.sql`.
4. Updated `vectorStoreFor(env, namespace)` selector reading
   `namespaces.vector_backend`.
5. Unit tests for both adapters using mocked HTTP fetches.
6. Integration tests against local Qdrant (in CI via the
   existing test container).
7. Live validation against deployed dev: a `cookbook-qdrant`
   namespace + a `cookbook-pinecone` namespace, both passing the
   8-pattern cookbook validator.
8. Docs: Namespaces tag updated; Provider Keys tag's capability
   table updated to call out Pinecone as a vector store (not a
   provider key).
