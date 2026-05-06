# Phase 3 + 4 — Implementation Steps

> Companion to `docs/2-PHASES.md`. Concrete, ordered steps for Phase 3
> (ingestion: core stages + Container worker) and Phase 4 (retrieval +
> synthesis: end-to-end query path).
>
> A dev should be able to follow this document end-to-end and finish
> Phases 3 and 4 without making design decisions or asking questions.
> Where the design doc left a choice open, this document picks one.

---

**At completion, you will have:** a tenant can register a document,
get a presigned R2 upload URL, upload bytes, kick off ingestion, watch
five core stages run in the Container (fetch → normalize → chunk →
embed → index) with stage-level logs, idempotent replay, and
embedding-profile compatibility on the write side; and the same tenant
can `POST /v1/query` against the indexed document and receive a
citation-grounded answer (sync or structured) with a `degradation_level`
and a `query_event_id` written to the audit table. Hybrid retrieval
(D1 FTS5 + Vectorize fused via RRF) runs entirely on the Worker.
Reranking is wired but disabled by default until corpus-profile
defaults arrive in Phase 5.

---

## Revisions applied per `feedback/PHASE_3_4_FEEDBACK.md`

This doc has been revised to address every item in that feedback file.
Summary of accepted changes (the body has been edited in-line):

1. **Internal back-channel auth.** `X-Textral-Internal-Token` is now
   accompanied by an HMAC signature (`X-Textral-Internal-Signature`)
   over `method + path + body_hash + timestamp` plus an
   `X-Textral-Internal-Timestamp` header. Endpoints enforce a 5-minute
   clock-skew window. Every internal write endpoint also re-checks
   tenant + job ownership against D1 — the Container is not trusted to
   self-attribute. (§3.4.3)
2. **R2 hashing.** Finalize streams the uploaded bytes and computes
   `sha256(source bytes)` directly. ETag is no longer used as a
   content-hash contract. Finalize also compares actual R2 object
   `Content-Length` and `Content-Type` against the presign request
   parameters. (§3.2.2)
3. **Finalize is idempotent, not atomic.** Replaced the "atomic in
   practice" wording with an explicit recovery state machine:
   `upload_received → copy_started → copy_completed → version_inserted
   → upload_deleted`. Each step is keyed by `(document_id, content_hash)`
   so re-runs are safe. (§3.2.2)
4. **Source vs index versioning resolved (Option A).** A
   `document_versions` row identifies *source bytes only*
   (`UNIQUE(document_id, content_hash)`). A new `version_indexes` table
   tracks the `(version_id, chunking_profile, embedding_profile)`
   combos that have been built. Chunks point to `version_index_id`.
   Re-ingesting the same source with a different embedding profile
   creates a new `version_index`, not a new `version`. (§3.1, §3.11)
5. **`current_version_id` semantics clarified.**
   `documents.current_version_id` always means *latest successfully
   ingested **source** version*. Query resolution picks
   `(current_version_id, requested_embedding_profile,
   requested_chunking_profile)` and looks up the matching
   `version_index`. (§3.10, §4.2)
6. **Ingestion job lease/lock model.** `ingestion_jobs` gains
   `locked_at`, `locked_by`, `attempt_count`, `lease_expires_at`. Job
   claim is a CAS-style UPDATE that returns row count = 1; queue
   redelivery is safe. (§3.4.5)
7. **Stage attempt history.** Renamed `ingest_logs` →
   `ingest_stage_attempts`, primary key `(job_id, stage, attempt)`.
   Latest-stage queries use `MAX(attempt) WHERE status='completed'`.
   Forensic history is preserved. (§3.1.1, §3.10)
8. **Partial-ingestion invariants formalized.** A new column
   `chunks.embedding_status ∈ {embedded, missing, pending}` makes the
   contract explicit: D1+FTS5 contains all chunks; Vectorize contains
   only `embedded` chunks. Audit fields
   (`retrieval_status`, `dense_candidates_returned`,
   `sparse_candidates_returned`, `embedding_missing_count`) ride
   alongside `degradation_level`. (§3.8, §4.6, §4.8.1)
9. **Vectorize 1536-dim is intentional.** OpenAI
   `text-embedding-3-large` defaults to 3072 dim; Vectorize V2 caps at
   1536; we use OpenAI's `dimensions: 1536` parameter at request time
   to reduce. The embedding profile records both `model` and
   `dimensions` and the embed call always passes `dimensions`
   explicitly. (Prerequisites + §3.8)
10. **Compatibility profile is composite.** The profile gate compares
    both `embedding_profile` AND `chunking_profile` against the
    candidate `version_index`. Mismatch in either field returns 400
    with `EMBEDDING_PROFILE_MISMATCH` (legacy code; carries detail
    fields naming the mismatching dimension). (§4.2)
11. **Worker owns embedding.** Removed the
    `/internal/secrets/resolve` endpoint and the Python OpenAI
    provider. Container POSTs to `/internal/providers/embed` instead;
    Worker resolves the provider key, applies AI Gateway routing +
    redaction + Phase 2 retry/classification. Single source of
    provider truth. (§3.4.3, §3.8)
12. **Conservative FTS5 tokenize.** Default query mode tokenizes
    consumer query into safe alphanumeric terms + quoted phrases,
    drops FTS5 operators (`AND OR NOT NEAR ^ : -`), OR-joins.
    `advanced_query: true` mode is reserved for a later phase.
    (§4.1.1)
13. **Hydrate then re-sort.** Context assembly hydrates with
    `WHERE id IN (...)` then re-sorts the result rows by their fused
    rank position before token-budget greedy inclusion. Test pinned.
    (§4.4)
14. **Citation validation never mutates answer prose.** The answer
    text returns unchanged. Invalid `[N]` markers are recorded in
    `audit.dropped_citations` and excluded from the returned
    `citations` array. `degradation_level` is set accordingly.
    Structured-mode citation arrays are filtered (the array is
    explicit; no prose mutation needed). (§4.6)
15. **`degradation_level` is citation-integrity, not faithfulness.**
    Added granular audit fields (`citation_integrity`,
    `retrieval_status`, `synthesis_status`) so the coarse enum stays
    cheap to consume but the diagnostic detail is captured. (§4.6,
    §4.8.1)
16. **R2 mirror acceptance fixed.** `query_events` row is mandatory
    for every query (success or failure). The R2 mirror at
    `answers/{query_event_id}.json` is best-effort; on failure,
    `answer_r2_key` is null and `mirror_error` is recorded. A future
    sweeper (Phase 6) reconciles. (§4.9)
17. **Cost accounting deferred.** `total_cost_usd_micros` is `NULL`
    in Phase 4. A `provider_model_prices` table with effective dates
    arrives in Phase 6 (observability). No hardcoded constants.
    (§4.9)
18. **Query events for failures.** `query_events` row inserted as
    soon as tenant + namespace are resolved; updated as the query
    progresses through retrieval / synthesis / completion. Failed
    queries (EMBEDDING_PROFILE_MISMATCH, retrieval empty, provider
    exhausted, schema-validation failed) all appear in audit. (§4.9)
19. **Audit-mode tenant setting.** New column `tenants.audit_mode ∈
    {full, redacted, metadata_only}`, default `full`. Determines what
    portion of the request body is persisted in
    `query_events.request_config`. Enterprise tenants who don't want
    full prompt retention can opt to `redacted` (system + developer
    prompts replaced with `[REDACTED]`) or `metadata_only` (only
    structural fields preserved). (§3.1.1, §4.9)
20. **R2 answer path.** Stable layout
    `{tenant_id}/{namespace_id}/answers/{query_event_id}.json` —
    document IDs go inside the JSON. The optional `document_id` path
    segment is dropped. (§4.9)
21. **Promise.allSettled retrieval.** Dense + sparse run via
    `Promise.allSettled`. Single-arm failures degrade to the surviving
    arm with `retrieval_status` audit field set
    (`full | dense_only | sparse_only | empty`). Both arms failed →
    `RETRIEVAL_FAILED`. (§4.1.3)
22. **Reranker no-op interface.** `audit.reranker = { enabled: false }`
    is emitted in every response in Phase 4. Phase 5 flips
    `enabled: true` without changing response shape. (§4.5.2, §4.8.1)
23. **Pydantic mutable-default fix.** All CDM types use
    `Field(default_factory=dict)` / `Field(default_factory=list)`.
    (§3.6.1)
24. **Chunk IDs are deterministic and human-debuggable.** Format:
    `chk_<version_id>_<zero_padded_ord>` (e.g., `chk_ver_01HZ8YS2C..._00042`).
    No more "deterministic ULID" wording. (§3.7)
25. **`chunks.jsonl` carries a schema-version header.** First line is a
    JSON object `{"type":"header","schema_version":"chunk_jsonl_v1",
    "version_id":"...","chunking_profile":"...","chunk_count":N}`.
    (§3.7)
26. **Per-chunk embedding diagnostics.** `chunks` gains
    `embedding_input_hash`, `embedding_provider_request_id`,
    `embedding_dimensions`. Lets ops verify a Vectorize vector
    corresponds to the expected text without storing the vector.
    (§3.8, §3.9)
27. **Tagged `answer` object.** `QueryResponse.answer` is now
    `{ mode: 'text' | 'structured', text?, object?, raw? }`. No more
    `string | object` runtime branching at the consumer. (§4.8.1)
28. **Token breakdown.** `audit.tokens` carries
    `{ embedding_input, synthesis_input, synthesis_output, context }`
    instead of flat `input_tokens` / `output_tokens`. (§4.8.1, §4.9)
29. **Provider-key refs canonicalized at dispatch.** Public API still
    accepts `provider_key_ref: "label"` for ergonomics, but dispatch
    resolves the label to a `pkey_*` ID and persists the resolved ID
    in `ingestion_jobs.config_json`. Subsequent reads always see the
    ID, not the label. (§3.3.2)
30. **Explicit deletion / re-index behavior.** `replace_existing_vectors:
    true` semantics documented: delete by metadata filter on
    `(document_id, version_id, embedding_profile, chunking_profile)`
    before upsert. Operational caveats around Vectorize
    delete-by-filter constraints noted. (§3.9)

---

## Prerequisites

Phase 0, 1, 1.7, and 2 are closed. Specifically:
- The Worker exposes the auto-generated OpenAPI spec at `/openapi.json`
  and renders Scalar at `/docs`.
- The Worker has working API-key auth, namespace + provider-key CRUD,
  redaction middleware in front of every route, and the `/v1/provider-keys/:id/test`
  validation endpoint lit up.
- The Container (`apps/ingest`) has a `/healthz` endpoint and the
  Cloudflare Container application is deployed; `/dev/ingest-ping`
  round-trips through the Durable Object binding.
- `apps/api/src/providers/` exposes the four-outcome `ProviderResult`
  abstraction, `OpenAICompatProvider`, `WorkersAIBindingProvider`,
  `AnthropicProvider`, `VoyageRerankProvider`, `CohereRerankProvider`,
  the registry, and `validateProviderKey`.
- Vectorize index `textral-{env}-openai-text-embedding-3-large-1536-cosine`
  exists with the five filterable metadata indexes
  (`tenant_id`, `namespace_id`, `document_id`, `version_id`, `artifact_type`).
  **The 1536-dim is intentional**: OpenAI `text-embedding-3-large` defaults
  to 3072 dim, but Vectorize V2 caps single-vector dims at 1536. We use
  OpenAI's `dimensions: 1536` request parameter to truncate at the
  provider. Every embed call passes `dimensions` explicitly; the
  embedding profile records both `model` and `dimensions` so silent
  drift is impossible.
- Queue `textral-ingest-{env}` is provisioned (producer is bound;
  consumer wiring lights up here).

Operational prereqs:
- `pnpm` and Node 24 (per `feedback_node_version.md`).
- Working `wrangler login` and `tools/wrangler-env.sh` sourced; Phase
  1.1 token (the consolidated AI token) carries enough perms.
- One real OpenAI key registered as a provider key under the seed
  tenant for live smoke tests.

---

## Locked-in technology choices

These were left open in the phases doc; locking them now.

