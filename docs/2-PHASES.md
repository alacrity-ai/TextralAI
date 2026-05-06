# Textral — PHASED IMPLEMENTATION

> Companion to `1-DESIGN.md`. Breaks the build into nine sequential
> phases (0–8). Each phase has discrete sub-phases sized to ship as a
> small batch of PRs, named files/folders, and explicit exit criteria.
>
> Phase ordering is dictated by dependencies and risk: storage
> substrate before pipelines, providers before ingestion, ingestion
> before retrieval, retrieval before enrichment, everything before
> hardening.

---

## Phase 0 — Repo Scaffold & Developer Ergonomics

**Goal:** A working monorepo with two empty-but-deployable apps,
shared package skeletons, dev/prod environments, and a green CI run.

### 0.1 pnpm workspace + TypeScript + linting

**Work**
- Initialize pnpm workspace with `apps/*` and `packages/*` globs.
- Root `tsconfig.base.json`, per-package `tsconfig.json` extending it.
- ESLint + Prettier matching the `landlord-contracts` reference repo.
- `package.json` scripts: `build`, `lint`, `typecheck`, `test`.

**Files / folders**
- `pnpm-workspace.yaml`
- `package.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`
- `.npmrc`, `.gitignore`, `.editorconfig`

**Exit criteria**
- `pnpm install` succeeds.
- `pnpm -r typecheck` returns 0 with no source files.
- ESLint runs cleanly on an empty workspace.

---

### 0.2 `apps/api` Worker skeleton

**Work**
- Wrangler project with two environments (`prod`, `dev`).
- `[observability]` block at full sample rate (matching reference repo
  convention).
- `compatibility_flags = ["nodejs_compat"]`.
- Hono router (or itty-router — pick now) with a single `/healthz`
  route.
- `wrangler dev --env dev` runs locally against Miniflare.

**Files / folders**
- `apps/api/wrangler.toml`
- `apps/api/src/index.ts`
- `apps/api/src/routes/health.ts`
- `apps/api/tsconfig.json`, `apps/api/package.json`

**Exit criteria**
- `wrangler dev --env dev` returns 200 on `GET /healthz`.
- `wrangler deploy --env dev` succeeds against an actual dev account.
- `https://textral-api-dev.<subdomain>.workers.dev/healthz` returns 200.

---

### 0.3 `apps/ingest` Container skeleton

**Work**
- Python 3.12 + FastAPI Dockerfile.
- `defaultPort = 8000`, `sleepAfter = "10m"`.
- Container exposes `/healthz` and `/jobs/run` (the only worker-callable
  endpoint).
- Worker side: `MyContainer extends Container` Durable Object binding
  in `wrangler.toml`.
- A `/dev/ingest-ping` route in the Worker proxies to the Container's
  health endpoint to prove the binding works.

**Files / folders**
- `apps/ingest/Dockerfile`
- `apps/ingest/app/main.py`
- `apps/ingest/app/__init__.py`
- `apps/ingest/requirements.txt`
- `apps/api/src/lib/container.ts` (binding wrapper)
- Container block in `apps/api/wrangler.toml`

**Exit criteria**
- `wrangler containers build` produces an image.
- `wrangler containers push` succeeds.
- `GET /dev/ingest-ping` (Worker) round-trips through the Container
  and returns 200.
- Container sleeps after 10 min of idleness; first cold start completes
  in under 8 s.

---

### 0.4 `packages/contracts` skeleton

**Work**
- Zod schemas namespace placeholder (`error.ts`, `id.ts`).
- ULID generator helper.
- Shared error envelope shape used by both apps.

**Files / folders**
- `packages/contracts/src/index.ts`
- `packages/contracts/src/error.ts`
- `packages/contracts/src/id.ts`
- `packages/contracts/package.json`

**Exit criteria**
- `apps/api` imports a Zod schema from `@textral/contracts` and uses
  it to validate `/healthz` (trivial example).
- `pnpm -r build` includes `@textral/contracts`.

---

### 0.5 CI + Makefile + secrets convention

**Work**
- GitHub Actions workflow: install, typecheck, lint, test on PR.
- Makefile targets: `dev`, `deploy-dev`, `deploy-prod`, `migrate-dev`,
  `migrate-prod`, `secret-put-dev`, `secret-put-prod`.
- `SECRETS.md` documenting required secrets per env (mirroring
  reference repos).

**Files / folders**
- `.github/workflows/ci.yml`
- `Makefile`
- `SECRETS.md`

**Exit criteria**
- A no-op PR passes CI green.
- `make deploy-dev` deploys the Worker + Container.

---

## Phase 1 — Cloudflare Substrate, Tenancy & BYOK

**Goal:** Tenants exist, can be authenticated by API key, can register
namespaces, can register provider keys safely. No documents yet.

### 1.1 Provision dev/prod resources

**Work**
- Create dev + prod D1 databases.
- Create dev + prod R2 buckets.
- Create dev + prod Queue.
- Create one Vectorize index per supported embedding profile (start
  with one: `openai-text-embedding-3-large`).
- Create dev + prod Secrets Store namespaces.
- Wire all bindings in `wrangler.toml` per-env.

**Files / folders**
- `apps/api/wrangler.toml` (extended bindings)
- `docs/runbooks/PROVISIONING.md` (the one-time setup commands)

**Exit criteria**
- `wrangler d1 list`, `wrangler r2 bucket list`, `wrangler vectorize list`,
  `wrangler queues list`, `wrangler secrets-store list` all show the
  expected dev + prod resources.
- `wrangler deploy --env dev` references all bindings successfully.

---

### 1.2 D1 baseline migrations

**Work**
- Migration 0001: `tenants`, `api_keys`, `namespaces`, `provider_keys`,
  `usage_records`. Schema per `1-DESIGN.md` §5.1.
- Migration runner pinned to `migrations/` directory in Wrangler config.
- One seed script for a `dev` tenant + admin API key for testing.

**Files / folders**
- `apps/api/migrations/0001_baseline.sql`
- `apps/api/scripts/seed-dev.ts`

**Exit criteria**
- `wrangler d1 migrations apply --env dev` succeeds.
- `wrangler d1 execute --env dev --command "SELECT name FROM sqlite_master"`
  lists every expected table.
- Seed script populates a dev tenant + admin key idempotently.

---

### 1.3 API key authentication middleware

