# V3 Phase 1 — Detailed Design

> **Versioning context.** V1 was the original book-centric Textral
> (now living at `/home/leif/textral`, *outside* `TEXTRAL_REFACTOR_WIP`)
> — fully self-hosted via docker-compose: Postgres + Redis + Qdrant +
> MinIO + Node API + Python rag-core. V2 is the current MVP — a
> Cloudflare-locked SaaS shape (D1 + R2 + KV + Queues + Vectorize +
> Workers AI + AI Gateway). V3 is the self-hostable evolution that
> ships **alongside** V2 in the same repo. V3 is split into two
> phases. This document is **Phase 1**.
>
> **Phase 1 scope.** Make the vector store pluggable (Qdrant +
> Pinecone alongside Vectorize). Ship a `docker-compose` that brings
> up the Container ingest service + a local Qdrant + a wrangler-dev
> Worker for hot-reload local development. CF still owns the rest:
> D1, R2, KV, Queues, AI bindings. Phase 2 (separate doc) replaces
> those.

---

## 1. Problem framing

Right now there is exactly one path to develop on Textral:

1. Have a Cloudflare account.
2. Deploy a dev Worker via `make deploy-dev`.
3. Touch any code → push to that dev Worker → exercise.

That's slow for any iteration that isn't pure unit-tested business
logic. It also locks every deployment of Textral to Cloudflare's
vector store. Two pain points worth resolving immediately:

- **Substrate choice.** Some prospects prefer Pinecone (managed,
  most-asked-for non-Cloudflare option) or Qdrant (self-hostable
  too). Today we say "Vectorize or nothing." That's a credibility
  hit in evaluations.
- **Local dev velocity.** A contributor cloning the repo can't run
  the stack without a Cloudflare account + tokens + provisioning.
  `docker-compose up` followed by `wrangler dev --remote --env dev`
  should give them a working ingest stage in minutes.

Phase 1 closes both pain points without disturbing anything else.

## 2. Current state — what's already in place

The post-Phase-5 audit cleanup (in `docs/audits/AUDIT_5-3-2026.md`)
did much of the architectural prep work for this phase:

- **`VectorStore` interface exists.** `apps/api/src/retrieval/vector-store.ts`
  defines `interface VectorStore` with `upsert / query / deleteByIds`,
  plus `class VectorizeV2Adapter implements VectorStore`. The selector
  `vectorStoreFor(env, embedding_profile)` is the single place every
  retrieval and write site goes through.
- **Vectorize references are isolated.** Confirmed via repo grep —
  `env.VECTORIZE_OPENAI_LARGE` appears in exactly two files:
  - `apps/api/src/types.ts:27` — type declaration on `Env`.
  - `apps/api/src/retrieval/vector-store.ts` — the single binding read.
  Routes don't touch the binding. Ingestion writes go through the
  abstraction. Query reads go through the abstraction.
- **Profile-driven dispatch.** `vectorStoreFor` takes the
  `embedding_profile` string (e.g. `openai-text-embedding-3-large-1536`)
  and dispatches today only to the Vectorize adapter. Adding two more
  branches is a one-file change.

This means Phase 1's blast radius is small: one selector, two new
adapter files, one schema migration, one new env-var pair, one new
docker-compose file. The rest of the codebase is untouched.

## 3. Requirements

### Functional

- **F1.** A namespace can be configured to use one of three vector
  backends: `vectorize` (default), `qdrant`, `pinecone`.
- **F2.** Backend choice is locked at namespace-creation time and
  persists across all queries / ingestions in that namespace. Switching
  backends after data is indexed requires a new namespace +
  `mode='full'` re-ingest.
- **F3.** Every cookbook pattern (`apps/api/scripts/validate-cookbook.ts`)
  passes against all three backends with identical response shapes.
  The audit fields (`audit.candidates_returned`,
  `audit.retrieval_status`, `audit.tokens.*`) come back the same way.
- **F4.** A contributor can run `make dev-stack` to start a Qdrant
  container + the ingest Container locally, plus `wrangler dev --remote`
  for the api Worker, and exercise queries end-to-end against a
  cookbook namespace pinned to the local Qdrant.

### Non-functional

- **NF1.** No regression on existing `vectorize`-backed namespaces.
  Migration is additive only (a new column with default `'vectorize'`).
- **NF2.** No new dependencies on the Worker side beyond Pinecone /
  Qdrant REST clients (or hand-rolled fetch wrappers — both APIs are
  simple HTTP).
- **NF3.** A new docs-regression test guards namespace-creation
  request shape (`vector_backend` enum, default behavior).

### Out of scope (deferred to Phase 2)

- Replacing D1 with Postgres.
- Replacing R2 with S3-compatible.
- Replacing KV with Redis.
- Replacing Cloudflare Queues with Redis lists.
- Replacing Workers runtime with Node.
- Removing Workers AI binding / AI Gateway dependence.
- A frontend / admin console.
- Per-tenant region pinning.