### Phase 3 — Ingestion

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Container ↔ Worker invocation | **Worker is the Queue consumer**, fans each message out to the Container's `/jobs/run` endpoint via the Durable Object binding | Wrangler's queue consumer must live in the Worker; the Container is the actual processor. One round trip per message. |
| Queue message payload | **Job pointer only** (`job_id`, `tenant_id`, `attempt`) | The Container reloads the full `ingestion_jobs.config_json` from D1 on entry. Keeps the queue payload small and idempotent. |
| Internal back-channel auth | **HMAC-SHA-256 signature** over `method + path + sha256(body) + timestamp` plus a 5-minute clock-skew window. Bearer-only is a leak vector. | A static bearer can leak through logs/traces/crash dumps. HMAC + timestamp + replay protection is the standard pattern for service-to-service in trusted networks. |
| Internal endpoint authz | **Re-check tenant + job ownership against D1 on every call** | The Container is not trusted to self-attribute. `/internal/chunks/batch` re-validates that the supplied `job_id` is in `running` state, that every chunk's `tenant_id`/`document_id`/`version_id` matches that job, etc. |
| Container HTTP framework | **FastAPI + uvicorn** (already in place from Phase 0.3) | No change; just add routes. |
| Source upload bytes | **Single PUT presigned URL**, max 25 MB at MVP | Multipart upload deferred until consumer use cases require it. |
| Source content hash | **`sha256(source bytes)` streamed at finalize time** | Portable, predictable, independent of R2 ETag semantics. Cost is acceptable at 25 MB. |
| Source size/type validation | **Compare R2 object `Content-Length` and `Content-Type` against the presign request** | Otherwise a client can presign 12 bytes of `text/plain` and finalize a 25 MB executable. |
| Source versioning model | **Source-only**: `document_versions` is unique on `(document_id, content_hash)` | A "version" identifies bytes, not pipeline state. Re-uploading identical bytes returns the existing version row. |
| Index versioning model | **`version_indexes`** table tracks `(version_id, chunking_profile, embedding_profile)` combos. Chunks point to `version_index_id` | Re-ingesting the same source under a different embedding profile creates a new `version_index`, not a new `version`. Old indexes remain queryable. |
| `current_version_id` semantics | **Latest successfully ingested SOURCE version**, embedding-profile-agnostic | Query resolution picks `(current_version_id, requested_profile)` and looks up the matching `version_index`. |
| Normalizers in scope | **txt, md, EPUB** | PDF deferred to Phase 8 / future. HTML enters via the EPUB parser. |
| Tokenizer (Python) | **`tiktoken`** for OpenAI-family models, **`tokenizers`** for Workers AI when used | Same tokenizer the embed model expects → token budgets are honest. |
| Generic chunker | **600-token target, 80-token overlap, never crosses a major-section boundary** | Matches the design doc default; Phase 5 introduces corpus-specific overrides. |
| Chunk ID format | **`chk_<version_id>_<zero_padded_ord>`** (e.g. `chk_ver_01HZ8YS2C..._00042`) | Deterministic, human-debuggable, sortable. ULIDs encode time randomness; "deterministic ULID" is a contradiction in terms. |
| Embed call path | **Container POSTs to Worker `/internal/providers/embed`**; Worker resolves the provider key, applies AI Gateway routing + redaction + Phase 2 retry/classification | Single source of provider truth. Eliminates Python-side provider duplication and the contract-drift risk between TS and Python error classification. |
| Embed batching | **100 inputs/request for OpenAI, 96 for Workers AI compat**; the Worker enforces the limit, the Container chunks accordingly | Provider documented limits; honest to the provider, not to a guessed number. |
| D1 chunk insert path | **One batch `executeMany`-style INSERT per N=200 chunks** via the Worker, not the Container | The D1 binding is on the Worker; the Container POSTs an internal write endpoint exposed by the Worker. Saves us implementing a CF API client in Python for D1. |
| Vectorize upsert path | **Worker upserts via `env.VECTORIZE_*.upsert(...)`** | Same reasoning: Vectorize is a Worker binding. |
| Stage attempt history | **`ingest_stage_attempts`**, primary key `(job_id, stage, attempt)` | One row per attempt; latest-attempt computed via `MAX(attempt)`. Forensic timeline is preserved for debugging external-provider failures. |
| Stage retry budgets | chat/embed: **3**, fetch/normalize/chunk/index: **2** | Embed has the highest external variance; deterministic stages get a tighter bound. |
| Job lease | **CAS UPDATE** on `(status IN ('pending','retrying'), lease_expires_at IS NULL OR < now)` with `locked_at`, `locked_by`, `attempt_count`, `lease_expires_at` columns | Queue messages can be redelivered. The lease ensures only one Container instance processes a job at a time, even under redelivery. |
| R2 derived-artifact layout | **per `1-DESIGN.md` §5.2** — `normalized.json`, `chunks.jsonl` (with header line), no embeddings persisted to R2 | Embeddings live in Vectorize only; replay re-embeds. The `chunks.jsonl` header line carries `schema_version` so replay is robust to chunker evolution. |
| Per-chunk embedding diagnostics | **Persisted on the chunk row**: `embedding_input_hash`, `embedding_provider_request_id`, `embedding_dimensions` | Lets ops verify a Vectorize vector matches the expected chunk text without ever storing the vector. |
| Test scaffolding | Reuse `test/helpers/fetch.ts` + `[env.test]` wrangler block + `test/setup.ts` | Same patterns as Phase 1+2. New: a small Python pytest harness inside `apps/ingest/tests/` for per-stage unit tests. |
| Container live tests | **Gated by `RUN_LIVE_TESTS=1`** | Same gate as the Phase 2 live smoke. |

### Phase 4 — Retrieval + Synthesis

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Retrieval orchestration | **Worker-side, `Promise.allSettled` across dense + sparse** | One arm failing must not poison the other. Surviving arm produces results with `retrieval_status` audit field reflecting the degradation (`full \| dense_only \| sparse_only \| empty`). Both arms failing surfaces `RETRIEVAL_FAILED`. |
| FTS5 query construction | **Conservative tokenize**: parse quoted phrases; alphanumeric + safe Unicode-letter terms only; drop FTS5 operators (`AND OR NOT NEAR ^ : -`); OR-join | Predictable recall beats exposing FTS syntax to consumer queries. An `advanced_query: true` mode is reserved for a later phase. |
| Tokenizer (Worker) | **`js-tiktoken`** with cl100k_base default | Same family as the OpenAI embed model; budget enforcement is consistent with what the model sees. |
| RRF default | **`k=60`** (Cormack/Clarke/Lynam, 2009) | Standard literature value; tunable per-request. |
| Hydration order | **Hydrate via `WHERE id IN (...)`, then re-sort by fused rank in application memory before token-budget greedy inclusion** | `IN` does not preserve list order; greedy inclusion of arbitrary-order rows would silently drop top-ranked candidates. |
| Citation marker syntax | **`[N]` (sequential, no per-layer prefix)** | Per design §12.1. Validation regex: `/\[(\d+)\]/g`. |
| Citation validation | **Never mutate answer prose**. Track which `[N]` markers reference invalid chunks; record those in `audit.dropped_citations`; exclude them from the returned `citations` array. Structured-mode citation arrays are filtered (the array is explicit; no prose to mutate). | Mutating prose to remove markers leaves orphaned punctuation and corrupts meaning. The audit field carries the diagnostic. |
| Structured output validation | **Ajv 8** (compiled validators) | Faster than ad-hoc Zod-from-JSON-schema construction; compiled once per request. |
| Mandatory developer suffix | **Always appended after consumer's developer prompt** | The platform owns citation integrity; non-negotiable. |
| Streaming | **Deferred to Phase 6** | Phase 4 closes with sync responses only. |
| Reranker default | **Disabled in Phase 4 with a deterministic no-op interface**: every response carries `audit.reranker = { enabled: false }` | Phase 5 flips to `enabled: true` without changing response shape. Locking the audit field name + position now means SDK consumers don't break. |
| Cost accounting | **`total_cost_usd_micros = NULL` in Phase 4** | A `provider_model_prices` table with effective dates ships in Phase 6. Hardcoded constants in code break replay-quality auditing as prices change. |
| `query_events.request_config` content | **Full request body post-default-merge, redacted per `tenants.audit_mode`** (`full \| redacted \| metadata_only`) | Default `full` for MVP. Enterprise tenants who don't want full prompt retention can opt down. Stored prompts may contain proprietary content — auditability cannot mean "permanent prompt log without consent." |
| `query_events` write timing | **Insert as soon as tenant + namespace resolved**, update through stages (`received → retrieval_started → retrieval_completed → synthesis_started → completed \| failed`) | Failed queries (EMBEDDING_PROFILE_MISMATCH, retrieval empty, provider exhausted, schema-validation failed) are equally important for production debugging. |
| `answers/{query_event_id}.json` mirror | **R2 best-effort write after response finalize**; on success populate `query_events.answer_r2_key`; on failure record `query_events.mirror_error` and leave `answer_r2_key` NULL | Auditing must not block the response. The Phase 6 sweeper reconciles failed mirrors. |
| R2 answer path | **`{tenant_id}/{namespace_id}/answers/{query_event_id}.json`** — no `document_id` segment | Queries can span multiple documents or whole namespaces. Document IDs go inside the JSON. |
| `answer` response shape | **Tagged object**: `{ mode: 'text' \| 'structured', text?, object?, raw? }` | A union forces clients into runtime type-branching. Tagged shape is friendly for SDK generation, OpenAPI, and future streaming. |
| Token accounting in audit | **Explicit breakdown**: `audit.tokens = { embedding_input, synthesis_input, synthesis_output, context }` | Flat `input_tokens`/`output_tokens` collapses meaningfully different costs. Cost optimization in Phase 6+ needs the breakdown. |

---

## Naming and locations

```
apps/api/src/
├── routes/
│   ├── documents.ts          ← register / upload-presign / finalize / ingest dispatch / list
│   ├── ingestion-jobs.ts     ← read-side: status, logs, retry
│   ├── query.ts              ← POST /v1/query
│   ├── query-events.ts       ← GET /v1/query-events/:id
│   └── internal/
│       └── ingest-write.ts   ← internal Worker endpoints the Container POSTs to
├── ingestion/
│   ├── dispatch.ts           ← create-job + enqueue
│   ├── presign.ts            ← R2 presigned PUT URL helper
│   ├── queue-handler.ts      ← the Worker's queue() entrypoint
│   ├── job-loader.ts         ← load + lock a job row
│   └── replay.ts             ← stage-resume planner
├── retrieval/
│   ├── hybrid.ts             ← runHybridRetrieval()
│   ├── fts5-query.ts         ← BM25 query construction + escape
│   ├── vectorize-query.ts    ← typed wrapper over the binding
│   ├── rrf.ts                ← reciprocal rank fusion
│   ├── profile-gate.ts       ← embedding-profile compatibility check
│   ├── context-assembly.ts   ← per-layer budget + [N] numbering
│   └── tokenizer.ts          ← js-tiktoken wrapper
├── synthesis/
│   ├── prompt-builder.ts     ← system + developer + mandatory suffix
│   ├── generator.ts          ← chat() invocation, sync only
│   ├── citation-validator.ts ← parse [N] refs, drop hallucinations
│   ├── degradation.ts        ← compute DegradationLevel
│   └── structured-output.ts  ← Ajv validation + provider routing
├── audit/
│   └── query-events.ts       ← write D1 row + R2 mirror
└── lib/
    └── r2-presign.ts         ← V4 presign for R2

apps/api/migrations/
└── 0002_documents_jobs_chunks.sql    ← documents, document_versions,
                                        ingestion_jobs, ingest_logs,
                                        chunks, chunks_fts, query_events,
                                        usage_records (extended)

apps/ingest/
├── app/
│   ├── main.py               ← FastAPI entry; /jobs/run + /healthz
│   ├── workers/
│   │   └── job_runner.py     ← stage dispatcher + replay (loads job + lease)
│   ├── stages/
│   │   ├── fetch.py          ← R2 GET via Worker-issued presigned URL
│   │   ├── normalize.py
│   │   ├── chunk.py
│   │   ├── embed.py          ← POSTs to Worker /internal/providers/embed
│   │   └── index.py          ← POSTs chunks + vectors to Worker
│   ├── normalizers/
│   │   ├── txt.py
│   │   ├── md.py
│   │   └── epub.py
│   ├── chunkers/
│   │   └── generic.py
│   ├── cdm/
│   │   ├── model.py          ← Pydantic CDM types (Field(default_factory=...))
│   │   └── tokens.py         ← tiktoken wrapper
│   └── clients/
│       └── worker.py         ← signed back-channel to internal Worker endpoints
└── tests/
    ├── stages/
    │   ├── test_normalize.py
    │   ├── test_chunk.py
    │   └── test_embed.py
    └── conftest.py

# Note: no apps/ingest/app/providers/ — provider calls live exclusively
# in apps/api/src/providers/ (Phase 2). Container hits the Worker over
# /internal/providers/embed.

packages/contracts/src/
├── ingest.ts                 ← IngestRequest, IngestionJob, StageLog, IngestionOutcome
└── query.ts                  ← QueryRequest, QueryResponse, DegradationLevel
```

---

# Step 3.1 — D1 migrations for documents + jobs + chunks

**Goal:** All tables, the FTS5 virtual table, and triggers from
`1-DESIGN.md` §5.1 land in a single migration. Phase 1.2's `0001_baseline.sql`
already created tenants/api_keys/namespaces/provider_keys/usage_records;
this migration is strictly additive.

## 3.1.1 Write the migration

**Files**
- `apps/api/migrations/0002_documents_jobs_chunks.sql`

**Contents (high level)**