**Work**
- API key format: `tx_live_<26-char ULID>_<32-char secret>`.
- Argon2id hashing of the full key (use `@noble/hashes` or WebCrypto +
  PBKDF2 fallback if argon2 isn't viable in Workers — confirm and pick).
- Auth middleware: extracts `X-Textral-Api-Key`, hashes, looks up,
  caches the resolved tenant in KV for 60 s.
- Returns the standard error envelope on miss.

**Files / folders**
- `apps/api/src/auth/api-key.ts`
- `apps/api/src/auth/middleware.ts`
- `packages/contracts/src/auth.ts`

**Exit criteria**
- `GET /v1/tenants/me` (a stub route) returns the authenticated
  tenant.
- Missing/invalid keys return the standardized error envelope with
  code `INVALID_API_KEY` and HTTP 401.
- Hash + lookup latency under 5 ms p95 with the KV cache hot.

---

### 1.4 Namespaces + tenants endpoints

**Work**
- `POST /v1/api-keys`, `GET /v1/api-keys`, `DELETE /v1/api-keys/:id`.
- `POST /v1/namespaces`, `GET /v1/namespaces`, `GET /v1/namespaces/:slug`,
  `PATCH /v1/namespaces/:slug`, `DELETE /v1/namespaces/:slug`.
- All routes tenant-scoped via the middleware in 1.3.
- Zod request/response schemas in `packages/contracts`.

**Files / folders**
- `apps/api/src/routes/api-keys.ts`
- `apps/api/src/routes/namespaces.ts`
- `packages/contracts/src/namespace.ts`

**Exit criteria**
- E2E test: create namespace `leases`, list namespaces (returns 1),
  patch description, delete, list (returns 0).
- Cross-tenant isolation test: tenant A cannot see tenant B's
  namespaces (verified by direct D1 query in test).

---

### 1.5 Provider-key registration via Secrets Store

**Work**
- `POST /v1/provider-keys` writes raw key to Secrets Store, persists
  metadata in D1.
- `GET /v1/provider-keys` returns metadata only (provider, label,
  prefix, last_validated_at, last_error_code).
- `DELETE /v1/provider-keys/:id` revokes both records.
- `POST /v1/provider-keys/:id/test` issues a 1-token model call to
  verify the key.
- Provider-key resolver service: `(tenant_id, label) → secrets_store_id
  → raw_key`, used internally during query/ingest.

**Files / folders**
- `apps/api/src/routes/provider-keys.ts`
- `apps/api/src/auth/provider-keys.ts` (resolver)
- `apps/api/src/lib/secrets-store.ts`

**Exit criteria**
- Round-trip: register an OpenAI key, list (returns metadata, never the
  key), test (returns 200 with `{ "ok": true }` if key is valid).
- D1 row never contains the raw key.
- R2 has no provider-key data anywhere.

---

### 1.6 Redaction middleware + verification harness

**Work**
- A redaction middleware that runs **before** any logger/tracer touches
  the request. Strips `X-Provider-Key-*` headers, redacts `apiKey` /
  `key` fields in JSON bodies, scans for `sk-...` / `sk-proj-...` /
  `xai-...` / `claude-...` patterns and replaces with `[REDACTED]`.
- Dev-only `__redaction_check` route fires fake leakage attempts and
  asserts logs/AI Gateway tags are clean.
- Test suite asserts no provider key fragment ever reaches
  `console.log`, `env.LOGS.writeDataPoint`, or AI Gateway tags.

**Files / folders**
- `apps/api/src/middleware/redaction.ts`
- `apps/api/src/routes/__redaction_check.ts` (dev only)
- `apps/api/test/redaction.test.ts`

**Exit criteria**
- Test: 50 randomly-generated provider-key shapes posted to all known
  routes — none appear in any log sink.
- The dev-only `__redaction_check` route is gated by
  `env.ENABLE_DEBUG_ROUTES` and 404s in prod.

---

### 1.7 OpenAPI surface + hosted docs UI

**Goal:** Auto-generate an OpenAPI 3.1 spec from the route definitions
and serve it (plus a Scalar-rendered docs page) from the Worker.
Future routes (Phase 3+) gain spec entries automatically; no separate
hand-maintained API doc.

**Work**
- Add `@hono/zod-openapi` (zod-3-compatible release) and
  `@scalar/hono-api-reference`.
- Replace top-level `Hono` with `OpenAPIHono`; convert each existing
  route group to `createRoute(...)` definitions backed by the
  schemas in `packages/contracts`.
- Decorate contracts schemas via `extendZodWithOpenApi(z)` at the
  API-package boundary so `@textral/contracts` stays framework-agnostic.
- Mount `GET /openapi.json` (auto-generated) and `GET /docs` (Scalar UI).
  Both public; the spec describes the contract our consumers code
  against.
- Register `ApiKeyAuth` (X-Textral-Api-Key) and `AdminToken`
  (X-Admin-Bootstrap-Token) security schemes in the spec.
- Coverage test: walks the served paths and asserts every public
  Worker route is in the spec; debug-only routes (`/dev/*`,
  `/__redaction_check`) are NOT in the spec.
- Set the framework's `defaultHook` so Zod request-validation failures
  return our standard `ErrorEnvelope` shape, not the framework default.

**Files / folders**
- `apps/api/src/openapi/{z,components,registry}.ts`
- `apps/api/src/routes/docs.ts`
- `apps/api/src/index.ts` (extended)
- `apps/api/src/routes/{health,me,namespaces,api-keys,provider-keys,admin/bootstrap}.ts` (converted)
- `apps/api/test/openapi-coverage.test.ts`

**Exit criteria**
- `GET /openapi.json` returns a valid OpenAPI 3.1 document with every
  mounted public route.
- `GET /docs` returns the Scalar UI rendered against the spec.
- The coverage test fails the build if a future route is added without
  a `createRoute(...)` definition.
- All Phase 0/1/2 tests still pass; existing handler bodies keep their
  behavior (status codes, error envelopes, response shapes).

> Detailed steps: `docs/development/PHASE_1_7_IMPLEMENTATION.md`.

---

## Phase 2 — Provider Abstraction

**Goal:** From the Worker, we can call OpenAI, Workers AI, and
Anthropic via a unified interface. Every call is classified into one
of four outcomes, routed through AI Gateway, with `insufficient_quota`
and `invalid_api_key` properly classified as fatal (no retry loops).

### 2.1 Provider interfaces

**Work**
- `LLMProvider`, `EmbeddingProvider`, `RerankProvider` interfaces in
  `packages/contracts`.
- `ProviderResult<T>` discriminated union: `success | degraded_success |
  retryable_error | fatal_error`.
- Stable error-classification helpers (`classifyOpenAIError`,
  `classifyAnthropicError`).

**Files / folders**
- `packages/contracts/src/provider.ts`
- `packages/contracts/src/provider-result.ts`
- `packages/contracts/src/error-classification.ts`

**Exit criteria**
- Every provider call site in the codebase uses `ProviderResult<T>` —
  no raw `try/catch` around a fetch.
- `classifyOpenAIError` correctly identifies `insufficient_quota`,
  `invalid_api_key`, `rate_limit_exceeded`, and 5xx classes.

---

### 2.2 OpenAI-compatible provider (handles OpenAI + Workers AI + OpenRouter)

**Work**
- One concrete `OpenAICompatProvider` class. Constructor takes a base
  URL, model, and key.
- Used for OpenAI direct, Workers AI's compat endpoint, and any future
  OpenAI-compat provider (e.g., Together, OpenRouter).
- Embedding + chat + structured-output + streaming support.

**Files / folders**
- `apps/api/src/providers/openai-compat.ts`

**Exit criteria**
- Unit tests against fixtured responses for: success, structured
  output, refusal, 429 transient, 429 `insufficient_quota`, 401, 5xx,
  malformed JSON.
- Live integration test (gated by env var) hits OpenAI with a
  1-token call.

---

### 2.3 Workers AI binding provider (no-key tier)

**Work**
- `WorkersAIBindingProvider` uses `env.AI.run("@cf/...")` directly.
- Exposes embedding (BGE) and chat (Llama 3.x) models.
- Same `ProviderResult` shape as 2.2.

**Files / folders**
- `apps/api/src/providers/workers-ai-binding.ts`

**Exit criteria**
- Embed 100 short texts via Workers AI, get 1024-dim vectors back.
- Chat completion round-trip works for `@cf/meta/llama-3.1-8b-instruct`.

---

### 2.4 Anthropic provider

**Work**
- Kept distinct from OpenAI-compat because Anthropic has different
  tool-use semantics and we may want extended thinking later.
- Supports messages API + structured output via tool use.

**Files / folders**
- `apps/api/src/providers/anthropic.ts`

**Exit criteria**
- Unit tests + live integration test for one chat call.
- Structured-output tool-use round-trip works.

---

### 2.5 AI Gateway routing

**Work**
- Wrap every provider's HTTP call to go through
  `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/...`
  rather than the provider's direct endpoint.
- Pass `cf-aig-metadata` headers with `tenant_id`, `namespace_id`,
  `query_event_id` (when available).
- A flag (`AI_GATEWAY_BYPASS=1`) for local dev convenience.

**Files / folders**
- `apps/api/src/providers/ai-gateway.ts`
- `apps/api/src/lib/gateway-url.ts`

**Exit criteria**
- A test query produces a row in the AI Gateway dashboard tagged with
  the tenant_id.
- Cost numbers in the gateway dashboard reconcile within ±1¢ against
  the provider's own dashboard for a representative day.

---

### 2.6 Reranker providers

**Work**
- `VoyageRerankProvider` (default).
- `CohereRerankProvider` (alternative).
- Same `ProviderResult` shape; called from the Worker, not the Container.

**Files / folders**
- `apps/api/src/providers/voyage-rerank.ts`
- `apps/api/src/providers/cohere-rerank.ts`

**Exit criteria**
- Given 30 candidate texts + a query, both rerankers return the top-12
  in score order.
- Latency under 400 ms p95 for a 30-doc rerank.

---

### 2.7 Provider key resolver

**Work**
- `resolveProviderKey(tenantId, label) → { provider, key, key_id }`.
- Caches resolved keys for 60 s in memory (per Worker isolate).
- Records `last_used_at` on the `provider_keys` row asynchronously.
- The Container's equivalent: receives `secrets_store_id` in the queue
  payload, fetches via its own Secrets Store binding.

**Files / folders**
- `apps/api/src/auth/provider-keys.ts` (extended from 1.5)
- `apps/ingest/app/secrets.py`

**Exit criteria**
- An ingest job submitted with `provider_key_ref: "openai-prod"`
  successfully resolves to the encrypted key in the Container without
  ever passing the key through the queue payload.

---

## Phase 3 — Ingestion: Core Stages + Container Worker

**Goal:** A document can be uploaded, ingested through 5 stages, and
produce queryable Layer-1 chunks (passages) in D1 + Vectorize. No
enrichment yet. No retrieval yet.

> Detailed steps: `docs/development/PHASE_3_4_IMPLEMENTATION.md`.

**Cross-cutting decisions** (see implementation doc for rationale):
- **Source vs index versioning split.** `document_versions` identifies
  source bytes only (UNIQUE on `(document_id, content_hash)`); a
  separate `version_indexes` table tracks `(version_id,
  chunking_profile, embedding_profile)` combos. Different profiles do
  not mint new source versions.
- **Worker is the only writer.** D1 + Vectorize bindings live on the
  Worker; the Container POSTs to internal Worker endpoints for every
  write. Provider keys never leave the Worker.
- **Internal back-channel** authenticated via HMAC over
  `(method, path, body_hash, timestamp)` with a 5-min window.
  Endpoints re-validate tenant + job ownership against D1 on every
  call — Container is not trusted to self-attribute.

### 3.1 D1 migrations for documents + jobs + chunks

**Work**
- Migration 0002: `documents`, `document_versions` (source-only),
  `version_indexes` (chunking + embedding combos), `ingestion_jobs`
  (with lease columns), `ingest_stage_attempts` (PK
  `(job_id, stage, attempt)`), `chunks` (with `embedding_status`,
  `embedding_input_hash`, `embedding_provider_request_id`,
  `embedding_dimensions`), `chunks_fts` virtual table + sync triggers,
  `query_events` (insert-early shape), `tenants.audit_mode` column.
- Indexes per `1-DESIGN.md` §5.1.

**Files / folders**
- `apps/api/migrations/0002_documents_jobs_chunks.sql`

**Exit criteria**
- All tables, indexes, virtual table, and triggers created on dev D1.
- Manual smoke: insert a chunk row, observe FTS5 row appears
  automatically.
- `version_indexes` UNIQUE constraint on
  `(version_id, chunking_profile, embedding_profile)` rejects duplicate
  inserts.

---

### 3.2 R2 layout + presigned upload URLs

**Work**
- `POST /v1/documents/:id/uploads` returns a presigned PUT URL plus
  declared `size_bytes` + `content_type`; the parameters are recorded
  in an `upload_intents` row.
- R2 key format per `1-DESIGN.md` §5.2.
- `POST /v1/documents/:id/uploads/:upload_id/finalize` is an
  **idempotent recovery state machine** (`upload_received → copy_started
  → copy_completed → version_inserted → upload_deleted`).
- Content hash is `sha256(source bytes)` streamed at finalize, NOT
  R2 ETag. Finalize verifies actual `Content-Length` + `Content-Type`
  against the presign request before hashing.

**Files / folders**
- `apps/api/src/routes/documents.ts`
- `apps/api/src/lib/r2-presign.ts`

**Exit criteria**
- E2E: presign → upload → finalize produces a `document_versions` row
  with the correct `content_hash`.
- Re-uploading identical bytes returns the existing `version_id`
  (UNIQUE on `(document_id, content_hash)`).
- Finalize after a partial-failure (canonical R2 object exists, no
  D1 row) recovers cleanly without orphaning.
- Mismatched declared vs. actual size or content-type returns 400
  `UPLOAD_VALIDATION_FAILED`.

---

### 3.3 Document register + ingest dispatch

**Work**
- `POST /v1/namespaces/:ns/documents` — register, returns
  `document_id`.
- `POST /v1/documents/:id/ingest` — validates against Zod, finds-or-
  creates the `version_index` for the requested profiles, INSERTs an
  `ingestion_jobs` row, and dispatches a queue message.
- `provider_key_ref` (label) is **resolved to a `pkey_*` ID at
  dispatch** and persisted as `provider_key_id` in `config_json`.
  Subsequent stages and replays target the exact key, not whatever the
  label currently points at.

**Files / folders**
- `apps/api/src/routes/documents.ts` (extended)
- `apps/api/src/ingestion/dispatch.ts`
- `packages/contracts/src/ingest.ts`

**Exit criteria**
- A queue message lands with the pointer payload (`{ job_id,
  tenant_id, attempt }`) — never the raw provider key.
- The `ingestion_jobs` row reflects `status='pending'` and a populated
  `version_index_id`.
- Re-running ingest for a `(version, chunking, embedding)` combo
  whose `version_index` is already `ready` returns 409
  `INDEX_ALREADY_BUILT` unless `force_rebuild: true`.

---

### 3.4 Container queue worker + internal back-channel

This sub-phase is structured into six pieces in the implementation doc:

#### 3.4.1 Worker queue consumer

**Work**
- `queue()` handler proxies messages to the Container's `/jobs/run`
  via the Durable Object binding.
- Acks `full_success`, `partial_ingestion`, and `fatal_failure`
  outcomes; CF Queues re-delivers transient 5xx / network failures.

#### 3.4.2 Container `/jobs/run`

**Work**
- FastAPI route accepts `{ job_id, attempt }`, claims the job lease,
  loads metadata via `/internal/jobs/{id}`, runs stages.

#### 3.4.3 Internal Worker endpoints (Container ↔ Worker)

**Work**
- Worker exposes signed routes: `/internal/jobs/{id}` (load),
  `/jobs/{id}/claim`, `/jobs/{id}/heartbeat`, `/jobs/{id}/transition`,
  `/jobs/{id}/stage-attempt`, `/r2/upload-url` (read URL),
  `/chunks/batch`, `/vectorize/upsert`,
  `/vectorize/delete-by-filter`, `/providers/embed`.
- `/internal/providers/embed` replaces a `secrets/resolve` endpoint —
  provider keys never leave the Worker.
- Every write endpoint re-validates tenant + job ownership against D1.

#### 3.4.4 Internal authentication (HMAC + 5-min window)

**Work**
- `apps/api/src/middleware/internal-auth.ts` enforces
  `X-Textral-Internal-Signature` (HMAC-SHA-256 over
  `method + path + sha256(body) + timestamp`) +
  `X-Textral-Internal-Timestamp` (5-min window) +
  `X-Textral-Internal-KeyId` (rotation).
- `INTERNAL_HMAC_SECRET` set as a Worker secret per env, mirrored
  into the Container at deploy time.

#### 3.4.5 Job lease + lock

**Work**
- `ingestion_jobs` columns: `locked_at`, `locked_by`, `attempt_count`,
  `lease_expires_at`, `heartbeat_at`.
- CAS-style claim: `UPDATE ... WHERE status IN ('pending','retrying')
  AND (lease_expires_at IS NULL OR lease_expires_at < now)` —
  `meta.changes === 1` means the claim won.
- Heartbeats every 60s extend the lease; default 5 min, configurable.

#### 3.4.6 Smoke test: noop job

**Work**
- "noop" job with empty source progresses `pending → running →
  completed` end-to-end.

**Files / folders**
- `apps/api/src/index.ts` (queue() handler)
- `apps/api/src/middleware/internal-auth.ts`
- `apps/api/src/routes/internal/{ingest-write,providers}.ts`
- `apps/api/src/ingestion/{queue-handler,lease,job-loader}.ts`
- `apps/ingest/app/main.py` (FastAPI route `/jobs/run`)
- `apps/ingest/app/workers/job_runner.py`
- `apps/ingest/app/clients/worker.py` (signs every outbound request)

**Exit criteria**
- Noop job completes within 30 s including Container cold-start.
- Idle Container sleeps after 10 min and resurrects on next message.
- Concurrent claim attempts on the same job: exactly one wins.
- Forged `chunks/batch` payload with mismatched `tenant_id` is
  rejected with 403.
- Internal request outside the 5-min HMAC window returns 401.

---

### 3.5–3.9 The five core stages

Each sub-phase ships one stage, in order. All stages share:

- One row per attempt in `ingest_stage_attempts` keyed by
  `(job_id, stage, attempt)`. Latest attempt computed via
  `MAX(attempt) WHERE status='completed'`. Forensic timeline
  preserved.
- Idempotent on attempt-level keys.
- Failure classification per Phase 2.

#### 3.5 Stage: fetch

**Work**
- Pull source bytes from R2 via a Worker-issued presigned read URL.

**Files / folders**
- `apps/ingest/app/stages/fetch.py`

**Exit criteria**
- Fetches a 5 MB EPUB in under 2 s.
- Records `file_size`, `content_type` in stage attempt metadata.

---

#### 3.6 Stage: normalize

**Work**
- Parses txt/md/EPUB into the Canonical Document Model.
- HTML stripping, dialogue detection, section-path stamping.
- Pydantic CDM types use `Field(default_factory=...)` for all
  collection defaults.
- Emits `normalized.json` to R2.

**Files / folders**
- `apps/ingest/app/stages/normalize.py`
- `apps/ingest/app/cdm/{model,tokens}.py`
- `apps/ingest/app/normalizers/{txt,md,epub}.py`

**Exit criteria**
- Representative novel + representative legal doc both normalize
  cleanly.
- Section paths populated correctly for explicit headings.
- Re-running normalize is byte-deterministic.

---

#### 3.7 Stage: chunk

**Work**
- Generic chunker: target 600 tokens, overlap 80, never crosses a
  major section boundary.
- Chunk ID format: `chk_<version_id>_<zero_padded_ord>` (deterministic,
  human-debuggable, sortable; not a ULID).
- Emits `chunks.jsonl` to R2 with a versioned header line
  (`schema_version: chunk_jsonl_v1`).

**Files / folders**
- `apps/ingest/app/stages/chunk.py`
- `apps/ingest/app/chunkers/generic.py`

**Exit criteria**
- 100K-token document → ~170 chunks, every chunk under 800 tokens.
- All chunks have valid `section_path` and monotonic `ord`.
- Replay produces byte-identical chunk IDs.
- Header `chunk_count` matches subsequent line count; legacy schemas
  rejected.

---

#### 3.8 Stage: embed

**Work**
- Container batches chunk text and POSTs to Worker
  `/internal/providers/embed`. The Worker resolves the provider key,
  applies AI Gateway routing + redaction + Phase 2
  retry/classification, and returns vectors.
- For OpenAI `text-embedding-3-large`, the embed call **always
  passes `dimensions: 1536`** (Vectorize V2 dim cap). The embedding
  profile records both `model` and `dimensions`.
- Failure dispatch mirrors Phase 2: `insufficient_quota` → fatal,
  zero retries; transient 429 → up to 3 retries; partial_batch →
  retry once then mark short-batched chunks
  `embedding_status='missing'` (becomes `partial_ingestion`).
- `embedding_input_hash` (sha256 of embedded text) +
  provider `request_id` flow into the index stage so they land on
  the chunk row.

**Files / folders**
- `apps/ingest/app/stages/embed.py`
- `apps/api/src/routes/internal/providers.ts`

**Exit criteria**
- 200-chunk document embeds against OpenAI in under 8 s.
- v1 regression: mocked 429 + `insufficient_quota` fails the job
  with `PROVIDER_QUOTA_EXHAUSTED` after exactly one provider call.
- Mismatched declared vs actual `dimensions` returns 400 at the
  Worker boundary.

---

#### 3.9 Stage: index

**Work**
- Container POSTs to `/internal/chunks/batch` (Worker writes to D1;
  FTS5 trigger fires) and `/internal/vectorize/upsert` (only chunks
  where `embedding_status='embedded'`).
- **Partial-ingestion invariants** locked in:
  - D1 + FTS5 hold ALL chunks regardless of embedding status (sparse
    retrieval still works).
  - Vectorize holds only `embedding_status='embedded'` chunks.
  - `version_indexes.embedding_missing_count` populated;
    `version_indexes.status` ends `'ready'` or `'partial'`.
- `replace_existing_vectors: true` performs a
  `delete-by-filter` on `(document_id, version_id, embedding_profile,
  chunking_profile)` and polls the `mutationId` to completion before
  upserting. Eventual-consistency timeout: 30 s (retryable).

**Files / folders**
- `apps/ingest/app/stages/index.py`
- `apps/api/src/routes/internal/ingest-write.ts` (extended)

**Exit criteria**
- 200-chunk document indexes in under 10 s.
- D1 `SELECT count(*) FROM chunks WHERE document_id=?` → 200.
- Vectorize filtered query by `document_id` returns 200 vectors when
  `embedding_missing_count=0`.
- FTS5 rowcount matches `chunks` rowcount regardless of embedding
  status.
- `replace_existing_vectors: true` re-ingest leaves no orphaned
  vectors or chunks.

---

### 3.10 Stage attempt history + idempotent replay

**Work**
- On entry, after lease claim: read `ingest_stage_attempts`, compute
  `last_completed_stage = MAX(attempt) per stage where
  status='completed'`. Resume from `next(last_completed_stage)`.
- New attempts INSERT with `attempt = MAX(attempt) + 1` for the
  stage. Failed attempts stay in the table for forensic value.
- A successful run sets `documents.current_version_id = version_id`
  (the source version) and `version_indexes.status = 'ready' |
  'partial'`.

**Files / folders**
- `apps/api/src/ingestion/replay.ts`
- `apps/ingest/app/workers/job_runner.py` (extended)

**Exit criteria**
- A job that fails in stage 4 (embed) on attempt 1 and is retried:
  attempt 1's row stays as `status='failed'`; attempt 2 enters as a
  fresh row; resume reads `chunks.jsonl` from R2 rather than re-running
  normalize+chunk.
- Replaying a fully-successful job is a no-op.
- `SELECT * FROM ingest_stage_attempts WHERE job_id = ? ORDER BY
  started_at` shows every attempt, including the failed ones with
  their error messages.

---

### 3.11 Profile compatibility (write side)

**Work**
- Compatibility unit is `version_indexes` (composite: chunking +
  embedding profile per source version).
- Re-ingest with the same profiles: resume the existing
  `version_index` if `pending`/`partial`, else 409
  `INDEX_ALREADY_BUILT` unless `force_rebuild: true`.
- Re-ingest with a different chunking OR embedding profile creates a
  new `version_index` row under the same `version_id`; the old index
  remains queryable.
- `chunks.embedding_profile` and `chunks.chunking_profile` denormalized
  for cheap read-side gating.

**Files / folders**
- `apps/api/src/ingestion/dispatch.ts` (extended)
- `apps/ingest/app/stages/index.py` (extended)

**Exit criteria**
- Same source ingested under
  `(generic, text-embedding-3-large)` then
  `(generic, text-embedding-3-small)` produces ONE `document_versions`
  row and TWO `version_indexes` rows. Both queryable.
- Re-ingest with same profile pair returns 409 unless
  `force_rebuild: true`.
- Querying with mismatched chunking profile returns 400
  `EMBEDDING_PROFILE_MISMATCH` with `details.dimension='chunking'`.

---

### 3.12 Phase 3 close-out — mandatory items

Beyond passing tests, these must hold to tag `phase-3-complete`:

1. `document_versions` is source-only; `version_indexes` carries
   chunking + embedding profile combos.
2. Content hash is `sha256(source bytes)` streamed at finalize, not
   ETag.
3. Job lease/lock columns populated; CAS claim returns
   `meta.changes === 1` exactly once per redelivery.
4. Internal endpoints reject any request without a valid HMAC
   signature within the 5-min window.
5. Internal endpoints re-validate tenant + job ownership on every
   call.
6. Stage attempt history preserved; failed-then-recovered flow shows
   BOTH attempts.
7. Vectorize index dim and OpenAI `dimensions` request parameter
   match the embedding profile (1536 for `text-embedding-3-large`).
8. Chunk IDs use `chk_<version_id>_<padded_ord>` format.
9. Partial-ingestion invariants asserted by test: D1+FTS5 hold all,
   Vectorize holds only `embedding_status='embedded'`.

---

## Phase 4 — Retrieval + Synthesis: End-to-End Query Path

**Goal:** `POST /v1/query` works end-to-end against an ingested
document. Generic profile only. No enrichment, no streaming.
Reranking is wired with a deterministic no-op interface; corpus-
profile defaults flip it on in Phase 5.

> Detailed steps: `docs/development/PHASE_3_4_IMPLEMENTATION.md`.

### 4.1 Hybrid retrieval (D1 FTS5 + Vectorize, allSettled)

**Work**
- Worker-side `runHybridRetrieval(req, env, ctx)`.
- Both arms run via **`Promise.allSettled`** — single-arm failures
  degrade to the surviving arm with `retrieval_status` set
  (`full | dense_only | sparse_only | empty`).
- FTS5 query construction: **conservative tokenize** by default —
  parse quoted phrases; alphanumeric + safe Unicode-letter terms only;
  drop FTS5 operators (`AND OR NOT NEAR ^ : -`); OR-join. An
  `advanced_query: true` mode is reserved for a later phase.
- Filtered identically by `tenant_id`, `namespace_id`,
  `version_index_id`, `artifact_type`.

**Files / folders**
- `apps/api/src/retrieval/hybrid.ts`
- `apps/api/src/retrieval/fts5-query.ts`
- `apps/api/src/retrieval/vectorize-query.ts`

**Exit criteria**
- Query against a known document returns expected top-30 from each
  arm.
- Cross-tenant filter test: tenant A's query never sees tenant B's
  chunks.
- Fault injection: stub Vectorize to throw → retrieval returns
  sparse-only with `retrieval_status='sparse_only'`. Stub FTS5 to
  throw → dense-only.
- Both arms throwing → `RETRIEVAL_FAILED`.

---

### 4.2 Profile compatibility gate (composite)

**Work**
- Look up the matching `version_indexes` row by
  `(version_id, request.chunking_profile, request.embedding_profile)`.
- Compare both axes; mismatch in either returns 400
  `EMBEDDING_PROFILE_MISMATCH` with `details.dimension`
  (`'embedding'` or `'chunking'`) and `details.available` listing
  every existing `version_index` for the version.

**Files / folders**
- `apps/api/src/retrieval/profile-gate.ts`

**Exit criteria**
- Embedding-profile mismatch → 400 with `details.dimension='embedding'`.
- Chunking-profile mismatch → 400 with `details.dimension='chunking'`.
- Matching profile pair → gate passes.
- `details.available` lists every alternative profile combo for the
  version.

---

### 4.3 RRF fusion

**Work**
- Reciprocal rank fusion of dense + sparse arms (or one arm when the
  other is degraded).
- Configurable `rrf_k` (default 60).

**Files / folders**
- `apps/api/src/retrieval/rrf.ts`

**Exit criteria**
- Golden-set passages appear in top 10 fused results more often than
  in either arm alone.
- Property test: rank monotonicity preserved.

---

### 4.4 Context assembly with unified `[1][2][3]` numbering

**Work**
- Hydrate fused candidates via `WHERE id IN (...)`, then **re-sort
  the rows by fused-rank position** before token-budget greedy
  inclusion. (`IN` does not preserve list order; greedy inclusion
  of arbitrary-order rows would silently drop top-ranked candidates.)
- Sequential numbering across all artifact types.
- Per-layer budget allocation (exercised in Phase 5; passages-only
  here).
- Token budget enforced via `js-tiktoken` cl100k_base.

**Files / folders**
- `apps/api/src/retrieval/context-assembly.ts`
- `apps/api/src/retrieval/tokenizer.ts`

**Exit criteria**
- Output context fits within `max_context_tokens`.
- Citation markers sequential, no per-layer prefixes.
- **Order-preservation test pinned**: hydrated rows in reverse DB
  order still emit `[1]`, `[2]`, `[3]` in fused-rank order.

---

### 4.5 Prompt construction + synthesis call

**Work**
- Consumer-supplied system + developer prompts respected.
- Mandatory platform suffix appended after consumer's developer
  prompt: "cite chunks by [N], from provided context only".
- Synthesis call via Phase 2 `resolve(env, ...)` → AI Gateway →
  resolved inference provider.
- **Reranker no-op interface**: every Phase 4 response carries
  `audit.reranker = { enabled: false }`. Phase 5 flips
  `enabled: true` without changing the audit field's name or
  position.

**Files / folders**
- `apps/api/src/synthesis/prompt-builder.ts`
- `apps/api/src/synthesis/generator.ts`

**Exit criteria**
- A query that requires retrieval returns a coherent answer with
  numbered citations.
- A custom system prompt changes output framing (verified by content).
- `audit.reranker.enabled === false` on every response.

---

### 4.6 Citation grounding + degradation level

**Work**
- Validate every cited `[N]` against the assembled context.
- **Never mutate answer prose.** Invalid markers stay in text;
  invalid Ns recorded in `audit.dropped_citations` and excluded from
  the returned `citations[]` array. Structured-mode citation arrays
  are filtered (the array is explicit).
- Granular audit fields ride alongside `degradation_level`:
  `retrieval_status`, `citation_integrity`,
  `synthesis_status`, `dense_candidates_returned`,
  `sparse_candidates_returned`, `embedding_missing_count`,
  `dropped_citations`.

**Files / folders**
- `apps/api/src/synthesis/citation-validator.ts`
- `apps/api/src/synthesis/degradation.ts`

**Exit criteria**
- Valid citations: `degradation_level='full'`.
- Invalid `[99]` citation: answer text unchanged (verbatim from
  provider), `citations[]` excludes it, `dropped_citations=[99]`,
  `degradation_level='no_citations'`.
- Empty retrieval: `degradation_level='cannot_answer'`, no
  synthesis call made.

---

### 4.7 Structured output mode

**Work**
- `output.mode === 'structured'` triggers provider's structured-output
  path (OpenAI `response_format`, Anthropic tool use, Workers AI JSON
  mode).
- Validate against `output.schema` via **Ajv 8** (compiled validators).
- Schema-violation: keep answer in `answer.raw`, set
  `degradation_level='partial'`, do NOT 500.
- When schema declares a `citations` field, run the same validation
  rules as 4.6.

**Files / folders**
- `apps/api/src/synthesis/structured-output.ts`

**Exit criteria**
- A query with a JSON schema returns valid JSON matching that schema.
- Schema-violating output returns `degradation_level='partial'` with
  `answer.raw` populated, not a 500.

---

### 4.8 `POST /v1/query` endpoint

**Work**
- The route ties together 4.1–4.7.
- Response shape uses a **tagged answer object**: `answer = { mode:
  'text' | 'structured', text?, object?, raw? }` (discriminated
  union). No `string | object` runtime branching.
- `audit.tokens` is an explicit breakdown:
  `{ embedding_input, synthesis_input, synthesis_output, context }`.

**Files / folders**
- `apps/api/src/routes/query.ts`
- `packages/contracts/src/query.ts`

**Exit criteria**
- E2E: register tenant → register namespace → ingest a fixture
  document → query it → receive answer with at least one valid
  citation.
- The tagged `answer` object validates against the Zod schema.
- Latency under 4 s p95 for a 1500-token answer with 12 citations
  (recorded; not PR-blocking — same policy as Phase 2 live smoke).
- The route appears in `/openapi.json` automatically (Phase 1.7
  coverage test catches it).

---

### 4.9 `query_events` audit writes

**Work**
- **Insert-early, update-through-stages** (`received →
  retrieval_started → retrieval_completed → synthesis_started →
  completed | failed`). A `query_events` row exists for every query,
  including failed ones (EMBEDDING_PROFILE_MISMATCH, retrieval-empty,
  provider-quota-exhausted, schema-validation failed).
- `request_config` redacted per `tenants.audit_mode`
  (`full | redacted | metadata_only`, default `full`). A
  tenant-salted `request_config_hash` is always written so
  duplicate queries are recognizable across audit modes.
- `total_cost_usd_micros = NULL` in Phase 4 (a Phase 6
  `provider_model_prices` table fills this in).
- Best-effort R2 mirror at `{tenant_id}/{namespace_id}/answers/
  {query_event_id}.json` (no `document_id` segment). On success
  populate `answer_r2_key`; on failure populate `mirror_error` and
  leave `answer_r2_key` NULL.

**Files / folders**
- `apps/api/src/audit/query-events.ts`
- `apps/api/src/routes/query-events.ts` (`GET /v1/query-events/:id`)

**Exit criteria**
- A `query_events` row exists for **every** query (success, partial,
  or failed).
- For successful mirrors: `answer_r2_key` populated and the R2
  object exists.
- For failed mirrors: `answer_r2_key IS NULL`, `mirror_error`
  populated, response unaffected.
- `audit_mode='redacted'` tenant: persisted `request_config` shows
  `[REDACTED]` for prompt+query fields; resolved provider/model and
  token counts are unaffected.
- `total_cost_usd_micros IS NULL` in every Phase 4 row.

---

### 4.10 Phase 4 close-out — mandatory items

Beyond passing tests, these must hold to tag `phase-4-complete`:

1. Hydrated chunks re-sorted by fused rank before token-budget
   inclusion (order-preservation test pinned).
2. Retrieval uses `Promise.allSettled`; sparse-only / dense-only
   fallback paths exercised by fault-injection tests.
3. `audit.retrieval_status`, `dense_candidates_returned`,
   `sparse_candidates_returned`, `embedding_missing_count` populated
   on every response.
4. R2 mirror best-effort with acceptance reflecting that
   (`answer_r2_key` null on failure).
5. `query_events` row written for failed queries.
6. `tenants.audit_mode` redaction enforced in `request_config`.
7. `QueryResponse.answer` is the tagged discriminated union.
8. Citation validation does not mutate answer prose.
9. `audit.reranker = { enabled: false }` present on every Phase 4
   response.

---

## Phase 5 — Corpus Profiles + Enrichment

**Goal:** Multiple corpus profiles work end-to-end: a legal document
and a narrative document each ingest with their own enrichment passes
and respond to queries with profile-appropriate retrieval defaults.
Reranker integration online.

### 5.1 Profile loader

**Work**
- YAML-driven profile bundles loaded at boot in both Worker and
  Container.
- Schema-validated against a Zod schema (one source of truth).

**Files / folders**
- `packages/corpus-profiles/profiles/*.yaml`
- `packages/corpus-profiles/src/loader.ts`
- `packages/corpus-profiles/src/schema.ts`

**Exit criteria**
- Loading an invalid profile produces a clear error at boot.
- Worker + Container both load the same profiles from the same
  source.

---

### 5.2 `generic` profile

**Work**
- Passages-only, no enrichment, hybrid_rrf retrieval default.
- The fallback profile when no other applies.

**Files / folders**
- `packages/corpus-profiles/profiles/generic.yaml`

**Exit criteria**
- A namespace with `corpus_profile: generic` ingests + queries
  successfully end-to-end.

---

### 5.3 `narrative` profile (port from v1)

**Work**
- Passages, section_summary, scene, character_dossier, theme
  artifact types.
- Enrichment passes ported from v1's enrichment pipeline,
  generalized: section_summary replaces "chapter_summary".
- Multi-layer retrieval defaults (passages + summaries + scenes).

**Files / folders**
- `packages/corpus-profiles/profiles/narrative.yaml`
- `apps/ingest/app/enrichment/narrative/section_summary.py`
- `apps/ingest/app/enrichment/narrative/scene.py`
- `apps/ingest/app/enrichment/narrative/character_dossier.py`
- `apps/ingest/app/enrichment/narrative/theme.py`

**Exit criteria**
- A novel ingests through all 4 enrichment passes; their artifacts
  appear as separate `chunks.artifact_type` values.
- Querying the novel surfaces character_dossier hits when relevant.

---

### 5.4 `legal` profile

**Work**
- Legal-clause-aware chunker (chunk on numbered clauses, not just
  paragraph boundaries).
- `clause_extraction` and `obligation_extraction` enrichment passes.
- Retrieval defaults favor clause + obligation artifact types alongside
  passages.

**Files / folders**
- `packages/corpus-profiles/profiles/legal.yaml`
- `apps/ingest/app/chunkers/legal_clause_aware.py`
- `apps/ingest/app/enrichment/legal/clause.py`
- `apps/ingest/app/enrichment/legal/obligation.py`

**Exit criteria**
- A lease document ingests, produces clause + obligation artifacts.
- A "what happens if rent is late" query returns clause-grounded
  citations.

---

### 5.5 `support` and `technical` profiles

**Work**
- `support`: troubleshooting-step extraction, FAQ-style retrieval.
- `technical`: endpoint/code-reference extraction, code-aware
  chunking (don't split inside a code fence).

**Files / folders**
- `packages/corpus-profiles/profiles/support.yaml`
- `packages/corpus-profiles/profiles/technical.yaml`
- `apps/ingest/app/chunkers/code_aware.py`
- `apps/ingest/app/enrichment/support/troubleshooting_step.py`
- `apps/ingest/app/enrichment/technical/endpoint_reference.py`

**Exit criteria**
- One representative document for each profile ingests + queries
  successfully.

---

### 5.6 Enrichment pass framework

**Work**
- `EnrichmentPass` interface: `id`, `depends_on`, `required`,
  `failure_is_fatal`, `run(ctx)`.
- Topological ordering, dependent-skip on prerequisite failure.
- Per-pass model directives (a pass can override the default
  enrichment model).

**Files / folders**
- `apps/ingest/app/enrichment/runner.py`
- `apps/ingest/app/enrichment/types.py`

**Exit criteria**
- A profile with 4 passes (A → B → C, plus D depending on B) executes
  in correct order; if B fails, C and D skip; if D fails with
  `required=false`, the job still completes with
  `enrichment_status=partial`.

---

### 5.7 Per-layer context-budget allocation

**Work**
- Context assembly (Phase 4.4) extended to honor per-layer budget
  shares from the corpus profile.
- A profile can declare e.g. `passages: 60%, section_summary: 20%,
  character_dossier: 20%`.

**Files / folders**
- `apps/api/src/retrieval/context-assembly.ts` (extended)

**Exit criteria**
- Context block respects per-layer ratios within ±5% of declared
  budget.

---

### 5.8 Reranker integration

**Work**
- Wire the Voyage rerank provider (Phase 2.6) into the retrieval
  pipeline.
- Configurable per request: `retrieval.rerank.{enabled, provider, top_n}`.
- Skip rerank if `enabled=false` or insufficient candidates.

**Files / folders**
- `apps/api/src/retrieval/rerank.ts`

**Exit criteria**
- A rerank-enabled query measurably improves citation precision on a
  small benchmark fixture (defined in Phase 7).
- Rerank failure (provider quota / 5xx) gracefully falls back to
  unranked top-N from RRF.

---

## Phase 6 — Failure Surface + Observability + Streaming

**Goal:** Every error has a stable code, every meaningful event is
audited or surfaced in dashboards, streaming works for long answers,
and the DLQ is inspectable.

### 6.1 Standardized error envelope across all routes

**Work**
- A central error class `TextralError(code, http_status, message,
  details)`.
- Global error handler in the Worker formats every thrown error into
  the standard envelope.
- Error catalog in `packages/contracts` (one source of truth).

**Files / folders**
- `apps/api/src/middleware/error-handler.ts`
- `packages/contracts/src/errors-catalog.ts`

**Exit criteria**
- 100% of `apps/api` routes return the standard envelope on error
  (verified by a route-snapshot test).
- Every error code in the catalog has a documentation entry.

---

### 6.2 DLQ inspection + retry endpoints

**Work**
- `GET /v1/admin/ingestion-jobs?dead_lettered=1` (admin scope only).
- `POST /v1/ingestion-jobs/:id/retry` clears `dead_lettered`,
  re-enqueues.

**Files / folders**
- `apps/api/src/routes/admin/ingestion-jobs.ts`

**Exit criteria**
- DLQ list returns rows for known failed jobs.
- Retry of a quota-exhausted job after key replacement succeeds.

---

### 6.3 Workers Analytics Engine metrics

**Work**
- Custom datasets for: `query_executions`, `ingestion_stage_outcomes`,
  `provider_calls`.
- Per-dataset write helpers in `src/observability/metrics.ts`.

**Files / folders**
- `apps/api/src/observability/metrics.ts`
- Dashboard JSON exports in `docs/runbooks/dashboards/`.

**Exit criteria**
- Live dashboard shows: per-tenant query QPS, p50/p95/p99 latency,
  degradation-level distribution, ingestion throughput.

---

### 6.4 AI Gateway tag propagation

**Work**
- Every provider call carries `cf-aig-metadata` with `tenant_id`,
  `namespace_id`, `query_event_id`, and `provider_key_id`.
- Phase 1.6 redaction middleware verified to strip raw keys but
  preserve these tags.

**Files / folders**
- `apps/api/src/providers/ai-gateway.ts` (extended)

**Exit criteria**
- AI Gateway dashboard groups by tenant_id correctly.
- No provider key fragments appear in any tag.

---

### 6.5 Streaming responses (SSE)

**Work**
- `POST /v1/query?stream=sse` returns SSE.
- Two event types: `token` and `done`.
- Citation validation runs once on `done`; final event includes
  `degradation_level` and `query_event_id`.

**Files / folders**
- `apps/api/src/routes/query-stream.ts`
- `apps/api/src/synthesis/streaming.ts`

**Exit criteria**
- Stream a 1500-token answer; first token under 1 s, full answer under
  4 s on a warm path.
- Citation drop-on-`done` fires correctly when the stream cites a
  non-existent chunk.

---

### 6.6 Alerts

**Work**
- Configure alert rules in Cloudflare for the metric set in
  `1-DESIGN.md` §15.3.
- Notification routing (PagerDuty / email / Slack — pick one for MVP).

**Files / folders**
- `docs/runbooks/ALERTS.md`

**Exit criteria**
- Each alert manually triggered fires and routes correctly.

---

### 6.7 Cost rollup — `usage_records` writes

> Captures Phase 5's deferral: `usage_records` table exists in
> migration 0001 but no code writes to it. Phase 6 lands the writes so
> Phase 8's cost-attribution test (§8.6) has a numbers source.

**Work**
- A `recordUsage(env, tenant_id, kind, args)` helper that upserts the
  daily bucket via SQL `ON CONFLICT (tenant_id, period_start) DO UPDATE
  SET ... = ... + ?`.
- Call sites: `routes/query.ts` (after a successful synthesis writes
  `queries+1`, `input_tokens`, `output_tokens`); `routes/internal/
  ingest-write.ts` and the embed-stage handler (after stage commit:
  `ingestion_jobs+1` once per job, `embedding_tokens` per batch).
- Periodic GC: a scheduled handler (or admin-triggered) prunes rows
  older than 90 days. Out of scope here if a CF cron isn't yet wired —
  document the cleanup query for Phase 8.

**Files / folders**
- `apps/api/src/db/usage-records.ts`
- `apps/api/src/observability/usage.ts` (the recordUsage facade)

**Exit criteria**
- After a query, the corresponding `usage_records` row reflects
  `queries+=1`, `input_tokens+=...`, `output_tokens+=...`.
- After an ingestion run, `ingestion_jobs+=1`, `embedding_tokens+=...`.
- Failure paths do NOT increment cost columns (only success paths do).

---

### 6.8 Bulk enrichment-only admin endpoint

> Captures Phase 5's deferral: backfilling enrichment over already-
> ingested documents. The single-document path is `POST /v1/documents/:id/ingest`
> with `mode='enrichment_only'`; the bulk admin endpoint operates over
> a set.

**Work**
- `POST /v1/admin/namespaces/:slug/enrichment-runs` with body
  `{ filter: { profile_id?, since?, until?, limit? }, dry_run?: bool }`.
  Selects affected `version_indexes` (any in `('ready','partial')`
  status whose `corpus_profile` matches the filter), enqueues
  `enrichment_only` jobs in batch.
- Returns `{ matched: N, enqueued: N, dry_run: bool }`.
- Enforces admin scope on the API key; rate-limited at 10 batches /
  min / tenant.

**Files / folders**
- `apps/api/src/routes/admin/enrichment-runs.ts`
- `packages/contracts/src/admin.ts`

**Exit criteria**
- Dry-run reports the correct count without enqueuing.
- A real run produces N `ingestion_jobs` rows of `mode='enrichment_only'`
  in `pending` status.
- Cross-tenant access denied (tenant scoping verified).

---

### 6.9 Tenant-scoped corpus-profile overrides — POST-MVP

> Phase 5 deferred this; the Phase 6 close-out **also** defers it.
>
> The MVP path is: namespace declares `corpus_profile` (one of the
> shipped 5), and per-request bodies can override fields. That's
> sufficient for the first wave of tenants because:
>   1. Most tenants want one of the 5 shipped profiles unmodified.
>   2. The few who want tweaks can pin the override in their SDK
>      wrapper and pass it on every call.
>
> Post-MVP, we add a `tenant_corpus_overrides` D1 table keyed by
> `(tenant_id, profile_id)` storing a JSON override applied during
> namespace resolution. Until then: any tenant who really needs
> persistent overrides can be served by carving a per-tenant YAML
> profile and recording it in their namespace.
>
> No code lands for this in Phase 6. A row in this section so future
> implementers know it was a deliberate omission, not an oversight.

---

## Phase 7 — Eval Contract

**Goal:** Tenants can define golden-set evaluations per namespace, run
them on demand, and read aggregate scores. Textral itself uses the
same surface for internal regression checks.

### 7.1 Eval D1 migrations

**Work**
- Migration 0003: `eval_sets`, `eval_questions`, `eval_runs`,
  `eval_results`.

**Files / folders**
- `apps/api/migrations/0003_eval.sql`

**Exit criteria**
- Migrations apply cleanly.
- Schema supports per-question pass/fail + numeric scores.

---

### 7.2 Eval API endpoints

**Work**
- `POST /v1/namespaces/:ns/eval-sets` — register golden set.
- `POST /v1/namespaces/:ns/eval-sets/:id/runs` — run.
- `GET .../runs/:runId` — fetch results.

**Files / folders**
- `apps/api/src/routes/eval.ts`
- `packages/contracts/src/eval.ts`

**Exit criteria**
- Round-trip: register a set with 5 questions, run, fetch results.

---

### 7.3 Judge prompts

**Work**
- Built-in judge prompts (relevance, groundedness, citation_quality)
  per `1-DESIGN.md` §16.
- Tenant can supply custom judge prompts.

**Files / folders**
- `apps/api/src/eval/judges.ts`
- `apps/api/src/eval/judge-prompts/*.md`

**Exit criteria**
- Built-in judges score a known-good and known-bad answer correctly
  on a fixture.

---

### 7.4 `packages/eval-cli`

**Work**
- Tenant-side CLI: `textral eval run <set-id>` with a `.textralrc`
  config (api key + namespace).
- Output: machine-readable JSON + human-readable summary.
- Designed to drop into a tenant's CI as a regression gate.

**Files / folders**
- `packages/eval-cli/src/index.ts`
- `packages/eval-cli/bin/textral`

**Exit criteria**
- A demo CI workflow uses the CLI as a non-zero-exit-on-regression
  gate.

---

### 7.5 Baseline fixture eval

**Work**
- Port v1's 21-question golden set against `where_the_silence_was.md`
  to the new shape.
- A second small fixture for the `legal` profile (10 questions over a
  sample lease).

**Files / folders**
- `apps/api/test/fixtures/eval/narrative-where-silence.json`
- `apps/api/test/fixtures/eval/legal-sample-lease.json`
- `apps/api/test/fixtures/corpora/where_the_silence_was.md`
- `apps/api/test/fixtures/corpora/sample_lease.txt`

**Exit criteria**
- Both fixtures produce non-trivial, repeatable scores.
- Score deltas across PRs are visible in CI artifacts.

---

## Phase 8 — End-to-End Verification & Sign-Off

**Goal:** Confidence that MVP is shippable to a real consumer.
Hardening, security review, runbooks, and the green-light checklist.

### 8.1 E2E test suite

**Work**
- A single test file that walks the entire happy path: register tenant
  → register provider key → register namespace → upload document →
  ingest → query → verify citations → audit lookup → eval run.
- Covers narrative + legal profiles.
- Runs against dev environment in CI.

**Files / folders**
- `apps/api/test/e2e/happy-path.test.ts`

**Exit criteria**
- The test runs green on every PR; sustained green for 7 consecutive
  days before sign-off.

---

### 8.2 Multi-tenant isolation tests

**Work**
- Cross-tenant query attempts (must 404, not 403).
- Cross-tenant audit access (must 404).
- Cross-tenant Vectorize query (must return 0 even with a malicious
  metadata filter — proven by direct binding test).

**Files / folders**
- `apps/api/test/security/tenant-isolation.test.ts`

**Exit criteria**
- All cross-tenant probes fail with the correct error code.
- A targeted audit by an outside reviewer signs off on isolation.

---

### 8.3 Failure-injection tests

**Work**
- `insufficient_quota` → fatal, no retry, clean error message
  surfaced.
- `invalid_api_key` → same.
- `EMBEDDING_PROFILE_MISMATCH` at query time.
- DLQ flow: a job dies, lands in DLQ, admin retry succeeds after
  key fix.
- AI Gateway outage simulation: synth degrades to `cannot_answer`.

**Files / folders**
- `apps/api/test/failure/injection.test.ts`

**Exit criteria**
- Each injected failure produces the documented error code, status
  code, and audit row.

---

### 8.4 Load test

**Work**
- A scripted load test against dev:
  - 100 concurrent queries for 5 min, sustained QPS target ≥ 20.
  - 50 ingestion jobs queued in parallel, target throughput per
    Container instance.
- Captures p50/p95/p99 query latency, ingestion stage durations,
  cost per query.

**Files / folders**
- `tools/load/k6-query.js` (or `tools/load/oha-query.sh`)
- `tools/load/k6-ingest.js`
- `docs/runbooks/LOAD_TEST_RESULTS.md`

**Exit criteria**
- Sustained QPS without 5xx error rate exceeding 0.5%.
- p95 query latency ≤ 4 s.
- No goroutine/Worker isolation leaks observed.

---

### 8.5 Security review

**Work**
- Manual review of:
  - Redaction middleware (Phase 1.6) — fuzz with novel key shapes.
  - Provider-key custody flow end-to-end.
  - Tenant-isolation invariants (every D1 query, every Vectorize call,
    every R2 read).
  - The dev-only `__redaction_check` route is unreachable in prod.
  - API-key revocation propagates in under 60 s.
- Threat model written down.

**Files / folders**
- `docs/security/THREAT_MODEL.md`
- `docs/security/REVIEW_2026-MM-DD.md`

**Exit criteria**
- Threat model reviewed by at least one engineer outside the original
  authors.
- No P0/P1 findings open.

---

### 8.6 Cost-attribution end-to-end

**Work**
- A test query produces matching cost numbers in:
  - The provider's own dashboard (OpenAI billing).
  - AI Gateway dashboard for that tenant.
  - `query_events.total_cost_usd_micros`.
- Reconciliation script in `tools/billing/reconcile.ts`.

**Files / folders**
- `tools/billing/reconcile.ts`
- `docs/runbooks/COST_RECONCILIATION.md`

**Exit criteria**
- All three numbers agree within ±1¢ for a representative day.

---

### 8.7 Documentation pass

**Work**
- `README.md` (top-level) — what Textral is + 5-minute quickstart.
- `docs/API.md` — full API reference (or auto-generated openapi.json).
- `docs/QUICKSTART.md` — register tenant → ingest → query in 5 min.
- `docs/runbooks/DEPLOY.md` — production deploy checklist.
- `docs/runbooks/INCIDENTS.md` — common incidents + responses.

**Files / folders**
- `README.md`
- `docs/API.md`
- `docs/QUICKSTART.md`
- `docs/runbooks/*.md`

**Exit criteria**
- A new engineer can go from clone → working dev environment in under
  60 minutes following only the docs.

---

### 8.8 Sign-off checklist

A single document with hard pass/fail boxes:

- [ ] Phase 0–7 exit criteria all green.
- [ ] E2E test green for 7 consecutive days.
- [ ] No P0/P1 security findings.
- [ ] Load test targets met.
- [ ] Cost reconciliation accurate.
- [ ] Threat model approved.
- [ ] Quickstart works for an outside reader.
- [ ] At least one tenant onboarded against dev environment in a real
      use case.
- [ ] Migration runbook tested on a fresh CF account.
- [ ] DLQ + alerts proven via a real injected incident.

**Files / folders**
- `docs/SIGNOFF.md`

**Exit criteria**
- Every box checked. Tag a `v0.1.0` release.

---

## Cross-Phase Conventions

A few rules that apply through every phase:

- **Every phase ends with green CI** — no phase merges without typecheck
  + lint + tests + at least one E2E pass against dev.
- **Every sub-phase is one or two PRs.** If a sub-phase is fanning out
  to four or more PRs, it should be split.
- **Migrations are append-only.** No edits to applied migrations; new
  ones supersede.
- **Every PR includes an audit-log line if it adds behavior the user
  is paying for.** No silent cost drift.
- **Every new error code lands in `packages/contracts/src/errors-catalog.ts`
  in the same PR.** No scattered string literals.
- **Every new persisted parameter has a column in `query_events` or
  `ingestion_jobs`.** No "we'll add it later" auditability gaps.
- **Phase boundaries are review checkpoints** — at the end of each phase,
  a brief retrospective doc lands in `docs/retrospectives/phase-N.md`
  capturing what changed vs the original plan.

---

## Estimated Phase Sizing

A rough sense of relative effort. Useful for planning, not commitment.

| Phase | Estimated weeks (1 eng) | Risk |
|-------|------------------------|------|
| 0 | 0.5 | low |
| 1 | 1.0 | medium (BYOK custody) |
| 2 | 1.0 | medium (provider error semantics) |
| 3 | 2.0 | high (Container queue worker, idempotency, replay) |
| 4 | 1.5 | medium (FTS5 quality, citation grounding) |
| 5 | 2.0 | medium (profile abstraction depth) |
| 6 | 1.0 | low |
| 7 | 1.0 | low |
| 8 | 1.5 | medium (load + security review) |
| **Total** | **~12 weeks** | |

A second engineer can parallelize Phases 2 + 3 and Phases 5 + 6,
trimming wall clock to ~8 weeks.

---

## What This Doc Is Not

- Not a sprint plan. Phase boundaries are dependency boundaries, not
  time boxes.
- Not exhaustive. Each phase will surface sub-tasks not enumerated
  here; the rule is they belong to the phase whose exit criteria they
  unblock.
- Not negotiable on order. Phase 3 cannot ship without Phase 2; Phase
  4 cannot ship without Phase 3. Within a phase, sub-phases can
  parallelize where their files don't collide.

The intent: at any moment, the active engineer should be able to
point at a single phase and a single sub-phase, name what's open in
it, and demonstrate the exit criteria they're working toward.