## 4. Architecture — Phase 1 deltas

### 4.1 Vector backend selection

Per-namespace, persisted in D1.

```
namespaces (existing)
+----------------------------+
| id                         |
| tenant_id                  |
| slug                       |
| corpus_profile             |
| default_embedding_profile  |
| vector_backend             |  ← NEW. enum 'vectorize'|'qdrant'|'pinecone'.
| vector_index_name          |  ← NEW. nullable. opaque per-backend handle.
| created_at                 |
+----------------------------+
```

`vector_index_name` is intentionally opaque. For Vectorize it stays
null (the binding is index-scoped at deploy time). For Qdrant it's
the collection name (e.g. `tenant_X_passages_1536`). For Pinecone
it's the index name + project handle. The shape of what goes in
this field is the responsibility of the adapter at namespace-create
time.

### 4.2 Adapter additions

The existing `VectorStore` interface (~7 methods) gets two new
implementations:

- `QdrantAdapter` — wraps Qdrant's REST API
  (`POST /collections/{name}/points/search`,
  `PUT /collections/{name}/points`,
  `POST /collections/{name}/points/delete`).
- `PineconeAdapter` — wraps Pinecone's serverless API
  (`POST /query`, `/vectors/upsert`, `/vectors/delete`).

Both live alongside the existing `VectorizeV2Adapter` in
`apps/api/src/retrieval/`.

### 4.3 Selector evolution

`vectorStoreFor(env, embedding_profile)` becomes
`vectorStoreFor(env, namespace, embedding_profile)`. The `namespace`
row tells us the backend; the `embedding_profile` tells us the
expected dimension width (used by Qdrant collection lifecycle —
see §4.6).

### 4.4 Wire-format constraints

All three backends must round-trip the same metadata shape so the
retrieval pipeline stays uniform. Required metadata per vector:

```
{
  tenant_id: string,
  namespace_id: string,
  document_id: string,
  version_id: string,
  version_index_id: string,
  artifact_type: string,
  chunk_id: string,
  ord: number,
  section_path?: string,
}
```

Vectorize already supports this via its V2 metadata API. Qdrant
stores it in the point `payload` field. Pinecone stores it in the
record `metadata` field.