```sql
-- documents: source identity. current_version_id is the latest
-- successfully ingested SOURCE version, embedding-profile-agnostic.
CREATE TABLE documents (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL REFERENCES namespaces(id),
    title TEXT, doc_type TEXT, metadata TEXT,
    current_version_id TEXT,             -- FK below; nullable until first ingest
    created_at INTEGER NOT NULL, deleted_at INTEGER
);

-- document_versions: source bytes only. UNIQUE on (document_id, content_hash)
-- means re-uploading identical bytes returns the existing version row.
CREATE TABLE document_versions (
    id TEXT PRIMARY KEY,                  -- ver_<ULID>
    document_id TEXT NOT NULL REFERENCES documents(id),
    tenant_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,           -- sha256(source bytes)
    source_r2_key TEXT NOT NULL,
    normalized_r2_key TEXT,               -- normalize stage output
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(document_id, content_hash)
);

-- version_indexes: one row per (version, chunking_profile, embedding_profile)
-- combination ever built. Re-ingesting the same source under a different
-- profile creates a new version_index, not a new version.
CREATE TABLE version_indexes (
    id TEXT PRIMARY KEY,                  -- vidx_<ULID>
    version_id TEXT NOT NULL REFERENCES document_versions(id),
    tenant_id TEXT NOT NULL,
    chunking_profile TEXT NOT NULL,
    chunking_target_tokens INTEGER NOT NULL,
    chunking_overlap_tokens INTEGER NOT NULL,
    embedding_profile TEXT NOT NULL,
    embedding_provider TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_dimensions INTEGER NOT NULL,
    distance_metric TEXT NOT NULL,
    corpus_profile TEXT NOT NULL,
    enrichment_config TEXT NOT NULL,      -- JSON
    enrichment_status TEXT NOT NULL DEFAULT 'pending',
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | building | ready | failed
    chunk_count INTEGER,                  -- populated at index stage
    embedding_missing_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(version_id, chunking_profile, embedding_profile)
);
CREATE INDEX idx_vidx_version ON version_indexes(version_id);

-- ingestion_jobs: gain a lease/lock model for redelivery safety.
CREATE TABLE ingestion_jobs (
    id TEXT PRIMARY KEY,                  -- job_<ULID>
    tenant_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    version_index_id TEXT NOT NULL REFERENCES version_indexes(id),
    mode TEXT NOT NULL,                   -- full | embed_only | enrichment_only
    status TEXT NOT NULL,                 -- pending | running | retrying | completed | failed
    current_stage TEXT,
    error_code TEXT, error_message TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    locked_at INTEGER, locked_by TEXT,    -- DO instance id
    lease_expires_at INTEGER,             -- locked_at + 5 min
    heartbeat_at INTEGER,
    dead_lettered INTEGER NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL,            -- full request body, post-default-merge,
                                          -- with provider_key_ref resolved to pkey_*
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);
CREATE INDEX idx_jobs_tenant_status ON ingestion_jobs(tenant_id, status);

-- ingest_stage_attempts: one row per attempt; preserves history.
CREATE TABLE ingest_stage_attempts (
    job_id TEXT NOT NULL REFERENCES ingestion_jobs(id),
    stage TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL,                 -- started | completed | failed | skipped
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    duration_ms INTEGER,
    metadata TEXT,                        -- JSON: chunk_count, mutation_id, ...
    error_code TEXT, error_message TEXT,
    PRIMARY KEY(job_id, stage, attempt)
);
CREATE INDEX idx_stage_job ON ingest_stage_attempts(job_id);

-- chunks: point to version_index_id. embedding_status makes the
-- partial-ingestion invariant explicit. embedding_input_hash +
-- embedding_provider_request_id provide ops diagnostics without
-- persisting vectors.
CREATE TABLE chunks (
    id TEXT PRIMARY KEY,                  -- chk_<version_id>_<padded_ord>
    tenant_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    version_index_id TEXT NOT NULL REFERENCES version_indexes(id),
    artifact_type TEXT NOT NULL,
    section_path TEXT,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    metadata TEXT,
    embedding_profile TEXT NOT NULL,      -- denormalized from version_index for query gate
    chunking_profile TEXT NOT NULL,       -- denormalized from version_index for query gate
    embedding_status TEXT NOT NULL DEFAULT 'pending', -- pending | embedded | missing
    embedding_input_hash TEXT,            -- sha256(embedded text); null until embedded
    embedding_provider_request_id TEXT,
    embedding_dimensions INTEGER,
    vector_id TEXT,                       -- = id (kept for clarity at the Vectorize boundary)
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_chunks_doc ON chunks(tenant_id, document_id, version_id);
CREATE INDEX idx_chunks_vidx ON chunks(version_index_id);
CREATE INDEX idx_chunks_ns_artifact ON chunks(tenant_id, namespace_id, artifact_type);

-- chunks_fts + the three triggers (insert / delete / update) per design §5.1.
-- All chunks are in FTS5 regardless of embedding_status — sparse retrieval
-- works even when embeddings are missing.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text, content='chunks', content_rowid='rowid',
    tokenize='porter unicode61 remove_diacritics 2'
);
-- triggers: INSERT/DELETE/UPDATE per design §5.1, unchanged

-- tenants: add audit_mode column (default 'full').
ALTER TABLE tenants ADD COLUMN audit_mode TEXT NOT NULL DEFAULT 'full';
-- valid values: 'full' | 'redacted' | 'metadata_only'

-- query_events: total_cost_usd_micros stays nullable; mirror_error captures
-- best-effort R2 mirror failures.
CREATE TABLE query_events (
    id TEXT PRIMARY KEY,                  -- qev_<ULID>
    tenant_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    status TEXT NOT NULL,                 -- received | retrieval_started | retrieval_completed
                                          -- | synthesis_started | completed | failed
    query_text TEXT NOT NULL,
    request_config TEXT NOT NULL,         -- per tenants.audit_mode
    embedding_profile_used TEXT,
    chunking_profile_used  TEXT,
    inference_model_used   TEXT,
    inference_provider     TEXT,
    provider_key_id        TEXT,          -- resolved at job-creation time
    retrieval_strategy     TEXT,
    retrieval_status       TEXT,          -- full | dense_only | sparse_only | empty
    citation_integrity     TEXT,          -- valid | invalid_removed | missing
    synthesis_status       TEXT,          -- success | truncated | failed
    candidates_returned    INTEGER,
    citations_returned     INTEGER,
    dropped_citations      TEXT,          -- JSON array of bogus chunk_id refs
    degradation_level      TEXT,
    latency_ms             INTEGER,
    embedding_input_tokens INTEGER,
    synthesis_input_tokens INTEGER,
    synthesis_output_tokens INTEGER,
    context_tokens         INTEGER,
    total_cost_usd_micros  INTEGER,       -- NULL in Phase 4
    answer_r2_key          TEXT,          -- NULL when mirror failed
    mirror_error           TEXT,
    error_code             TEXT,
    error_message          TEXT,
    created_at             INTEGER NOT NULL,
    completed_at           INTEGER
);
CREATE INDEX idx_query_events_tenant ON query_events(tenant_id, created_at);
```

Notes:
- `usage_records` already exists from migration 0001 (Phase 1.2);
  no further changes here.
- The Vectorize index lives in CF; the schema above is the D1 side
  only. Vectorize writes happen at index-stage time via the Worker
  binding.

> **FTS5 tokenizer choice**: `tokenize='porter unicode61 remove_diacritics 2'`.
> Porter stemming makes BM25 robust to plurals/tense variants for
> English narrative + technical text. Phase 5's CJK profiles can switch
> per-namespace if needed (a column-level decision documented in §11.1
> of the design doc).

> **Why `version_indexes` and not just expanding `document_versions`'s
> uniqueness key?** `document_versions` should mean "this is the source
> we ingested" — independent of pipeline state. Different embedding
> profiles do not change the source. Modeling them as separate
> `version_indexes` rows keeps source identity stable and makes the
> Phase 5 enrichment story (multiple profiles per source) representable
> without additional schema churn.

## 3.1.2 Wire and apply

```bash
make migrate-dev    # applies 0002 against textral-dev (remote)
```

**Acceptance**
- `wrangler d1 execute textral-dev --env dev --remote --command \
   "SELECT name FROM sqlite_master WHERE type='table' OR type='index'"` lists
  every new table/index, including `chunks_fts` and the three triggers.
- Manual smoke: `INSERT INTO chunks (...)` followed by
  `SELECT rowid FROM chunks_fts WHERE text MATCH 'foo'` returns the
  inserted row's rowid (the trigger fired).
- Re-running `make migrate-dev` is a no-op (Wrangler tracks applied
  migrations).

---

# Step 3.2 — R2 layout + presigned upload URLs

**Goal:** A consumer can register a document, get a single-shot
presigned PUT URL, upload bytes (up to 25 MB), and call finalize to
create the `document_versions` row.

## 3.2.1 R2 presign helper

**Files**
- `apps/api/src/lib/r2-presign.ts`

**Contents (high level)**
- A small helper that signs an AWS-SigV4 PUT for an R2 object using
  the **R2 binding's `createPresignedUrl`** when available, falling
  back to a hand-rolled SigV4 implementation if not.
  - **Live-exercise reality (see Appendix C):** the R2 binding has no
    `createPresignedUrl` method. Until the deploy is configured with R2
    S3-compatible access keys, both `presignPut` and `presignGet`
    return a sentinel URL the routes detect and rewrite to a Worker
    proxy path: `PUT /v1/documents/{id}/uploads/{upload_id}/data`
    (consumer-side) and `POST /internal/r2/object` (Container-side).
- Returns `{ url, key, expires_at, declared_size, declared_content_type }`.
  URLs expire after 15 minutes.
- The R2 key for the upload landing zone:
  `{tenant_id}/{namespace_id}/{document_id}/uploads/{upload_id}/source.{ext}`.
  `upload_id` is a fresh ULID; the final `version_id` is computed at
  finalize time.
- A small `upload_intents` row in D1 records the presign request
  parameters (`upload_id`, `document_id`, `tenant_id`,
  `declared_size`, `declared_content_type`, `created_at`,
  `consumed_at`). Finalize compares actual R2 metadata against the
  declared values.

> **Why a separate `uploads/{upload_id}/` prefix instead of going
> straight to the version path?** Until the bytes are uploaded and
> hashed, we don't know the `version_id`. The finalize step copies
> the bytes into the canonical version path; the upload object is
> only deleted after the canonical copy + version row are persisted.

## 3.2.2 Endpoints

**Files**
- `apps/api/src/routes/documents.ts` (NEW)
- `packages/contracts/src/ingest.ts` (NEW)

```
POST   /v1/namespaces/{slug}/documents
       body: { title?, doc_type?, metadata? }
       → 201 { id, namespace_id, ... }

POST   /v1/documents/{id}/uploads
       body: { content_type, size_bytes }
       → 200 { upload_id, url, key, expires_at }

POST   /v1/documents/{id}/uploads/{upload_id}/finalize
       (no body)
       → 201 { version_id, content_hash, source_r2_key }
```

The finalize handler is an **idempotent recovery state machine**, not
an atomic operation. R2 + D1 cannot be made atomic; we make every
step idempotent and check post-conditions on retry.

Conceptual states:
```
upload_received → copy_started → copy_completed
                                 → version_inserted
                                 → upload_deleted
```

Concrete flow:
1. **HEAD the upload object.** Fetch actual `Content-Length` and
   `Content-Type` from R2 metadata. Compare against the
   `upload_intents` row's `declared_size` and `declared_content_type`.
   Mismatch → 400 `UPLOAD_VALIDATION_FAILED` with details. (Otherwise a
   client could presign a 12-byte text file and finalize a 25 MB
   binary.)
2. **Stream + hash.** Stream the upload object body through a
   SHA-256 hasher. `content_hash = sha256(bytes)`. We never use the
   ETag as a content-hash contract — it isn't portable across
   single-shot vs. multipart vs. encrypted-at-rest.
3. **Recover-or-create.**
   - If `document_versions(document_id, content_hash)` row exists → that
     version was finalized previously. Verify the canonical R2 object
     exists and its hash matches; if not, re-copy. Best-effort delete
     the upload object. Return the existing row.
   - Else compute the canonical key:
     `{tenant_id}/{namespace_id}/{document_id}/{version_id}/source.{ext}`.
     If a canonical object already exists at that key (orphaned from a
     previous failed finalize) and its content hash matches → continue
     to step 4. Otherwise copy upload → canonical.
4. **INSERT `document_versions`** with `version_id = newId('ver')`,
   `content_hash`, `source_r2_key` (canonical), `content_type`,
   `size_bytes`. The UNIQUE constraint on `(document_id, content_hash)`
   means concurrent finalize calls for identical bytes converge on one
   row.
5. **DELETE the upload object.** Best-effort; logged but never blocks
   the response. Mark `upload_intents.consumed_at = now`.

Crash-anywhere safety: at every step, the next call either picks up
where the previous left off (hash matches → skip) or detects orphan
state (canonical object without a D1 row → finish the INSERT).

## 3.2.3 Tests

**Files**
- `apps/api/test/documents-upload.test.ts`

**Cases**
- Round-trip: register → presign → upload (mocked) → finalize → row
  exists.
- Dedup: re-finalizing identical bytes for the same document returns
  the existing `version_id`.
- Cross-tenant isolation: tenant B cannot finalize tenant A's upload.

**Acceptance**
- `pnpm --filter @textral/api test documents-upload` green.
- Live: `curl --upload-file fixture.txt <presigned_url>` succeeds, then
  finalize returns a `version_id`.

---

# Step 3.3 — Document register + ingest dispatch

**Goal:** `POST /v1/documents/{id}/ingest` accepts the full ingestion
config, validates against Zod, persists `ingestion_jobs` + the queue
message, and returns `{ job_id }`.

## 3.3.1 The Zod schema

**Files**
- `packages/contracts/src/ingest.ts` (extended)

**Shape**
- `IngestRequest` mirrors `1-DESIGN.md` §6.7 — `version_id?, doc_type?,
  embedding {provider, model, provider_key_ref?}, chunking {profile,
  ...}, enrichment {enabled, default_model, passes[]}, indexing
  {replace_existing_vectors, artifact_types[]}`.
- Defaults inferred from the namespace's `corpus_profile` when fields
  are omitted (Phase 5 fully exercises this; Phase 3 covers `generic`).

## 3.3.2 Dispatch

**Files**
- `apps/api/src/ingestion/dispatch.ts` (NEW)
- `apps/api/src/routes/documents.ts` (extended)

**Contents (high level)**
1. Validate body against `IngestRequest`.
2. Resolve the version: explicit `version_id`, or the document's
   `current_version_id`, or the latest version with no
   `current_version_id` set. 400 if none.
3. **Resolve `provider_key_ref` to a `pkey_*` ID** at this exact
   moment. The public input still accepts `provider_key_ref: "label"`
   for ergonomics, but dispatch looks up the matching active
   `provider_keys` row and substitutes the resolved ID into the
   payload. Subsequent stages (and `config_json`) only ever see the
   ID. This eliminates label ambiguity over time — re-running an
   ingest from `config_json` always targets the same exact key, even
   if the label has been re-pointed since.
4. **Find or create the `version_index`** for `(version_id,
   chunking_profile, embedding_profile)`. If a `ready` index exists
   and the request is mode `full`, the dispatch returns 409
   `INDEX_ALREADY_BUILT` unless `force_rebuild: true` is set. New
   indexes start `status='pending'`.
5. INSERT `ingestion_jobs` with `status='pending'`,
   `version_index_id` set, `config_json` = the full validated body
   (with `provider_key_ref` replaced by `provider_key_id`).
6. Send a queue message: `{ job_id, tenant_id, attempt: 0 }`.
7. Return `{ job_id, status: 'pending', version_index_id }`.

## 3.3.3 Read-side endpoints

**Files**
- `apps/api/src/routes/ingestion-jobs.ts` (NEW)

```
GET  /v1/ingestion-jobs/{id}             → status + last_completed_stage + error_*
GET  /v1/ingestion-jobs/{id}/logs        → array of ingest_logs rows
POST /v1/ingestion-jobs/{id}/retry       → re-enqueues if in 'failed' state and
                                            error is retryable; rejects if fatal
GET  /v1/documents/{id}/ingestion-jobs   → list, paginated
```

**Acceptance**
- A queue message lands with the pointer payload (verified via
  `wrangler queues consumer pull` in dev).
- Re-running `POST /ingest` with the same `version_id` while an active
  job is running returns 409 with `INGESTION_IN_PROGRESS`.
- The `ingestion_jobs` row reflects `status='pending'`.

---

# Step 3.4 — Container queue worker

**Goal:** The Worker's `queue()` handler proxies messages to the
Container; the Container's `/jobs/run` endpoint runs one job per
request and returns terminal status.

## 3.4.1 Worker queue consumer

**Files**
- `apps/api/src/index.ts` (extended)
- `apps/api/src/ingestion/queue-handler.ts` (NEW)
- `apps/api/wrangler.toml` (uncomment the `[[env.{dev,prod}.queues.consumers]]` block)

**Contents (high level)**
- Add `queue(batch, env, ctx)` to the default-export handler.
- Per message: invoke the `INGEST_CONTAINER` Durable Object's
  `/jobs/run` endpoint with `{ job_id, attempt }`.
- On HTTP 200 with `{ outcome: 'full_success' | 'partial_ingestion' }`:
  ack.
- On HTTP 200 with `{ outcome: 'fatal_failure' }`: ack (the job row
  already records the error; never auto-retry fatal).
- On 5xx / network: do NOT ack — Cloudflare Queues' `max_retries`
  handles backoff.

> **Why does the Worker, not the Container, decide ack vs retry?**
> Queue ack semantics are a Worker primitive. Keeping the dispatch
> logic on the Worker side means the Container is stateless w.r.t.
> the queue.

## 3.4.2 Container `/jobs/run`

**Files**
- `apps/ingest/app/main.py` (extended)
- `apps/ingest/app/workers/job_runner.py` (NEW)
- `apps/ingest/app/clients/worker.py` (NEW)

**Contents (high level)**
- `POST /jobs/run` accepts `{ job_id, attempt }`.
- `job_runner.run(job_id, attempt)`:
  1. Loads the job row + `config_json` via `Worker /internal/jobs/{id}`
     (the Worker exposes a tiny internal-only endpoint that returns the
     job + version metadata).
  2. Determines start stage from the latest `ingest_logs` row
     (replay; §3.10 details).
  3. Runs stages sequentially; each stage is its own Python module
     (3.5–3.9).
  4. Writes stage logs as it goes via `Worker /internal/ingest-logs`.
  5. On terminal: returns `{ outcome, job_id, version_id, stages: [...] }`.

## 3.4.3 Internal Worker endpoints (Container ↔ Worker back-channel)

**Files**
- `apps/api/src/routes/internal/ingest-write.ts` (NEW)
- `apps/api/src/middleware/internal-auth.ts` (NEW)
- `apps/api/src/routes/internal/providers.ts` (NEW)

The Container needs a way to write D1 rows + Vectorize vectors and
issue embedding calls without embedding a CF API client (or a parallel
provider abstraction) in Python. The Worker exposes:

```
GET  /internal/jobs/{id}                  → job + version + version_index + namespace metadata
POST /internal/jobs/{id}/claim            { container_instance_id, lease_seconds }
                                          → { ok: true } if claim won, { ok: false, reason } otherwise
POST /internal/jobs/{id}/heartbeat        { container_instance_id }
POST /internal/jobs/{id}/transition       { status, current_stage?, error? }
POST /internal/jobs/{id}/stage-attempt    { stage, attempt, status, started_at,
                                            completed_at?, metadata?, error? }
POST /internal/r2/upload-url              { job_id, key }       → { url, expires_at }    -- read URL
POST /internal/chunks/batch               { job_id, chunks: [{...}] }
POST /internal/vectorize/upsert           { job_id, vectors: [...] }
POST /internal/vectorize/delete-by-filter { job_id, filter }    -- for replace_existing_vectors
POST /internal/providers/embed            { job_id, provider, model, dimensions, input: [...] }
                                          → { vectors: [[...]], request_id, usage: {...} }
```

The Worker, on every internal write call:
- **Re-validates ownership.** Loads the supplied `job_id`, asserts
  `tenant_id` from the lease matches, asserts the job is in
  `status='running'` and the lease has not expired. For
  `/internal/chunks/batch` and `/internal/vectorize/upsert`, also
  asserts every record's `tenant_id`, `namespace_id`, `document_id`,
  `version_id`, `version_index_id` matches the loaded job. Container
  is not trusted to self-attribute.
- **Authenticates the request** via HMAC (next subsection).

There is no `/internal/secrets/resolve`. Provider keys never leave the
Worker. The Container POSTs to `/internal/providers/embed`; the Worker
resolves the key, applies AI Gateway routing + redaction + Phase 2
retry/classification + telemetry, and returns the embeddings.

These routes are gated by the HMAC middleware (next sub-section), are
**not** in the OpenAPI spec (`mountDocs` walks declared routes only;
the internal sub-tree is plain Hono) and 404 in any environment where
`INTERNAL_HMAC_SECRET` is unset.

## 3.4.4 Internal authentication

**Files**
- `apps/api/src/middleware/internal-auth.ts` (NEW)
- `apps/ingest/app/clients/worker.py` — signs every outbound request

A static bearer token is a leak vector — through logs, traces, crash
dumps, accidental request replay. We strengthen it with a short-window
HMAC signature.

Every internal request carries three headers:

```
X-Textral-Internal-Timestamp:  <unix ms, decimal>
X-Textral-Internal-Signature:  hex(hmac_sha256(secret, canonical))
X-Textral-Internal-KeyId:      <secret kid>     -- supports rotation
```

Where `canonical = method + "\n" + path + "\n" + sha256(body) + "\n" + timestamp`.

Middleware enforces:
1. `|now − timestamp| ≤ 5 min`. Outside the window → 401 with
   `INTERNAL_TIMESTAMP_OUT_OF_WINDOW`.
2. Constant-time `crypto.subtle.verify` against the secret keyed by
   `KeyId`. Mismatch → 401.
3. The verified `body_hash` is then re-checked against the actual
   request body bytes (defense against header-spoofing on a proxy).

`INTERNAL_HMAC_SECRET` is set as a Worker secret per env (`make
secret-put-{env} NAME=INTERNAL_HMAC_SECRET`). The same secret is
injected into the Container at deploy time as an env var. Rotation:
add the new key with a new `kid` first, swap Container, then remove
the old.

> **Why HTTP back-channel instead of giving the Container its own D1
> and Vectorize bindings?** Containers can't have CF resource bindings
> the way Workers do; even if they could, having two write paths means
> two sets of cross-tenant guardrails to keep in sync. The Worker
> remains the single writer.

## 3.4.5 Job lease + lock

**Files**
- `apps/api/src/routes/internal/ingest-write.ts` (claim handler)
- `apps/ingest/app/workers/job_runner.py` (claim + heartbeat)

Cloudflare Queues guarantee at-least-once delivery; a message can be
redelivered. The Container races to claim the job before processing.

The Worker's `/internal/jobs/{id}/claim` runs:

```sql
UPDATE ingestion_jobs
   SET status = 'running',
       locked_at = ?1, locked_by = ?2,
       lease_expires_at = ?1 + ?3,
       attempt_count = attempt_count + 1
 WHERE id = ?4
   AND tenant_id = ?5
   AND status IN ('pending', 'retrying')
   AND (lease_expires_at IS NULL OR lease_expires_at < ?1);
```

If `meta.changes === 1` → claim succeeded; the response carries the
full job + `version_index` payload. If `0` → another instance owns the
lease (return `{ ok: false, reason: 'already_claimed' }`); the
Container returns `200` to the Worker queue handler so the message is
**not** re-acked, allowing CF Queues to redeliver after the lease
expires.

The Container heartbeats every 60s during long stages (embed). The
Worker extends `lease_expires_at` on each heartbeat. Lease default:
5 min; configurable per-job via the `lease_seconds` claim field
(useful for embed of very large documents).

On terminal completion or `fatal_failure`, the Container POSTs
`/internal/jobs/{id}/transition` with `status='completed'` or
`'failed'`; the lease columns are cleared.

## 3.4.6 Smoke test: noop job

**Goal**: end-to-end queue → Container → terminal completion under 30 s
including cold start.

**Files**
- `apps/ingest/tests/test_noop_job.py`
- `apps/api/test/ingestion-noop.test.ts`

**Acceptance**
- A "noop" job (config with `enrichment.enabled=false` and a
  zero-byte uploaded source) progresses `pending → running →
  completed` within 30 s on first dispatch (cold start) and within 5 s
  on a warm container.
- Idle Container sleeps after 10 minutes (`sleepAfter='10m'`) and
  resurrects on next message.

---

# Step 3.5 — Stage: fetch

**Files**
- `apps/ingest/app/stages/fetch.py`

**Behavior**
- Read `document_versions.source_r2_key` from the loaded job
  metadata.
- POST `/internal/r2/object` with `{job_id, key}`; the Worker proxies
  the bytes back over the HMAC-signed back-channel. (Originally
  designed as a presigned read URL; the binding doesn't expose
  presigning. See Appendix C.)
- Stage log records `file_size`, `content_type`, `latency_ms`.

**Retry budget**: 2 attempts. Network errors → retryable; 404 →
fatal (`source missing`).

**Acceptance**
- Fetches a 5 MB EPUB in under 2 s (warm cache).
- Records `file_size` in the stage log metadata.

---

# Step 3.6 — Stage: normalize

**Goal:** Parse source bytes into the **Canonical Document Model**
(CDM) — a Python pydantic structure — and emit `normalized.json` to R2.

## 3.6.1 The CDM

**Files**
- `apps/ingest/app/cdm/model.py`

```python
from pydantic import BaseModel, Field
from typing import Literal, Optional

class Block(BaseModel):
    id: str                        # stable within version (e.g. "p_0042")
    type: Literal['paragraph', 'heading', 'list_item', 'quote', 'code']
    section_path: str              # '/preface' | '/ch3/scene2'
    text: str
    # Always Field(default_factory=...) for mutable defaults — avoids the
    # classic shared-mutable-state footgun.
    metadata: dict = Field(default_factory=dict)

class Section(BaseModel):
    path: str
    title: Optional[str] = None
    children: list['Section'] = Field(default_factory=list)

class CanonicalDocument(BaseModel):
    document_id: str
    version_id: str
    title: Optional[str] = None
    blocks: list[Block] = Field(default_factory=list)
    section_index: list[Section] = Field(default_factory=list)
```

## 3.6.2 Per-format normalizers

**Files**
- `apps/ingest/app/normalizers/txt.py`
- `apps/ingest/app/normalizers/md.py` (markdown-it-py)
- `apps/ingest/app/normalizers/epub.py` (ebooklib)

**Contents (high level)**
- `txt`: split on blank lines, infer heading/paragraph by ALL-CAPS
  first-line heuristic, no section paths beyond `/`.
- `md`: parse Commonmark, generate section_path from heading levels.
- `epub`: walk spine, extract HTML per chapter, strip with BeautifulSoup,
  populate section_path from chapter file names.

## 3.6.3 Persistence

- Write `normalized.json` to R2 at `.../{version_id}/normalized.json`.
- Stage log records `block_count`, `total_chars`.

**Acceptance**
- Fixtures: a representative novel (EPUB) and a representative legal
  doc (markdown) both normalize cleanly with valid section paths.
- A `normalize.test.py` round-trip asserts deterministic output (same
  bytes in → identical CDM out across runs).

---

# Step 3.7 — Stage: chunk

**Files**
- `apps/ingest/app/stages/chunk.py`
- `apps/ingest/app/chunkers/generic.py`
- `apps/ingest/app/cdm/tokens.py`

**Behavior**
- Generic chunker only (Phase 5 introduces corpus-specific chunkers).
- Sliding window: target **600 tokens, 80 overlap, never crosses a
  major section boundary** (heading depth ≤ 2 per default; tunable
  via the `chunking.target_tokens / overlap_tokens / boundary_depth`
  fields).
- Each chunk gets:
  - `id = chk_<version_id>_<zero_padded_ord_5_digits>` (e.g.
    `chk_ver_01HZ8YS2C..._00042`). Deterministic, human-debuggable,
    sortable. Zero-padding to 5 digits lets us go up to 99,999 chunks
    per version without breaking lexical sort; raise the pad if a
    larger document ever needs it.
  - `section_path`, `ord` (monotonic per version), `text`,
    `artifact_type='passage'`.