The retrieval pipeline uses these for (a) tenant-isolation
filtering (every query restricts on `tenant_id`), (b) `document_ids`
subset filtering (Cookbook pattern #5), (c) `artifact_types`
filtering (corpus profiles' retrieval defaults).

### 4.5 New environment configuration

`apps/api/src/types.ts` adds:

```ts
QDRANT_URL?: string;       // e.g. http://host.docker.internal:6333 (compose) or https://...
QDRANT_API_KEY?: string;   // optional for local; required for managed Qdrant Cloud.
PINECONE_API_KEY?: string;
PINECONE_ENVIRONMENT?: string;     // e.g. "us-east-1-aws"
```

The Pinecone API key is in `DO_NOT_COMMIT.md` for live validation.

`wrangler.toml` carries the URLs as plain `[vars]`; the API keys go
through `wrangler secret put`.

### 4.6 Adapter responsibilities — collection / index lifecycle

The biggest cross-backend mismatch: Vectorize indexes are
provisioned at deploy time via `wrangler vectorize create`. Qdrant
and Pinecone need at-runtime collection/index creation.

- **Vectorize.** No-op. Adapter assumes the binding exists.
- **Qdrant.** On namespace create, the adapter calls
  `PUT /collections/{vector_index_name}` with `vectors: { size:
  <dim>, distance: 'Cosine' }`. Idempotent — `PUT` returns 200
  if the collection already exists with matching params.
- **Pinecone.** Pinecone serverless requires index pre-creation
  via dashboard/API + index URL host pinning. We don't auto-create
  indexes (account-level operation). The adapter takes
  `vector_index_name` from the namespace row and uses it as the
  Pinecone index name; first-write fails fast with a clear error
  if the index doesn't exist.

The collection-lifecycle code lives **inside the adapter**, not in
the namespace route. The route just calls
`adapter.ensureBackingExists(namespace, embedding_dimensions)` after
inserting the namespace row. Vectorize's implementation is empty;
Qdrant's PUTs the collection; Pinecone's verifies + reports.

### 4.7 Cookbook parity

The existing `validate-cookbook.ts` script becomes
`validate-cookbook.ts --backend <vectorize|qdrant|pinecone>`. CI
runs the full 8-pattern suite against all three backends per PR.

Live validation against deployed dev provisions three cookbook
namespaces (`cookbook-vectorize`, `cookbook-qdrant`,
`cookbook-pinecone`), ingests `narrative-tiny.md` to each, and runs
all eight patterns against each. A divergence is a release blocker.

## 5. Repository organization — Phase 1

Phase 1 changes are minimal; no new top-level structure needed. New
files only:

```
apps/api/src/retrieval/
├── vector-store.ts             ← MODIFIED — selector + interface
├── vectorize-v2-adapter.ts     ← MOVED out of vector-store.ts (clarity)
├── qdrant-adapter.ts           ← NEW
└── pinecone-adapter.ts         ← NEW

apps/api/src/db/
└── namespaces.ts               ← MODIFIED — vector_backend / index_name

apps/api/migrations/
└── 0006_namespace_vector_backend.sql   ← NEW

apps/api/scripts/
└── validate-cookbook.ts        ← MODIFIED — --backend flag

infrastructure/docker/
└── docker-compose.dev.yml      ← NEW (Phase 1's dev stack)

apps/api/
└── wrangler.toml               ← MODIFIED — new vars + secret bindings

apps/api/test/
├── qdrant-adapter.test.ts      ← NEW
├── pinecone-adapter.test.ts    ← NEW
└── namespace-vector-backend.test.ts   ← NEW
```

Total new files: 5. Modified files: 4. No reorganization, no new
top-level directories. This is intentional — Phase 1 is pure
extension.

## 6. The dev docker-compose — `infrastructure/docker/docker-compose.dev.yml`

Mirrors V1's pattern (`/home/leif/textral/infrastructure/docker/docker-compose.yml`)
but only the services Phase 1 needs:

```yaml
services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"      # HTTP REST
      - "6334:6334"      # gRPC (unused in Phase 1; reserved)
    volumes:
      - qdrantdata:/qdrant/storage
    healthcheck:
      test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/6333'"]
      interval: 5s
      retries: 5

  ingest:
    build:
      context: ../..
      dockerfile: apps/ingest/Dockerfile
    ports: ["8000:8000"]
    env_file: ../../.env.dev
    environment:
      WORKER_INTERNAL_URL: ${WORKER_INTERNAL_URL}      # public dev URL
      INTERNAL_HMAC_SECRET: ${INTERNAL_HMAC_SECRET}
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:8000/health')\""]
      interval: 5s

volumes:
  qdrantdata:

networks:
  default:
    driver: bridge
```

The api Worker doesn't run in compose. It runs via
`wrangler dev --remote --env dev` in a separate terminal. The
`--remote` flag binds the local Worker process to real CF dev
resources (D1, R2, Queues, AI). The Worker reaches the local
Qdrant via `http://host.docker.internal:6333` (Wrangler dev's
network exposes localhost to the Worker isolate).

The `make dev-stack` target kicks the whole thing off:

```makefile
dev-stack:
    docker compose -f infrastructure/docker/docker-compose.dev.yml up -d --wait
    @echo "qdrant: http://localhost:6333"
    @echo "ingest: http://localhost:8000"
    @echo "now run 'make dev-api' in another terminal"
```

`make dev-api` is the existing target that runs `wrangler dev --remote`.

## 7. How V2 + V3 coexist in the repo

Phase 1 doesn't introduce V2-vs-V3 fork. The same Worker, same
routes, same source files serve both. The namespace's
`vector_backend` field is the runtime switch. A V2-deployed Textral
that has only the Vectorize binding still works for any
`vector_backend='vectorize'` namespace; if a tenant tries to create
a Qdrant namespace without `QDRANT_URL` set, the route fails fast
with a clear `BAD_REQUEST` error message naming the missing config.

In other words: V3 Phase 1 is V2 + a runtime knob. The path-of-
least-resistance for V2 deploys is unchanged. The path-of-least-
resistance for V3 Phase 1 deploys is to set `QDRANT_URL` (or
Pinecone vars) and create namespaces with the new backend.

## 8. Migration + rollout

- **Migration 0006** adds `vector_backend TEXT NOT NULL DEFAULT 'vectorize'`
  + `vector_index_name TEXT` to the existing `namespaces` table. All
  existing tenants automatically remain on Vectorize.
- **Deploy order:** ship the schema migration → deploy the adapters
  + selector → tenants opt in by creating new namespaces with a
  non-default `vector_backend`.
- **No data migration.** Switching backends mid-life is not
  supported in Phase 1; tenants who want to move existing data must
  create a new namespace + re-ingest under the new backend.

## 9. Validation

### 9.1 Unit

- `qdrant-adapter.test.ts` — mocked `fetch`. Pin the request shape
  for upsert / search / delete. Pin the response parsing.
- `pinecone-adapter.test.ts` — same. Pin URL templates per region.
- `namespace-vector-backend.test.ts` — POST `/v1/namespaces` with
  each of the three values; verify default behavior; verify
  required-field rejection when an adapter needs config that's
  missing.

### 9.2 Integration

CI runs `make dev-stack` (compose-up), then exercises the cookbook
validator against a Qdrant-backed namespace. Pinecone is exercised
against the live Pinecone account (key in `DO_NOT_COMMIT.md`); CI
gated on a job-secret toggle so non-PR-owners don't burn quota.

### 9.3 Live

`apps/api/scripts/validate-cookbook.ts --backend vectorize` (existing)
+ same script with `qdrant` and `pinecone` flags. All eight cookbook
patterns must pass on all three. A nightly cron runs the full matrix.

## 10. Risks + mitigations

| Risk | Mitigation |
|------|------------|
| Pinecone schema-strict-mode regressions in cookbook pattern #3 | Already discovered + documented in cookbook (every property `required`). Test shapes baked in. |
| Qdrant collection name collisions across tenants on a shared dev cluster | Namespace `vector_index_name` includes tenant prefix. Adapter rejects writes if collection's existing schema doesn't match (different dimension, etc.). |
| Wrangler dev networking — Worker can't reach `localhost:6333` | Documented `host.docker.internal` workaround; tested on macOS + Linux + WSL. Fallback: `wrangler dev --local` with a fully local stack (loses real CF bindings; only useful for adapter unit work). |
| Pinecone API rate limits during validation | Cookbook validation runs serially (8 patterns × 3 backends ≈ 24 calls). Stays well under free-tier. |
| Cross-backend metadata-field naming drift | Adapter wrappers translate to/from a canonical shape (§4.4). Pinned by tests. |
| New `vector_index_name` becomes load-bearing in Phase 2 too | Field shape designed to be opaque from API consumers; adapters own its meaning. |

## 11. Acceptance criteria

- [ ] Migration 0006 applied; `namespaces.vector_backend` defaults
      to `'vectorize'` for all existing rows.
- [ ] Three adapters live; vectorize remains the default; the
      selector dispatches correctly.
- [ ] All cookbook patterns pass on Vectorize, Qdrant, Pinecone.
      Identical citation counts, audit shape, degradation level.
- [ ] `make dev-stack` brings up Qdrant + ingest in under 30
      seconds; the Worker via `wrangler dev --remote` connects to
      both.
- [ ] Docs updated: Provider Keys / Namespaces tag descriptions
      mention the three backends; Cookbook stays unchanged
      (cookbook is backend-agnostic).
- [ ] No `pnpm test` regressions; new tests added; lint + typecheck
      clean.
- [ ] `tools/check-no-inline-d1.sh` still passes.

## 12. Open questions

- **Naming.** Should `vector_backend` be `vector_store` instead?
  V1 used "vector store" semantically. Will pick during
  implementation; doc here uses `vector_backend` for symmetry with
  `corpus_profile`.
- **Collection lifecycle on namespace delete.** Phase 1 doesn't
  delete the upstream Qdrant collection on
  `DELETE /v1/namespaces/{slug}`. The collection orphans. Two
  options: leave (cheap, loud signal of "data outlives the
  namespace"), or add adapter `tearDown` (engineering work). Punt
  to Phase 2 unless a tenant complains.
- **Sparse retrieval (FTS5) — does it even apply?** Today
  hybrid_rrf fuses dense (Vectorize) + sparse (D1 FTS5). Qdrant
  has its own sparse-vector mode but we'd be doing it differently
  per backend. Phase 1 keeps dense-via-vector-backend + sparse-
  via-D1; the FTS5 sparse path is unchanged. Phase 2 revisits.
  → **Phase 2 outcome:** the FTS5 SQL was lifted out of
  `db/chunks.ts` into a `SparseSearch` interface (CF impl uses
  SQLite FTS5; Node impl uses Postgres `tsvector` + `ts_rank`).
  The sparse arm of hybrid retrieval still routes via the
  same-shape D1/Postgres tables — Qdrant's native sparse mode
  is not yet wired. See `docs/v3/PHASE-2_DETAILED_DESIGN.md` §4.2.6.
- **Per-namespace Vectorize indexes.** Currently we have one
  shared Vectorize index for all openai-large embeddings. Phase 1
  doesn't change this; a future "per-namespace Vectorize index"
  feature is unrelated to V3 work. Tracked separately.

## 13. Phase 1 deliverable shape

A single PR (or short PR series) lands:

1. Migration 0006.
2. Three adapter files + the selector update.
3. Namespace route changes + `ensureBackingExists` flow.
4. Three new test files + the cookbook-validator flag.
5. `docker-compose.dev.yml` + `make dev-stack`.
6. Docs updates: tag descriptions, README quickstart variants.

Estimated work units: vector-store work + tests + compose +
documentation. Done in one push given the audit prep work.

Phase 2 begins when Phase 1 is merged + the cookbook matrix is
green for ≥1 day on deployed dev.