- Emits `chunks.jsonl` to R2 for replay material. The first line is
  a versioned header so replay is robust to chunker evolution:

```jsonl
{"type":"header","schema_version":"chunk_jsonl_v1","version_id":"ver_...","version_index_id":"vidx_...","chunking_profile":"generic","chunking_target_tokens":600,"chunking_overlap_tokens":80,"chunk_count":170}
{"type":"chunk","id":"chk_ver_01HZ8YS2C..._00000","ord":0,"section_path":"/preface","text":"...","metadata":{...}}
{"type":"chunk","id":"chk_ver_01HZ8YS2C..._00001","ord":1,...}
...
```

**Acceptance**
- 100K-token document → ~170 chunks, every chunk under 800 tokens.
- All chunks have valid `section_path` and monotonic `ord`.
- Replaying the same version produces byte-identical chunk ids
  (deterministic).
- Header line parses; `chunk_count` matches subsequent line count.
- A `chunk_jsonl_v0` (legacy / hand-edited) header is rejected with
  `UNSUPPORTED_CHUNK_JSONL_SCHEMA`.

---

# Step 3.8 — Stage: embed

**Files**
- `apps/ingest/app/stages/embed.py`
- `apps/api/src/routes/internal/providers.ts` (`/internal/providers/embed`)

**Behavior**
- The Container batches chunk text and POSTs to
  `/internal/providers/embed` with the resolved
  `(provider, model, dimensions, input[])`. The Worker:
  1. Resolves the provider key from the loaded job
     (`config_json.provider_key_id`).
  2. Invokes the Phase 2 provider via `resolve(env, ...)` — this gives
     us AI Gateway routing, redaction, retry/classification, and
     telemetry consistent with the rest of the system.
  3. Returns `{ vectors: [[...]], request_id, usage, dimensions }`.
- For OpenAI `text-embedding-3-large` we **always** pass
  `dimensions: 1536` in the underlying request body; the Worker
  asserts that the embedding profile's declared `dimensions` matches
  the Vectorize index dimensionality. A profile that declares a
  different dimension is rejected at dispatch time
  (`PROVIDER_UNSUPPORTED_MODEL`).
- Container batches at provider-appropriate size (OpenAI: 100 inputs/
  request, Workers AI compat: 96).
- **Failure dispatch mirrors Phase 2** (the v1 retry-loop regression
  applies at the ingestion layer too):
  - `insufficient_quota` → fatal stage failure → job row gets
    `error_code=PROVIDER_QUOTA_EXHAUSTED`, no retries.
  - `rate_limit` (transient 429) → retry with backoff up to 3.
  - `partial_batch` → retry once; on second failure, mark the
    short-batched chunks `embedding_status='missing'` and proceed
    (the version_index ends `enrichment_status='partial'` and the
    job's terminal outcome is `partial_ingestion`).
- For each successfully embedded chunk, the Container also computes
  `embedding_input_hash = sha256(text_sent_to_provider)` and forwards
  it (with the provider's `request_id`) into the index stage so they
  land on the chunk row. This lets ops verify a Vectorize vector
  matches the expected text without storing the vector itself.
- Embeddings never persist to R2.

**Acceptance**
- 200-chunk document embeds against OpenAI in under 8 s.
- Regression: a mocked 429 + `insufficient_quota` causes the job to
  fail with `PROVIDER_QUOTA_EXHAUSTED` after exactly **one** call.
- A request to `/internal/providers/embed` with mismatched declared
  vs. actual `dimensions` returns 400 (typed test).
- The Worker's existing Phase 2 redaction tests cover this path —
  no additional duplication.

---

# Step 3.9 — Stage: index

**Files**
- `apps/ingest/app/stages/index.py`
- `apps/api/src/routes/internal/ingest-write.ts` (extended)

**Behavior**
- Container POSTs to `/internal/chunks/batch` with chunk rows
  (in batches of 200). The Worker INSERTs into D1; the FTS5 trigger
  fires automatically. Every chunk carries `embedding_status` set per
  the embed stage's outcome (`'embedded'` for successfully-embedded
  chunks; `'missing'` for chunks that fell out of a partial batch
  after retries).
- Container POSTs to `/internal/vectorize/upsert` with the vectors
  for chunks where `embedding_status='embedded'` ONLY (in batches of
  200). The Worker upserts via the binding, with `metadata: {
  tenant_id, namespace_id, document_id, version_id, version_index_id,
  artifact_type }` per design §5.3.
- **Partial-ingestion invariants (locked in here):**
  - D1 + FTS5 contain *every* chunk regardless of embedding_status —
    sparse retrieval works even when embeddings are missing.
  - Vectorize contains *only* chunks where
    `embedding_status='embedded'`.
  - `version_indexes.embedding_missing_count` is set to the count of
    `'missing'` chunks; `chunk_count` is the total.
  - `version_indexes.status` ends `'ready'` if `embedding_missing_count=0`,
    `'partial'` otherwise.
- **`replace_existing_vectors: true` semantics.** Before upsert: if a
  prior `version_index` exists for `(version_id, chunking_profile,
  embedding_profile)` and the request opts in to replace, the Worker
  issues `/internal/vectorize/delete-by-filter` with
  `{ document_id, version_id, embedding_profile, chunking_profile }`,
  deletes the chunk rows in D1 (cascade delete the `version_indexes`
  row → its chunks via FK ON DELETE CASCADE), then proceeds with the
  fresh upsert.
  - Operational caveat: Vectorize delete-by-metadata-filter is
    eventually consistent within a few seconds. The index stage
    polls the `mutationId` until the delete completes (timeout: 30 s)
    before issuing the upsert. If the delete times out the stage
    fails retryably; the next attempt re-checks state.
- `chunks.embedding_profile` and `chunks.chunking_profile` are
  denormalized from `version_indexes` to keep the read-side query gate
  cheap (no JOIN needed at query time).
- `chunks.embedding_input_hash`, `embedding_provider_request_id`, and
  `embedding_dimensions` are populated from the embed-stage payload.
- Stage attempt log records `chunk_count`, `vectorize_mutation_id`,
  `d1_rows_written`, `embedding_missing_count`.

**Acceptance**
- 200-chunk document indexes in under 10 s.
- D1: `SELECT count(*) FROM chunks WHERE document_id=?` → 200.
- Vectorize: filtered query by `document_id` returns 200 vectors
  when `embedding_missing_count=0`.
- FTS5 rowcount matches `chunks` rowcount, regardless of
  embedding_status.
- Re-ingest with `replace_existing_vectors: true`: previous chunks
  + vectors are gone before new ones land (no double-counting).
- Partial-ingestion test: a forced partial-batch on attempt 2 leaves
  `embedding_status='missing'` on the affected chunks, FTS5 contains
  all rows, Vectorize is short by exactly that count, and
  `version_indexes.status='partial'`.

---

# Step 3.10 — Stage logs + idempotent replay

**Files**
- `apps/api/src/ingestion/replay.ts` (Worker side)
- `apps/ingest/app/workers/job_runner.py` (Container side)

**Behavior**
- On job entry, after the lease is claimed (§3.4.5):
  - Read all `ingest_stage_attempts` rows for the job. Compute
    `last_completed_stage` as the latest stage with a row where
    `status='completed'` (using `MAX(attempt)` per stage).
  - Resume from `next(last_completed_stage)`. If the previous stage
    persisted an artifact (`normalized.json` for normalize,
    `chunks.jsonl` for chunk), the resuming stage **loads from R2**
    rather than recomputing.
- Each stage attempt is a NEW row with `attempt = MAX(attempt) + 1`
  for that stage — the timeline is preserved. Latest-attempt logic at
  read time uses `MAX(attempt) WHERE status='completed'`.
- A successful complete run:
  - Sets `version_indexes.status = 'ready'` (or `'partial'` if any
    chunks are `embedding_status='missing'`).
  - Sets `documents.current_version_id = version_id` (the source
    version, embedding-profile-agnostic).
  - Sets `ingestion_jobs.status = 'completed'`,
    `completed_at = now`.
  - **Implementation note:** the `current_version_id` and
    `version_indexes.status` updates happen on the Worker side in the
    `/internal/jobs/:id/transition` handler when `status='completed'`.
    The Container intentionally has no privilege to touch those
    columns. See Appendix C.

**Acceptance**
- A job that fails in stage 4 (embed) on attempt 1 and is retried:
  attempt 1's row stays as `status='failed'`, attempt 2 enters as a
  fresh row, the chunk stage's most-recent `status='completed'` row
  is unchanged, and the resume reads `chunks.jsonl` from R2 rather
  than re-running normalize+chunk.
- Replaying a fully-successful job is a no-op (no duplicate chunks,
  no duplicate vectors — chunk PRIMARY KEY guards INSERT, Vectorize
  upserts are idempotent on chunk id).
- Forensic value preserved: `SELECT * FROM ingest_stage_attempts
  WHERE job_id = ? ORDER BY started_at` shows every attempt, including
  the failed one with its error message.

---

# Step 3.11 — Profile compatibility (write side)

**Files**
- `apps/api/src/ingestion/dispatch.ts` (extended)
- `apps/ingest/app/stages/index.py` (extended)

The compatibility unit is the **`version_index`**, identified by the
combination `(version_id, chunking_profile, embedding_profile)`.
That's the unit retrieval reads back later.

**Behavior**
- On first ingest, the dispatcher creates (or finds) a
  `version_indexes` row for the requested profiles. The chunking +
  embedding fields on the row are immutable for that index.
- A re-ingest of the same source with the same profiles either:
  - resumes the existing index if it's `pending` or `partial`, or
  - returns 409 `INDEX_ALREADY_BUILT` if it's `ready` (unless
    `force_rebuild: true`).
- A re-ingest with a different `embedding_profile` OR
  `chunking_profile` creates a **new version_index row** under the
  same `version_id`. The old index remains queryable.
- `chunks.embedding_profile` and `chunks.chunking_profile` are
  denormalized from the `version_index` row so the read-side
  compatibility gate (§4.2) is a single-table lookup with no JOIN.

**Acceptance**
- Ingesting the same document with
  `(generic, text-embedding-3-large)` then re-ingesting with
  `(generic, text-embedding-3-small)` produces ONE `document_versions`
  row (same source bytes) and TWO `version_indexes` rows. Both are
  queryable under their respective profile combos.
- Re-ingesting with the same profile pair returns 409
  `INDEX_ALREADY_BUILT` unless `force_rebuild: true`.
- Querying with a mismatched chunking profile returns 400
  `EMBEDDING_PROFILE_MISMATCH` with `details.dimension = 'chunking'`
  (Phase 4.2).

---

# Step 3.12 — Phase 3 close-out

```bash
pnpm -r typecheck                                                # green
pnpm -r lint                                                     # green
pnpm --filter @textral/api test                                  # all unit + fixture tests green
pytest apps/ingest/tests                                         # all Container unit tests green
RUN_LIVE_TESTS=1 pnpm --filter @textral/api test ingestion-live  # live e2e against dev
```

End-to-end:

```bash
# Register, upload, ingest a fixture text file:
TENANT_KEY=$(cat tools/dev-seed.env | grep TEXTRAL_API_KEY | cut -d= -f2)

# 1. register a doc
curl -s -X POST -H "X-Textral-Api-Key: $TENANT_KEY" \
     "https://textral-api-dev.<sub>.workers.dev/v1/namespaces/default/documents" \
     -d '{"title":"smoke-test"}'
# → { "id": "doc_..." }

# 2. presign + upload
curl -s -X POST -H "X-Textral-Api-Key: $TENANT_KEY" \
     "https://.../v1/documents/doc_.../uploads" \
     -d '{"content_type":"text/plain","size_bytes":12}'
# → { "upload_id": "...", "url": "https://..." }
echo "hello world!" | curl --upload-file - "<presigned_url>"

# 3. finalize + ingest
curl -s -X POST -H "X-Textral-Api-Key: $TENANT_KEY" \
     "https://.../v1/documents/doc_.../uploads/<upload_id>/finalize"
# → { "version_id": "ver_..." }

curl -s -X POST -H "X-Textral-Api-Key: $TENANT_KEY" \
     "https://.../v1/documents/doc_.../ingest" \
     -d '{"embedding":{"provider":"openai","model":"text-embedding-3-small",
                       "provider_key_ref":"openai-prod"}}'
# → { "job_id": "job_..." }

# 4. watch progress
watch curl -s -H "X-Textral-Api-Key: $TENANT_KEY" \
     "https://.../v1/ingestion-jobs/job_..."
# → status moves: pending → running → completed within 30 s
```

**Mandatory close items** (per the feedback review — these are not
optional even if other tests pass):

1. `document_versions` is source-only; `version_indexes` carries
   chunking + embedding profile combos.
2. Content hash is `sha256(source bytes)` streamed at finalize, not
   ETag.
3. Job lease/lock columns are populated; CAS claim returns
   `meta.changes === 1` exactly once per redelivery.
4. Internal endpoints reject any request without a valid HMAC
   signature within the 5-minute window.
5. Internal endpoints re-validate tenant + job ownership on every
   call; a forged `chunks/batch` payload with mismatched `tenant_id`
   is rejected.
6. Stage attempt history is preserved in `ingest_stage_attempts`;
   the failed-then-recovered flow shows BOTH attempts.
7. Vectorize index dim and the OpenAI `dimensions` request parameter
   match the embedding profile (1536 for text-embedding-3-large in
   our setup).
8. Chunk IDs use `chk_<version_id>_<padded_ord>` format — no ULID
   wording.
9. Partial-ingestion invariants asserted by test:
   D1+FTS5 hold all chunks; Vectorize holds only `embedding_status='embedded'`.

When every box above is green, Phase 3 is closed. Tag
`phase-3-complete`. Write `docs/retrospectives/phase-3.md` capturing
what changed vs the plan.

---

# Phase 4 begins here

Phase 4 produces the read side. Everything from here is Worker-only —
the Container is not on the query path.

---

# Step 4.1 — Hybrid retrieval

**Goal:** A pure function `runHybridRetrieval(req, env, ctx)` that
returns up to `top_k` fused candidates given a query string and a
filter set.

## 4.1.1 FTS5 query construction

**Files**
- `apps/api/src/retrieval/fts5-query.ts`

**Behavior (default mode — conservative)**
- Parse out quoted phrases first; preserve them verbatim (FTS5
  `"phrase"` syntax).
- For unquoted text: tokenize by whitespace, drop any token that
  isn't pure alphanumeric + safe Unicode-letter chars (`\p{L}\p{N}_`),
  drop FTS5 operator tokens (`AND OR NOT NEAR`, `^`, `:`, leading
  `-`).
- Lowercase. OR-join the resulting terms + phrases.
- Empty result (every token dropped) → throw `EMPTY_QUERY` (caller
  decides whether to short-circuit retrieval). Do NOT pass an empty
  MATCH string to FTS5 — it's a syntax error.

```ts
// Examples (default mode):
//   "force quit" application       → '"force quit" OR application'
//   AND OR NOT helpful?             → 'helpful'
//   colon:case ^anchor              → 'colon case anchor'
//   c++ how-to                      → 'c how to'
```

> **Why conservative?** FTS5 MATCH is unforgiving — operators like
> `AND OR NOT NEAR ^ : -` change semantics or cause syntax errors.
> Most consumer queries are natural language, not power-user search
> syntax. We never want a stray `:` in the user's input to crash
> retrieval. An `advanced_query: true` opt-in mode is reserved for a
> later phase when a clear consumer use case lands.

## 4.1.2 Vectorize query wrapper

**Files**
- `apps/api/src/retrieval/vectorize-query.ts`

**Behavior**
- Typed wrapper over `env.VECTORIZE_*.query(vector, { topK, filter,
  returnMetadata: 'all' })`.
- The filter object is constructed from the request:
  `{ tenant_id, namespace_id, version_id: { $in: [...] },
     artifact_type: { $in: [...] } }`.
- Returns `{ chunk_id, score, metadata }[]`.

## 4.1.3 Hybrid orchestrator

**Files**
- `apps/api/src/retrieval/hybrid.ts`

**Behavior**
1. Embed the query (provider abstraction; resolves the same
   embedding profile as the chosen `version_index`). Embedding
   failure → fatal `RETRIEVAL_FAILED`.
2. Parallel **`Promise.allSettled`** across:
   - Vectorize dense query (`top_k_dense`, default 30).
   - D1 FTS5 sparse query (`top_k_sparse`, default 30).
3. Determine `retrieval_status`:
   - both fulfilled → `'full'`
   - dense fulfilled, sparse rejected → `'dense_only'`
   - sparse fulfilled, dense rejected → `'sparse_only'`
   - both rejected → throw `RETRIEVAL_FAILED` (the route maps to
     `degradation_level='cannot_answer'` and skips synthesis)
4. RRF fuse (§4.3) over the surviving arms. When only one arm has
   results, fusion degrades gracefully — RRF over a single list is
   well-defined.
5. Return `{ candidates, retrieval_status, dense_count,
   sparse_count, embedding_missing_count }` so the audit pathway
   can record what actually happened.

> **Why `allSettled`, not `all`?** Production failure modes are
> usually one-arm: a Vectorize transient blip, an FTS5 query that hit
> a malformed expression. Failing the whole retrieval over a single
> arm forfeits a workable answer. Partial-ingestion (some chunks
> `embedding_status='missing'`) compounds this — the sparse arm covers
> all chunks; insisting on dense success would silently degrade
> recall.

**Acceptance**
- Unit test against fixtures: hand-curated 50-chunk corpus, three
  golden queries each with three expected chunk ids — assert all
  three appear in the top 10 fused results when both arms succeed.
- Cross-tenant test: tenant A's query against tenant B's chunks
  returns 0 hits (asserted via direct DB inspection).
- Fault injection: stub the Vectorize binding to throw. Retrieval
  returns sparse-only results with `retrieval_status='sparse_only'`.
- Both arms throwing → `RETRIEVAL_FAILED` with status 503 (transient)
  or routed via the synthesis path's `cannot_answer` degradation.

---

# Step 4.2 — Profile compatibility gate (composite)

**Files**
- `apps/api/src/retrieval/profile-gate.ts`

**Behavior**
- For every candidate version (resolved from `request.document_ids`
  or `request.namespace`), look up the matching `version_indexes`
  row by `(version_id, request.chunking_profile,
  request.embedding_profile)`.
- The gate compares **both** dimensions independently:
  - `request.embedding.profile` vs `version_index.embedding_profile`.
  - `request.chunking.profile` (or namespace default) vs
    `version_index.chunking_profile`.
- If either mismatches AND no compatible `version_index` exists for
  the same `version_id`: throw `EMBEDDING_PROFILE_MISMATCH` with:

  ```json
  {
    "code": "EMBEDDING_PROFILE_MISMATCH",
    "details": {
      "dimension": "embedding" | "chunking",
      "requested": { "embedding_profile": "...", "chunking_profile": "..." },
      "available": [
        { "embedding_profile": "...", "chunking_profile": "...", "version_index_id": "vidx_..." }
      ],
      "document_id": "doc_...",
      "version_id":  "ver_...",
      "suggestion":  "Re-ingest with the requested profile, or query with one of the available profiles."
    }
  }
  ```

- The error code stays `EMBEDDING_PROFILE_MISMATCH` for backwards
  compatibility with existing consumers; the `details.dimension` field
  disambiguates which axis failed.

**Acceptance**
- A query with `text-embedding-3-large` against a document indexed
  with `text-embedding-3-small` returns 400 `EMBEDDING_PROFILE_MISMATCH`
  with `details.dimension='embedding'`.
- A query with `chunking_profile='legal'` against a document chunked
  with `'generic'` returns the same error with
  `details.dimension='chunking'`.
- A query with both matching the same `version_index` passes the gate
  and proceeds to retrieval.
- The error response's `details.available` lists every existing
  `version_index` for the version, so the consumer can pick a
  matching profile.

---

# Step 4.3 — RRF fusion

**Files**
- `apps/api/src/retrieval/rrf.ts`

**Implementation (sketch)**

```ts
export function rrf(
  dense:  { chunk_id: string }[],
  sparse: { chunk_id: string }[],
  opts: { k?: number } = {},
): { chunk_id: string; score: number }[] {
  const k = opts.k ?? 60;
  const scores = new Map<string, number>();
  const accumulate = (list: { chunk_id: string }[]): void => {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!.chunk_id;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    }
  };
  accumulate(dense);
  accumulate(sparse);
  return [...scores.entries()]
    .map(([chunk_id, score]) => ({ chunk_id, score }))
    .sort((a, b) => b.score - a.score);
}
```

**Acceptance**
- Unit test: golden-set chunks appear in the top 10 fused results
  more often than in either arm alone.
- Property test: rank monotonicity — raising a chunk's position in
  either arm never lowers its fused score.

---

# Step 4.4 — Context assembly with unified `[N]` numbering

**Files**
- `apps/api/src/retrieval/context-assembly.ts`
- `apps/api/src/retrieval/tokenizer.ts`

**Behavior**
- Hydrate fused candidates into full chunk rows (text + metadata) via
  one `SELECT ... WHERE id IN (...)` against D1.
- **Re-sort the hydrated rows by their fused-rank position before any
  budget logic runs.** `WHERE id IN (...)` does NOT preserve the
  argument order; the rows return in arbitrary index order. Greedy
  inclusion of arbitrary-order rows would silently drop top-ranked
  candidates. Build a `Map<chunk_id, fused_rank>` from the fused
  output and `sort()` the hydrated rows by that map before stepping
  into the budget loop.
- **Token budget enforcement**: count tokens per chunk via
  `js-tiktoken` cl100k_base; greedily include from rank 1 down until
  the cumulative count would exceed `max_context_tokens`.
- **Per-layer budgets**: when `request.retrieval.artifact_types` has
  more than one entry, allocate per profile defaults (Phase 5
  exercises this; Phase 4 ships passages-only and uses a single
  uniform budget).
- Output the context block with the canonical citation header per
  chunk:

```
[1] (passage, chunk=chunk_01HZ8YT..., section=/ch3/scene2)
The full passage text here.

[2] (passage, chunk=chunk_01HZ8YU..., section=/ch4)
...
```

- Citation numbering is **sequential across all included chunks**.
- Returns `{ context_block, included: [{ n, chunk_id, ... }] }`.

**Acceptance**
- Output context fits within `max_context_tokens` (1500 tokens
  default).
- `included.length` matches the count of `[N]` markers.
- A 12K-token budget over a corpus where every chunk is 600 tokens
  yields exactly 20 included chunks.
- **Order-preservation test**: stub `db.prepare(...).all()` to return
  hydrated rows in *reverse* index order. Assert the assembled
  context still emits `[1]`, `[2]`, `[3]` in fused-rank order, NOT
  in DB-return order.

---

# Step 4.5 — Prompt construction + synthesis call

**Files**
- `apps/api/src/synthesis/prompt-builder.ts`
- `apps/api/src/synthesis/generator.ts`

## 4.5.1 Prompt construction

**Behavior**
- Resolve `system` and `developer` from `request.prompt.*` ?? namespace
  defaults ?? profile defaults.
- **Mandatory platform suffix**, appended after consumer's developer
  prompt:

```
You must cite the chunks you used by their numeric ID. Format: [N].
Cite only chunks that appear in the provided context.
```

- The user message is `request.query` followed by the assembled
  context block (clearly delimited).

## 4.5.2 Synthesis call

**Behavior**
- Reranker no-op interface: in Phase 4 every synthesis call records
  `audit.reranker = { enabled: false }` and `rerank_candidates =
  fused_candidates` (identity function). Phase 5 flips
  `enabled: true` and routes the candidates through Voyage / Cohere
  rerank without changing this audit field's name or position. SDK
  consumers don't break.
- Resolve the provider via `resolve(env, ...)` from the Phase 2
  registry.
- Call `provider.chat(...)` with the constructed messages.
- On `success` / `degraded_success`: pass through to citation
  validation (4.6). `synthesis_status='success'` (or `'truncated'`
  if `finish_reason='length'`).
- On `fatal_error`: `synthesis_status='failed'`. Surface as
  `SYNTHESIS_FAILED` with details; `degradation_level='cannot_answer'`
  unless partial output exists in which case `'partial'`.
- On `retryable_error`: the provider retried already; surface as
  `SYNTHESIS_FAILED` with `degradation_level='partial'` if any
  partial output is present, else `'cannot_answer'`.

**Acceptance**
- A query against a known document returns a coherent answer with
  numbered citations.
- A custom system prompt changes the output framing (verified by
  content of the answer in a fixture e2e test).

---

# Step 4.6 — Citation grounding + degradation level

**Files**
- `apps/api/src/synthesis/citation-validator.ts`
- `apps/api/src/synthesis/degradation.ts`

**Behavior — text mode**
- Parse `[N]` references from the answer text via `/\[(\d+)\]/g`.
- Validate that every `N` corresponds to an entry in `included`
  (from context assembly).
- **Do not mutate the answer text.** Invalid markers stay in the
  text exactly as the model emitted them. The audit field
  `dropped_citations` records the bogus N → chunk_id refs (well,
  the bogus Ns); the returned `citations[]` array contains only
  valid entries.
- Rationale: stripping `[99]` from prose leaves `"See ."` (orphan
  punctuation, broken sentences). Programmatic prose-mutation is
  worse than leaving an invalid marker that human readers can
  identify.

**Behavior — structured mode**
- The output schema must declare a `citations` field. Filter that
  array to valid entries; record removed entries in
  `audit.dropped_citations`. The structured citations array is
  explicit, so filtering it does not corrupt anything.
- If the schema does not declare `citations` and the consumer asked
  for `require_citations: true`, treat as `degradation_level='no_citations'`.

**Granular audit fields** (alongside `degradation_level`):

```ts
audit: {
  retrieval_status:    'full' | 'dense_only' | 'sparse_only' | 'empty';
  citation_integrity:  'valid' | 'invalid_removed' | 'missing';
  synthesis_status:    'success' | 'truncated' | 'failed';
  dropped_citations:   number[];                       // invalid Ns
  dense_candidates_returned:  number;
  sparse_candidates_returned: number;
  embedding_missing_count:    number;
  // ... cont'd in 4.8.1
}
```

**Compute `degradation_level`** from those:

| `retrieval_status` | `citation_integrity` | `synthesis_status` | `degradation_level` |
|--------------------|----------------------|--------------------|---------------------|
| `full` / `dense_only` / `sparse_only` | `valid` | `success` | `full` |
| any non-empty | `invalid_removed` / `missing` | `success` | `no_citations` |
| any non-empty | any | `truncated` | `partial` |
| `empty` | n/a | not invoked | `cannot_answer` |
| any | any | `failed` | `cannot_answer` |

> **`degradation_level='full'` is citation integrity, not faithfulness.**
> The platform owns citation syntax. Whether the model actually used
> the cited evidence correctly is a downstream eval problem, not a
> Phase 4 contract. The audit fields above are the diagnostic
> handles; consumers wanting tighter faithfulness checks can wire
> them in Phase 7 (eval harness).

**Acceptance**
- Response with valid citations: `degradation_level='full'`,
  answer text unchanged from provider output, `citations[]`
  matches `[N]` markers in text.
- Response that cites `[99]` against a 30-chunk context: answer
  text contains `[99]` verbatim, `citations[]` excludes it,
  `audit.dropped_citations = [99]`,
  `audit.citation_integrity='invalid_removed'`,
  `degradation_level='no_citations'`.
- Retrieval that returns 0 candidates: `degradation_level='cannot_answer'`,
  no synthesis call made, `synthesis_status` is omitted (or null).
- `retrieval_status='sparse_only'` (dense arm failed): synthesis
  proceeds with the sparse-only candidates; the response carries
  the audit field but `degradation_level` can still be `'full'` if
  citations resolve.

---

# Step 4.7 — Structured output mode

**Files**
- `apps/api/src/synthesis/structured-output.ts`

**Behavior**
- When `request.output.mode === 'structured'`:
  - Pass `request.output.schema` to the provider's structured-output
    path (Phase 2 already supports `response_format: json_schema` for
    OpenAI, forced tool_use for Anthropic, JSON mode for Workers AI).
  - On success: validate the parsed JSON against `request.output.schema`
    via Ajv (compiled per request).
  - On schema-validation failure: keep the answer in `answer.raw`,
    set `degradation_level='partial'`, do NOT 500.
  - When the schema declares a `citations` field, run citation
    validation against the structured `citations[*].chunk_id` field
    and apply the same drop-rules as 4.6.

**Acceptance**
- A query with a JSON schema returns valid JSON matching that schema.
- Schema-violating output returns `degradation_level='partial'` with
  the raw text in the response, not a 500.

---

# Step 4.8 — `POST /v1/query`

**Files**
- `apps/api/src/routes/query.ts` (NEW)
- `packages/contracts/src/query.ts` (NEW)
- `apps/api/src/openapi/components.ts` (extended)

## 4.8.1 The Zod schema

**Shape** mirrors `1-DESIGN.md` §6.7 query body. `QueryResponse`:

```ts
// Answer is a tagged object — never a raw union. SDK consumers branch
// on `answer.mode`, never on the runtime type of `answer`.
export const Answer = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    mode: z.literal('structured'),
    object: z.unknown(),                  // validated against output.schema
    raw:    z.string().optional(),        // present when validation failed; degradation='partial'
  }),
]);

export const QueryResponse = z.object({
  query_event_id: z.string(),
  answer: Answer,
  citations: z.array(z.object({
    n:            z.number().int().positive(),
    chunk_id:     z.string(),
    section_path: z.string().nullable(),
    quote:        z.string().optional(),
  })),
  degradation_level: z.enum(['full', 'no_citations', 'partial', 'cannot_answer']),
  audit: z.object({
    // Resolved profiles
    embedding_profile: z.string(),
    chunking_profile:  z.string(),
    inference_provider: z.string(),
    inference_model:    z.string(),
    provider_key_id:    z.string().nullable(),

    // Retrieval
    retrieval_strategy: z.string(),
    retrieval_status:   z.enum(['full', 'dense_only', 'sparse_only', 'empty']),
    dense_candidates_returned:  z.number().int(),
    sparse_candidates_returned: z.number().int(),
    embedding_missing_count:    z.number().int(),
    candidates_returned: z.number().int(),

    // Reranking — locked-in shape, even when disabled in Phase 4
    reranker: z.object({
      enabled:  z.boolean(),
      provider: z.string().nullable().optional(),
      model:    z.string().nullable().optional(),
      top_n:    z.number().int().nullable().optional(),
    }),

    // Citations / synthesis
    citation_integrity: z.enum(['valid', 'invalid_removed', 'missing']),
    synthesis_status:   z.enum(['success', 'truncated', 'failed']).nullable(),
    dropped_citations:  z.array(z.number().int()),

    // Tokens — explicit breakdown
    tokens: z.object({
      embedding_input:   z.number().int(),
      synthesis_input:   z.number().int(),
      synthesis_output:  z.number().int(),
      context:           z.number().int(),
    }),

    // Cost — null in Phase 4; populated in Phase 6 with the price table
    total_cost_usd_micros: z.number().int().nullable(),

    latency_ms: z.number().int(),
  }),
});
```

## 4.8.2 Route

**Behavior**
- Validate body. Resolve namespace + version_ids. Run profile gate.
- `runHybridRetrieval(...)` → fused candidates.
- (Reranker wired but disabled by default; flips on in Phase 5.)
- Context assembly → `{ context_block, included }`.
- Prompt builder → synthesis call.
- Citation validation → degradation level.
- Audit writes (4.9).
- Return the standardized response shape.

**Acceptance**
- E2E: register tenant → register namespace → ingest a fixture
  document → query it → receive answer with at least one valid
  citation.
- Latency under 4 s p95 for a 1500-token answer with 12 citations
  (recorded; not asserted in PR-blocking tests — same policy as Phase
  2 live smoke).
- The route appears in `/openapi.json` automatically because of the
  Phase 1.7 OpenAPI coverage test.

---

# Step 4.9 — `query_events` audit writes

**Files**
- `apps/api/src/audit/query-events.ts` (NEW)
- `apps/api/src/routes/query-events.ts` (NEW; `GET /v1/query-events/{id}`)

**Insert-early, update-through-stages**

A `query_events` row is created the moment we have a `tenant_id +
namespace_id`, and is updated as the query advances. Failures
populate the same row — there is no path that produces a public
error response without a corresponding audit row.

```
status flow:
  received → retrieval_started → retrieval_completed
                              → synthesis_started → completed
                              → failed   (at any point above)
```

Concrete sequence:
1. **Right after auth + body validation**: INSERT a row with
   `status='received'`, `created_at=now`, `query_text`,
   `request_config` (filtered per `tenants.audit_mode`, see below).
   The route handler now has `query_event_id`.
2. After hybrid retrieval completes: UPDATE
   `status='retrieval_completed'`, set
   `dense_candidates_returned`, `sparse_candidates_returned`,
   `retrieval_status`, `candidates_returned`, `embedding_missing_count`.
3. Before the synthesis call: UPDATE `status='synthesis_started'`.
4. After synthesis + citation validation: UPDATE
   `status='completed'`, set the rest of the audit fields,
   `degradation_level`, `latency_ms`, token columns, etc.
5. On any uncaught exception or thrown `TextralError` between steps:
   UPDATE `status='failed'`, set `error_code` + `error_message`.

**`request_config` redaction policy** based on `tenants.audit_mode`:
- `full` (default): persist the entire request body post-default-merge.
- `redacted`: persist the body with `prompt.system`, `prompt.developer`,
  and `query` replaced with the literal string `[REDACTED]`. Token
  counts and resolved provider/model fields are unaffected.
- `metadata_only`: persist only `{ namespace, document_ids?,
  embedding, inference, retrieval.strategy, output.mode }`. No
  prompts, no query text, no schemas.

A `request_config_hash` column (sha256 of the unredacted JSON) is
written in every mode so two queries with identical inputs are
recognizable across tenants who chose `redacted` or
`metadata_only`. The hash uses a tenant-specific salt to avoid
cross-tenant fingerprinting.

**Cost columns**: `total_cost_usd_micros = NULL` in Phase 4.
A Phase 6 `provider_model_prices` table (with `effective_at` dates)
fills this in alongside live observability — pricing changes, and
auditing requires reproducibility.

**R2 mirror — best-effort, no false promises**

After the response is finalized, attempt to write the full synthesis
output to R2 at:

```
{tenant_id}/{namespace_id}/answers/{query_event_id}.json
```

(No `document_id` segment; queries can span multiple documents.
Document IDs go inside the JSON payload.)

- On success: UPDATE `query_events.answer_r2_key = <r2 path>`.
- On failure: UPDATE `query_events.mirror_error = <message>` and
  leave `answer_r2_key = NULL`. Log a warning. Phase 6's reconciler
  job sweeps these.

The mirror is best-effort by design — the user's response must not
block on a third-party storage write. The acceptance criteria below
reflect this; we do **not** assert "mirror exists for every row".

**Acceptance**
- A `query_events` row exists for **every** query — successful,
  partial, or failed (including `EMBEDDING_PROFILE_MISMATCH`,
  retrieval-empty, provider-quota-exhausted, schema-validation
  failure).
- `GET /v1/query-events/{id}` returns the audit payload (tenant-scoped).
- For successful mirrors: `answer_r2_key` is populated and the R2
  object exists.
- For failed mirrors: `answer_r2_key IS NULL`, `mirror_error` is
  populated, response was unaffected.
- For a tenant with `audit_mode='redacted'`: the persisted
  `request_config` contains `[REDACTED]` for the prompt+query fields
  but token counts and resolved provider names are unaffected.
- `total_cost_usd_micros IS NULL` in every Phase 4 row (re-asserted
  in Phase 6 to lift this).

---

# Step 4.10 — Phase 4 close-out

```bash
pnpm -r typecheck                                                # green
pnpm -r lint                                                     # green
pnpm --filter @textral/api test                                  # all unit + fixture tests green
pnpm --filter @textral/api test openapi-coverage                 # /v1/query and /v1/query-events/{id} appear in spec
RUN_LIVE_TESTS=1 pnpm --filter @textral/api test query-live      # live e2e against dev
```

End-to-end:

```bash
# Continuing from Phase 3 close-out, with a finalized + ingested doc:
curl -s -X POST -H "X-Textral-Api-Key: $TENANT_KEY" \
     "https://textral-api-dev.<sub>.workers.dev/v1/query" \
     -d '{
       "namespace": "default",
       "document_ids": ["doc_..."],
       "query": "What is this document about?",
       "embedding":  { "provider": "openai", "model": "text-embedding-3-small",
                       "provider_key_ref": "openai-prod" },
       "inference":  { "provider": "openai", "model": "gpt-4o-mini",
                       "provider_key_ref": "openai-prod",
                       "max_output_tokens": 800 }
     }'
# → { "query_event_id": "qev_...", "answer": "...", "citations": [...],
#     "degradation_level": "full", "audit": {...} }

curl -s -H "X-Textral-Api-Key: $TENANT_KEY" \
     "https://.../v1/query-events/qev_..."
# → the same audit payload + the full request body that produced it
```

**Mandatory close items** (per the feedback review):

1. Hydrated chunks are re-sorted by fused rank before token-budget
   inclusion; pinned by an order-preservation test.
2. Retrieval uses `Promise.allSettled`; sparse-only / dense-only
   fallback paths exercised by fault-injection tests.
3. `audit.retrieval_status`, `dense_candidates_returned`,
   `sparse_candidates_returned`, `embedding_missing_count` populated
   on every response.
4. R2 mirror is best-effort; acceptance criteria reflect that
   (`answer_r2_key` is null on failure, `mirror_error` populated).
5. `query_events` row written for failed queries — including
   `EMBEDDING_PROFILE_MISMATCH`, retrieval-empty, provider-quota-exhausted,
   schema-validation failed.
6. `tenants.audit_mode` redaction policy enforced in
   `query_events.request_config`.
7. `QueryResponse.answer` is the tagged discriminated union, not
   `string | object`.
8. Citation validation does not mutate answer prose; bogus markers
   stay in text and are recorded in `audit.dropped_citations`.
9. `audit.reranker = { enabled: false }` present in every Phase 4
   response so Phase 5 can flip the bit without a shape break.

When every box above is green, Phase 4 is closed. Tag
`phase-4-complete`. Write `docs/retrospectives/phase-4.md` capturing
what changed vs the plan.

---

# Appendix A — File tree added in Phases 3 + 4

```
apps/api/migrations/
└── 0002_documents_jobs_chunks.sql

apps/api/src/
├── routes/
│   ├── documents.ts                 ← 3.2, 3.3
│   ├── ingestion-jobs.ts            ← 3.3
│   ├── query.ts                     ← 4.8
│   ├── query-events.ts              ← 4.9
│   └── internal/
│       ├── ingest-write.ts          ← 3.4.3
│       └── providers.ts             ← 3.4.3 — /internal/providers/embed
├── middleware/
│   └── internal-auth.ts             ← 3.4.4 — HMAC + window + ownership
├── ingestion/
│   ├── dispatch.ts                  ← 3.3
│   ├── presign.ts                   ← 3.2
│   ├── queue-handler.ts             ← 3.4.1
│   ├── job-loader.ts                ← 3.4
│   ├── lease.ts                     ← 3.4.5 — CAS claim + heartbeat
│   └── replay.ts                    ← 3.10
├── retrieval/
│   ├── hybrid.ts                    ← 4.1
│   ├── fts5-query.ts                ← 4.1.1
│   ├── vectorize-query.ts           ← 4.1.2
│   ├── rrf.ts                       ← 4.3
│   ├── profile-gate.ts              ← 4.2
│   ├── context-assembly.ts          ← 4.4
│   └── tokenizer.ts                 ← 4.4
├── synthesis/
│   ├── prompt-builder.ts            ← 4.5.1
│   ├── generator.ts                 ← 4.5.2
│   ├── citation-validator.ts        ← 4.6
│   ├── degradation.ts               ← 4.6
│   └── structured-output.ts         ← 4.7
├── audit/
│   └── query-events.ts              ← 4.9 — insert-early + redaction policy
└── lib/
    └── r2-presign.ts                ← 3.2.1

apps/ingest/app/
├── main.py                          ← 3.4.2 (extended)
├── workers/job_runner.py            ← 3.4.2, 3.10 — claim/heartbeat
├── stages/
│   ├── fetch.py                     ← 3.5
│   ├── normalize.py                 ← 3.6
│   ├── chunk.py                     ← 3.7
│   ├── embed.py                     ← 3.8 — calls /internal/providers/embed
│   └── index.py                     ← 3.9
├── normalizers/{txt,md,epub}.py     ← 3.6.2
├── chunkers/generic.py              ← 3.7
├── cdm/{model,tokens}.py            ← 3.6.1, 3.7
└── clients/
    └── worker.py                    ← 3.4.3, 3.4.4 — signs every request

# No apps/ingest/app/providers/ — Worker owns all provider calls.
# No apps/ingest/app/clients/{r2,secrets}.py — Worker mints R2 read URLs
# and never exposes provider secrets to the Container.

apps/ingest/tests/
├── conftest.py
├── test_noop_job.py                 ← 3.4.6
└── stages/{test_normalize,test_chunk,test_embed}.py

packages/contracts/src/
├── ingest.ts                        ← 3.3.1
└── query.ts                         ← 4.8.1 — tagged Answer + audit shape

apps/api/test/
├── documents-upload.test.ts         ← 3.2.3 (incl. SHA-256 + size/type validation)
├── internal-auth.test.ts            ← 3.4.4 (HMAC window + replay protection)
├── internal-ownership.test.ts       ← 3.4.3 (forged tenant in payload rejected)
├── ingestion-lease.test.ts          ← 3.4.5 (concurrent claim → exactly one wins)
├── ingestion-noop.test.ts           ← 3.4.6
├── ingestion-replay.test.ts         ← 3.10 (attempt history preserved)
├── ingestion-quota-regression.test.ts  ← 3.8 — v1 incident locked at the ingestion layer
├── partial-ingestion.test.ts        ← 3.9 — D1+FTS5 hold all, Vectorize only embedded
├── retrieval-hybrid.test.ts         ← 4.1
├── retrieval-fault-injection.test.ts ← 4.1.3 — sparse-only / dense-only
├── fts5-query.test.ts               ← 4.1.1 — operator dropping
├── rrf.test.ts                      ← 4.3
├── profile-gate.test.ts             ← 4.2 — embedding + chunking dimensions
├── context-assembly.test.ts         ← 4.4 — order preservation
├── citation-validator.test.ts       ← 4.6 — prose unchanged
├── structured-output.test.ts        ← 4.7
├── query-route.test.ts              ← 4.8 — tagged Answer
├── query-events.test.ts             ← 4.9 — audit-mode redaction + early insert
├── query-events-failures.test.ts    ← 4.9 — events written for failed queries
└── query-live.test.ts               ← 4.10 (gated)
```

---

# Appendix B — One-line answers to questions a dev might still have

| Q | A |
|---|---|
| Why does the Worker, not the Container, write to D1 / Vectorize? | Bindings are Worker primitives. Keeping the writer single avoids two cross-tenant guardrail surfaces. |
| Why does the Container reload the job from D1 instead of receiving the full payload? | Queue messages must be small + idempotent. The pointer payload makes redelivery cheap and impossible to corrupt. |
| Why aren't embeddings persisted to R2? | Vectorize is the source of truth for vectors. Replay re-embeds; deterministic chunks → deterministic vectors. |
| Why ack `fatal_failure` outcomes? | The job row already records the error. Auto-retry on a fatal billing error is the v1 incident; never. |
| Why does retrieval run on the Worker, not the Container? | Vectorize + D1 are Worker bindings, and we want zero cold-start tax on user-facing latency. The Container is ingestion-only. |
| Why is reranking wired but disabled in Phase 4? | Phase 5 corpus-profile defaults flip it on per-profile. Phase 4 closes the core path; reranking is a tuning lever, not a foundation. |
| Why is structured output schema-validated with Ajv, not Zod? | The schema is consumer-supplied JSON Schema, not a zod schema. Ajv is the right tool for runtime JSON Schema validation; compiled validators are fast. |
| Why is streaming deferred to Phase 6? | SSE adds error-handling surface (mid-stream errors, partial outputs, backpressure). Phase 4 is the smallest end-to-end path; streaming layers cleanly on top. |
| What about Workers AI at the inference tier? | The provider abstraction already supports it (Phase 2). A request with `inference.provider='workers_ai'` goes through `WorkersAIBindingProvider`. No special-casing in Phase 4. |
| Why HMAC + timestamp on internal endpoints instead of just a longer bearer token? | Bearer tokens leak through logs/traces/crash dumps and survive request replay. HMAC over `(method, path, body, timestamp)` + 5-min window means a captured request is unusable after 5 min, and you can't replay-flip a body without resigning. |
| Why does the Container not get a Secrets Store binding? | Provider keys never leave the Worker. The Worker is the single place that handles AI Gateway routing, redaction, retry classification, and telemetry. The `/internal/providers/embed` boundary keeps that contract single-source. |
| Why `version_indexes` instead of widening `document_versions`'s uniqueness? | Source identity (bytes) and indexing identity (chunking + embedding profile) are different concerns that change at different rates. Two tables let us add a new embedding profile to an existing source without minting a new "version" in the user-facing sense. |
| Why does the public API still accept `provider_key_ref` (a label) rather than IDs only? | Ergonomics. Teams structure keys by label (prod/dev/staging). We resolve the label to an exact `pkey_*` ID at dispatch and persist the ID in `config_json`, so replays always target the same key even if the label has been re-pointed since. |
| Why does retrieval use `Promise.allSettled` instead of `all`? | Production failure modes are usually one-arm — a Vectorize blip, a malformed FTS5 expression. `all` forfeits a workable answer over a single arm. The audit field `retrieval_status` records what happened; degradation is computed from the granular fields. |
| Why does Phase 4 leave `total_cost_usd_micros` null? | Pricing changes; auditing requires reproducibility. A `provider_model_prices` table with `effective_at` dates ships in Phase 6. Hardcoded constants in Phase 4 code would silently drift. |
| Why is `audit.reranker.enabled = false` written on every Phase 4 response when reranking is disabled? | So Phase 5 can flip it to `true` without changing the response shape. SDK consumers and the OpenAPI spec are stable across the boundary. |
| Why is the answer field a tagged object, not a string-or-object union? | Unions force runtime type-branching at every consumer. A discriminated union on `answer.mode` means SDKs, OpenAPI generators, and future streaming all see one stable shape. |
| Why is `request_config` redacted by tenant policy? | The persisted body can contain consumer prompts, proprietary queries, schema content. `audit_mode = full \| redacted \| metadata_only` lets enterprise tenants opt down. The hash column ensures we can still detect duplicate requests across modes. |

---

# Appendix C — Live exercise deltas (post-deploy notes)

This section records implementation deviations the live e2e against a
deployed Worker + Container surfaced. The design intent throughout the
guide stays canonical; these are the spots where reality made us pick
a different path than the doc originally prescribed.

## C.1 R2 presigned URLs are not available via the binding

**Doc says:** §3.2.1 — the helper signs a SigV4 PUT via
`R2Bucket.createPresignedUrl`, falling back to hand-rolled SigV4.

**Reality:** the R2 binding has no `createPresignedUrl` method. Native
S3-compatible presigning requires a separate R2 access key (different
credential from the Worker's CF API token). Until that's provisioned,
both `presignPut` and `presignGet` return a sentinel URL
(`https://r2.local/<key>?…`) and the routes that own those URLs detect
it and rewrite to a Worker-proxy path.

**Routes that handle the proxy:**
- `PUT /v1/documents/{id}/uploads/{upload_id}/data` — consumer-side.
  API-key authenticated, validates the `upload_intents` row, writes the
  body to R2 via the binding.
- `POST /internal/r2/object` — Container-side. HMAC-authenticated,
  ownership-checked against the job's `tenant_id` prefix, streams the
  R2 object back as raw bytes. The Container's `WorkerClient` has a
  `post_bytes()` method for this.

**To swap in native presigning later:** add R2 access keys to the
deploy, change `presignPut`/`presignGet` to actually return signed
URLs, and the routes' `isProxyFallback` branch goes dormant. No call
sites need to change.

## C.2 Cloudflare Secrets Store is KV-backed for now

**Doc says:** SECRETS.md and §1.5 — provider keys live in Cloudflare
Secrets Store, bound via `[[secrets_store_secrets]]`.

**Reality:** the deploy-time API token doesn't have Secrets Store
permission, so `getSecretsStoreClient(env)` is backed by Workers KV
(the `CACHE` namespace) under the prefix `pkey/`. The contract is
identical (write-once, read-many, deterministic names); the swap to a
real Secrets Store binding is a one-file change in
`apps/api/src/lib/secrets-store.ts`. Tests still use the in-process
Map override (`env['__TEST_PROVIDER_KEY_STORE__']`); the helper checks
for the override first, then falls through to KV, then to a Map.

**Practical implication:** provider-key registrations made in dev are
durable across worker isolates / cold starts (KV is global). They are
NOT encrypted at rest the way Secrets Store is — acceptable for dev,
not acceptable for prod. Phase 5 includes a Secrets Store cutover.

## C.3 `current_version_id` promotion happens on the Worker

**Doc says:** §3.10 — a successful complete run sets
`documents.current_version_id = version_id`.

**Reality:** the Container has no privilege to write to `documents`
(it can only call `/internal/*` write endpoints, all
ownership-checked). The promotion happens in the Worker's
`/internal/jobs/:id/transition` handler when `body.status === 'completed'`:
- `documents.current_version_id = job.version_id`
- `version_indexes.status = 'ready'`

This was missing in the first deploy and caused the query path to
return `'no candidate versions'` even after successful ingestion.

## C.4 OpenAI `text-embedding-3-large` requires explicit `dimensions`

**Doc says:** §Prerequisites #9 — "the embed call always passes
`dimensions` explicitly".

**Reality:** the `EmbeddingRequest` interface in
`apps/api/src/providers/types.ts` originally lacked a `dimensions`
field. OpenAI defaults `text-embedding-3-large` to 3072-dim; Vectorize
V2 caps at 1536. The Worker's dim check (`vectors[0].length !== 1536`)
threw 400, which the Container's embed stage interpreted as a
non-fatal transient and marked every chunk `embedding_status='missing'`
— no signal of the underlying contract violation, just empty
retrievals.

**Now:** `EmbeddingRequest.dimensions` is plumbed through the openai
provider request body, the `/internal/providers/embed` route, AND the
query path's query-vector embed call. Bug class: silent dimension
mismatch is now load-bearing (assertion-checked).

## C.5 The Container needs `WORKER_INTERNAL_URL` + `INTERNAL_HMAC_SECRET`

**Doc says:** §3.4 — the Container POSTs to the Worker's `/internal/*`
endpoints with HMAC.

**Reality:** the Container was not receiving those environment
variables in the deploy. The `IngestContainer` Durable Object class
now sets `this.envVars` from `env.WORKER_INTERNAL_URL` +
`env.INTERNAL_HMAC_SECRET` at construction time. `WORKER_INTERNAL_URL`
is a regular env var in `wrangler.toml`; `INTERNAL_HMAC_SECRET` is a
Worker secret. Both are mirrored into the Container at start, never
into the image.

**To run the live e2e for the first time** (one-time setup):
```
make deploy-dev          # builds the Container image
make migrate-dev         # applies D1 migrations
make secret-put-dev NAME=INTERNAL_HMAC_SECRET   # paste 32 random bytes hex
make secret-put-dev NAME=AUDIT_HASH_SALT        # 16 hex
make secret-put-dev NAME=API_KEY_PEPPER         # 32 hex
make secret-put-dev NAME=ADMIN_BOOTSTRAP_TOKEN  # 32 hex
make seed-dev            # creates a tenant + namespace + API key
```
The deployed Worker URL is in the `wrangler deploy` output — set it as
`WORKER_INTERNAL_URL` in `wrangler.toml` (already there for the seeded
deploy) and as `LIVE_WORKER_URL` to run the test.

## C.6 Live e2e runs as a Node script, not a vitest test

**Doc says:** §4.10 — `apps/api/test/query-live.test.ts`, gated by
`RUN_LIVE_TESTS=1`.

**Reality:** vitest-pool-workers runs tests inside workerd, where
`process.env` doesn't pass through. The live e2e is now a plain Node
script at `apps/api/scripts/test-live.ts` — same coverage, runs via
`make test-live` with `LIVE_WORKER_URL`, `LIVE_API_KEY`, and
`OPENAI_API_KEY` in the environment.

## C.7 Vectorize is eventually consistent

The Vectorize V2 binding's `upsert()` returns a `mutationId`
immediately, but the vector isn't queryable until propagation
finishes. In practice this is a few seconds; the `test-live.ts` script
sleeps 25 s between job completion and the query call. Production
consumers querying their own freshly-ingested document should expect
the same window — the audit field `retrieval_status='sparse_only'`
emerges naturally during that window because the FTS5 arm is
write-synchronous.

## C.8 Workers AI binding live-verified at /dev/workers-ai-ping

A new ENABLE_DEBUG_ROUTES-gated route exercises the `env.AI` binding
end-to-end: chat (`@cf/meta/llama-3.1-8b-instruct`) and embed
(`@cf/baai/bge-large-en-v1.5`, 1024-dim). The unit-test suite covers
the parsing logic; this route confirms the binding is wired in the
deploy. Goes away in prod (gated route).

---

End of Phase 3 + 4 implementation guide. Phase 5 (corpus profiles +
enrichment + reranker enablement) picks up immediately after.
