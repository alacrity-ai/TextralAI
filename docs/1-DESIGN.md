# Textral — DESIGN

> A generic, parameterized, multi-tenant RAG service deployed on Cloudflare.
> Documents in. Configurable ingestion + enrichment + retrieval + synthesis.
> Citation-grounded responses out.

This document is the source of truth for the refactored Textral. It
supersedes the application-shaped Textral AI v1 product and consumes the
intent declared in `0-MIGRATION_PLAN_DRAFT.md`. Where v1 made sensible
calls (multi-layer indexing, CDM, provider failure model, structured
output, eval harness) we keep them. Where v1 ossified around novels
(book/chapter/character vocabulary, single Qdrant deployment, hard-coded
synthesis prompt), we generalize.

---

## 1. Executive Summary

Textral is a **RAG execution platform**. Upstream applications register a
tenant, declare namespaces, push documents, and ask questions. Textral
runs the configurable pipeline (chunking, embedding, enrichment,
hybrid retrieval, synthesis) and returns citation-grounded answers.

The deployment substrate is Cloudflare:

```
Worker (API edge + query path)
  ├── R2          → source files & derived artifacts
  ├── D1          → metadata, jobs, chunks, FTS5 sparse index, audit
  ├── Queues      → async ingestion dispatch
  ├── Vectorize   → dense vector indexes (one per embedding profile)
  ├── Secrets Store → per-tenant provider keys (encrypted)
  ├── AI Gateway  → unified proxy for OpenAI / Anthropic / Workers AI
  └── Container   → Python ingestion + enrichment workers (queue-driven)
```

The Worker handles **everything user-facing**: API validation, auth,
hybrid retrieval (D1 FTS5 + Vectorize fused via RRF), reranking via
hosted API, synthesis via AI Gateway, and citation grounding. The
Container handles **ingestion only**: fetch → normalize → chunk →
enrich → embed → index. The Container never sits on the query path,
which means Textral has no cold-start tax on user latency.

The platform is opinionated about: tenant isolation, idempotency,
embedding/index compatibility, citation preservation, failure
semantics, and auditability. The platform is configurable about:
corpus profile, chunking, enrichment passes, embedding model,
retrieval strategy, inference model, prompt instructions, and output
schema.

---

## 2. Core Thesis & Invariants

> Textral owns the durable RAG execution substrate.
> Upstream consumers own the product intent.

The thesis collapses to ten invariants. Every architectural decision
in this doc serves one of them.

| # | Invariant |
|---|-----------|
| 1 | **Generic vocabulary.** No `book_id`, `chapter`, `character`, or `novel` in the platform core. Use `document_id`, `section`, `artifact_type`. |
| 2 | **Parameterized ingestion.** Consumer chooses corpus profile, chunking, enrichment passes, embedding model, indexing behavior. |
| 3 | **Parameterized querying.** Consumer chooses retrieval strategy, embedding model, inference model, prompt, output schema, citation policy. |
| 4 | **Prompt + output schema are first-class.** No hard-coded "you are answering questions about X" prompt. |
| 5 | **Embedding compatibility is mandatory.** A query against an index whose embedding profile differs from the query's embedding profile is rejected with `EMBEDDING_PROFILE_MISMATCH`. Never silently search incompatible vectors. |
| 6 | **Tenant isolation is enforced at every storage boundary.** D1 row-level, Vectorize metadata filter, R2 prefix, Queue partitioning. |
| 7 | **Idempotent + replayable ingestion.** Every stage keyed by `(document_id, version_id, stage)`. Re-running the same job is safe. |
| 8 | **Failure has explicit shape.** Four provider outcomes (`success`, `degraded_success`, `retryable_error`, `fatal_error`). Four query degradation levels (`full`, `no_citations`, `partial`, `cannot_answer`). Three ingestion levels (`full_success`, `partial_ingestion`, `fatal_failure`). |
| 9 | **Auditability of every meaningful parameter.** Every ingestion job and query event persists the full configuration that produced it, so behavior can be replayed and evaluated. |
| 10 | **Portable interfaces.** Cloudflare bindings sit behind `ObjectStore` / `MetadataStore` / `EventBus` / `VectorStore` / `Provider` interfaces so the system can run on Qdrant + Postgres + S3 + SQS + K8s without changes to the public API. |

---

## 3. System Architecture

### 3.1 Topology

```
                     ┌──────────────────┐
                     │  Upstream apps   │
                     └────────┬─────────┘
                              │  HTTPS, X-Textral-Api-Key
                              ▼
            ┌────────────────────────────────────┐
            │ Cloudflare Worker (textral-api)    │
            │  • API key auth + tenant resolve   │
            │  • Request validation (Zod)        │
            │  • Rate limit (per-tenant)         │
            │  • R2 presigned upload URLs        │
            │  • Job creation → Queue            │
            │  • Query: retrieve → rerank → synth│
            │  • Provider key lookup + redaction │
            └─┬──────┬───────┬──────┬──────┬─────┘
              │      │       │      │      │
   ┌──────────┘      │       │      │      └─────────┐
   │                 │       │      │                │
   ▼                 ▼       ▼      ▼                ▼
┌──────┐         ┌──────┐ ┌──────┐ ┌────────────┐ ┌──────────────┐
│  R2  │         │  D1  │ │Queue │ │  Vectorize │ │ AI Gateway → │
│      │         │+FTS5 │ │      │ │ (one index │ │ OpenAI /     │
│ blobs│         │      │ │      │ │  per emb.  │ │ Anthropic /  │
└──────┘         └──────┘ └───┬──┘ │  profile)  │ │ Workers AI   │
                              │    └────────────┘ └──────────────┘
                              ▼
                      ┌────────────────────┐
                      │ Cloudflare         │
                      │ Container          │
                      │ (textral-ingest)   │
                      │                    │
                      │ Python             │
                      │ • normalize        │
                      │ • chunk            │
                      │ • enrich           │
                      │ • embed (calls AI  │
                      │   Gateway → emb.   │
                      │   provider)        │
                      │ • index → Vectorize│
                      └────────────────────┘
```

### 3.2 Why split the Worker and Container

Cloudflare Containers sleep after `sleepAfter` (default 10 min). On
the **query path**, idle cold start is multi-second and unacceptable.
On the **ingestion path**, cold start is amortized over a multi-second
ingestion job — invisible. Therefore:

| Path | Lives in | Reason |
|------|----------|--------|
| Auth, validation, response shaping | Worker | edge latency, no cold start |
| Hybrid retrieval (D1 FTS5 + Vectorize) | Worker | both bindings are in-edge |
| Reranking | Worker | call hosted reranker (Cohere / Voyage) |
| Synthesis | Worker | call AI Gateway from edge; streams responses |
| Ingestion (fetch / normalize / chunk / embed / index) | Container | CPU-heavy, EPUB/PDF parsing, batching |
| Enrichment passes (LLM-extraction) | Container | long-running LLM orchestration |
| BM25 maintenance | Container at write time | populates D1 FTS5 |

The Container is therefore a **stateless queue worker**, not a request
gateway. The Worker enqueues jobs; a single Container instance pulls,
runs, writes results to D1/R2/Vectorize, and exits. Multiple instances
parallelize via the queue's natural fan-out.

### 3.3 Why Vectorize and not Qdrant

For MVP cost: Vectorize is per-vector-stored cheaper than managed
Qdrant Cloud and removes operational burden. Drawbacks vs Qdrant:

- **No BM25.** Solved via D1 FTS5 (see §11).
- **Immutable dimensions per index.** Solved via "one index per
  embedding profile" naming convention (see §10).
- **No collection-level rerank or query DSL beyond filter.** Reranking
  moves to a hosted reranker called from the Worker.
- **Eventual consistency on writes.** Mutation IDs returned; the
  Container records `last_processed_mutation_id` per job and the
  Worker can short-circuit queries that depend on un-applied writes.

If we outgrow Vectorize, the `VectorStore` interface (§19) lets us
swap to managed Qdrant without API changes.

---

## 4. Service Boundaries

### 4.1 Worker responsibilities

- Public REST API (versioned at `/v1`).
- Textral API key authentication, tenant resolution.
- Per-tenant rate limiting and quota enforcement.
- Request schema validation (Zod schemas shared with the Container
  via `packages/contracts`).
- Provider-key custody: lookup, decryption, redaction.
- R2 presigned URL generation for client-direct uploads.
- Job creation in D1 + dispatch to Queue.
- **Query execution**: hybrid retrieval, RRF, optional rerank, context
  assembly, synthesis call via AI Gateway, citation grounding,
  response shaping.
- Audit-log writes for every ingestion job and query event.

The Worker is **stateless**. All state lives in CF managed services.

### 4.2 Container responsibilities

- Pull jobs from Queue.
- Resolve corpus profile + per-job overrides.
- Run the configured ingestion pipeline (§9).
- Write derived artifacts to R2.
- Write chunk rows + FTS5 entries to D1.
- Write vectors to Vectorize.
- Update job + ingest_log rows on every stage transition.
- Surface clean failure on `EMBEDDING_PROFILE_MISMATCH`,
  `PROVIDER_QUOTA_EXHAUSTED`, etc., per the failure semantics in §15.

The Container **never** sees Textral API keys or raw consumer-supplied
provider keys. It receives a pre-resolved `tenant_id` + a
`provider_key_ref` that it uses to fetch the actual key from Secrets
Store via its own binding.

### 4.3 Anti-responsibilities

| Layer | MUST NOT |
|-------|----------|
| Worker | parse EPUB/PDF, run cross-encoder rerankers locally, chunk large documents (CPU limits) |
| Container | accept HTTP from anyone but the Worker via bound Durable Object |
| D1 | store provider keys in cleartext |
| R2 | store provider keys at all |
| Vectorize | be queried without a `tenant_id` metadata filter |
| Public API | leak provider keys in error bodies, logs, or retry messages |

---

## 5. Data Model

### 5.1 D1 schema (canonical)

D1 is the metadata + audit store. SQLite at the edge with FTS5 enabled
for sparse retrieval. All tables carry `tenant_id` for row-level
isolation.

```sql
-- ── Tenants & API keys ────────────────────────────────────────
CREATE TABLE tenants (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    plan            TEXT NOT NULL DEFAULT 'free',
    created_at      INTEGER NOT NULL,
    deleted_at      INTEGER
);

CREATE TABLE api_keys (
    id              TEXT PRIMARY KEY,        -- ak_01H...
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    key_hash        BLOB NOT NULL,           -- argon2id of the raw key
    key_prefix      TEXT NOT NULL,           -- "tx_live_abc..." first 12 chars for display
    scopes          TEXT NOT NULL,           -- JSON array
    created_at      INTEGER NOT NULL,
    last_used_at    INTEGER,
    revoked_at      INTEGER
);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);

-- ── Provider key registrations (BYOK) ─────────────────────────
-- The encrypted key blob lives in Cloudflare Secrets Store, keyed by
-- secrets_store_id. Only metadata lives in D1.
CREATE TABLE provider_keys (
    id              TEXT PRIMARY KEY,        -- pkey_01H...
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    provider        TEXT NOT NULL,           -- 'openai' | 'anthropic' | 'cohere' | 'voyage' | 'workers_ai'
    label           TEXT NOT NULL,           -- 'prod' | 'dev' | user-chosen
    secrets_store_id TEXT NOT NULL,          -- ref into CF Secrets Store
    last_validated_at INTEGER,
    last_error_code   TEXT,                  -- e.g. 'insufficient_quota'
    created_at      INTEGER NOT NULL,
    revoked_at      INTEGER,
    UNIQUE(tenant_id, provider, label)
);

-- ── Namespaces ────────────────────────────────────────────────
-- A namespace is a logical scope inside a tenant: typically one per
-- upstream product surface ('leases', 'support_kb', 'novels').
CREATE TABLE namespaces (
    id              TEXT PRIMARY KEY,        -- ns_01H...
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    slug            TEXT NOT NULL,
    corpus_profile  TEXT NOT NULL,           -- 'legal' | 'narrative' | 'support' | ...
    default_embedding_profile TEXT NOT NULL,
    default_inference_model   TEXT,
    default_prompt_template_id TEXT,
    created_at      INTEGER NOT NULL,
    UNIQUE(tenant_id, slug)
);

-- ── Documents & versions ──────────────────────────────────────
CREATE TABLE documents (
    id              TEXT PRIMARY KEY,        -- doc_01H...
    tenant_id       TEXT NOT NULL,
    namespace_id    TEXT NOT NULL REFERENCES namespaces(id),
    title           TEXT,
    doc_type        TEXT,                    -- e.g. 'lease_agreement', 'novel'
    metadata        TEXT,                    -- JSON, consumer-supplied
    current_version_id TEXT,                 -- FK to document_versions(id), nullable until first ingest
    created_at      INTEGER NOT NULL,
    deleted_at      INTEGER
);
CREATE INDEX idx_documents_tenant_ns ON documents(tenant_id, namespace_id);

CREATE TABLE document_versions (
    id              TEXT PRIMARY KEY,        -- ver_01H...
    document_id     TEXT NOT NULL REFERENCES documents(id),
    tenant_id       TEXT NOT NULL,
    content_hash    TEXT NOT NULL,           -- sha256 of normalized text
    source_r2_key   TEXT NOT NULL,           -- raw upload
    normalized_r2_key TEXT,                  -- canonical document JSON
    created_at      INTEGER NOT NULL,
    UNIQUE(document_id, content_hash)        -- dedup: identical content → same version_id
);
CREATE INDEX idx_versions_document ON document_versions(document_id);

-- The chunking/embedding/corpus profile + enrichment_config + enrichment_status
-- live on `version_indexes` (one row per (version_id, chunking_profile,
-- embedding_profile)), NOT on `document_versions`. Rationale: the *bytes*
-- can outlive any particular index parameter set, and a future feature
-- (re-embed under a new model) needs to add an index without forking
-- the version row. enrichment_status lives on the index — not on the
-- ingestion_jobs row — because the index is the durable artifact: the
-- job may be GC'd while the index lives on, and read-side code (query
-- pipeline, retrieval coverage gate) needs the enrichment outcome long
-- after the job is gone.

-- ── Ingestion jobs ────────────────────────────────────────────
CREATE TABLE ingestion_jobs (
    id              TEXT PRIMARY KEY,        -- job_01H...
    tenant_id       TEXT NOT NULL,
    document_id     TEXT NOT NULL,
    version_id      TEXT NOT NULL,
    mode            TEXT NOT NULL,           -- 'full' | 'embed_only' | 'enrichment_only'
    status          TEXT NOT NULL,           -- 'pending' | 'running' | 'completed' | 'failed'
    current_stage   TEXT,
    error_code      TEXT,                    -- machine-readable, see §15
    error_message   TEXT,                    -- user-facing
    retry_count     INTEGER NOT NULL DEFAULT 0,
    dead_lettered   INTEGER NOT NULL DEFAULT 0,
    config_json     TEXT NOT NULL,           -- the full request payload, for replay
    created_at      INTEGER NOT NULL,
    completed_at    INTEGER
);
CREATE INDEX idx_jobs_tenant_status ON ingestion_jobs(tenant_id, status);

-- ── Stage logs ────────────────────────────────────────────────
CREATE TABLE ingest_logs (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES ingestion_jobs(id),
    tenant_id       TEXT NOT NULL,
    stage           TEXT NOT NULL,
    status          TEXT NOT NULL,
    started_at      INTEGER NOT NULL,
    completed_at    INTEGER,
    duration_ms     INTEGER,
    metadata        TEXT,                    -- JSON: chunk_count, mutation_id, etc.
    error           TEXT
);
CREATE INDEX idx_logs_job ON ingest_logs(job_id);

-- ── Chunks (Layer 1) ──────────────────────────────────────────
-- One row per produced chunk. Vectorize stores the embedding; D1
-- stores the text + metadata + the FTS5 index. Joining vector hits
-- back to chunk rows happens by chunk_id.
CREATE TABLE chunks (
    id              TEXT PRIMARY KEY,        -- chunk_01H...
    tenant_id       TEXT NOT NULL,
    namespace_id    TEXT NOT NULL,
    document_id     TEXT NOT NULL,
    version_id      TEXT NOT NULL,
    artifact_type   TEXT NOT NULL,           -- 'passage' | 'section_summary' | 'narrative.character_dossier' | ...
    section_path    TEXT,                    -- '/preface' | '/ch3/scene2' — generic
    ord             INTEGER NOT NULL,
    text            TEXT NOT NULL,
    metadata        TEXT,                    -- JSON, artifact-type-specific
    embedding_profile TEXT NOT NULL,         -- denormalized for query-time validation
    vector_id       TEXT,                    -- the id used in Vectorize
    created_at      INTEGER NOT NULL
);
CREATE INDEX idx_chunks_doc ON chunks(tenant_id, document_id, version_id);
CREATE INDEX idx_chunks_ns_artifact ON chunks(tenant_id, namespace_id, artifact_type);

-- FTS5 virtual table mirrors `text` for sparse (BM25) retrieval.
-- tokenize=porter+unicode61 chosen for English narrative + technical text;
-- override per corpus profile if needed (e.g. a CJK profile would use
-- 'unicode61 remove_diacritics 2 categories L*').
CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text,
    content='chunks',
    content_rowid='rowid',
    tokenize='porter unicode61'
);
-- Trigger-driven sync between chunks and chunks_fts (insert/delete/update).
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- ── Query events (audit) ──────────────────────────────────────
CREATE TABLE query_events (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    namespace_id    TEXT NOT NULL,
    query_text      TEXT NOT NULL,
    request_config  TEXT NOT NULL,           -- full JSON, replay-quality
    embedding_profile_used TEXT NOT NULL,
    inference_model_used   TEXT NOT NULL,
    inference_provider     TEXT NOT NULL,
    provider_key_id        TEXT,             -- which BYOK key resolved
    retrieval_strategy     TEXT,
    candidates_returned    INTEGER,
    citations_returned     INTEGER,
    degradation_level      TEXT NOT NULL,    -- see §15
    latency_ms             INTEGER,
    input_tokens           INTEGER,
    output_tokens          INTEGER,
    total_cost_usd_micros  INTEGER,          -- attributed cost
    answer_r2_key          TEXT,             -- full response stored in R2
    created_at             INTEGER NOT NULL
);
CREATE INDEX idx_query_events_tenant ON query_events(tenant_id, created_at);

-- ── Usage / billing rollup ────────────────────────────────────
CREATE TABLE usage_records (
    tenant_id       TEXT NOT NULL,
    period_start    INTEGER NOT NULL,        -- e.g. day bucket
    queries         INTEGER NOT NULL DEFAULT 0,
    ingestion_jobs  INTEGER NOT NULL DEFAULT 0,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    embedding_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(tenant_id, period_start)
);
```

D1 size budget: 10 GB per database. At ~500 bytes per chunk row,
that's headroom for ~20M chunks before partitioning. When we cross
that bar, partition by tenant prefix.

### 5.2 R2 layout

```
{tenant_id}/{namespace_id}/{document_id}/{version_id}/
    source.{ext}              # original upload, immutable
    normalized.json            # canonical document model (CDM)
    chunks.jsonl               # Layer-1 chunks (replay material)
    artifacts/
        section_summaries.jsonl
        narrative.character_dossiers.jsonl
        legal.clauses.jsonl
        ...                    # one file per artifact_type
    answers/
        {query_event_id}.json  # full synthesis output for audit
```

R2 keys are tenant-prefixed for blast-radius isolation. A leaked S3
URL never crosses tenants.

### 5.3 Vectorize index strategy

**One Vectorize index per embedding profile.** Index name encodes the
profile so misuse is impossible:

```
textral-prod-openai-text-embedding-3-large-3072-cosine
textral-prod-openai-text-embedding-3-small-1536-cosine
textral-prod-workers-bge-large-en-v1-5-1024-cosine
```

Within each index, vectors are differentiated by metadata. **Every
vector carries**:

```json
{
  "tenant_id":     "ten_01H...",
  "namespace_id":  "ns_01H...",
  "document_id":   "doc_01H...",
  "version_id":    "ver_01H...",
  "artifact_type": "passage",
  "section_path":  "/ch3/scene2"
}
```

Pre-declared metadata indexes (Vectorize allows up to 10 per index):

| Property | Type | Why |
|----------|------|-----|
| `tenant_id` | string | mandatory filter on every query |
| `namespace_id` | string | mandatory filter |
| `document_id` | string | per-document filter |
| `version_id` | string | so we never serve a previous version's vectors |
| `artifact_type` | string | filter to passage / clause / character_dossier |
| `section_path` | string | optional, for path-prefix retrieval |

Query-time filter is therefore *always* at minimum:
```ts
{ tenant_id: { $eq: ... }, namespace_id: { $eq: ... }, version_id: { $in: [...] } }
```

### 5.4 Identifiers

All IDs are ULID-style (Crockford base32, lexicographically sortable
by creation time, 26 chars). Prefixed by entity for human readability
in logs:

```
ten_01HZ8YN2K... | tenant
ns_01HZ8YPK7...  | namespace
doc_01HZ8YQ8P... | document
ver_01HZ8YR9V... | version
job_01HZ8YS2C... | ingestion job
chunk_01HZ8YT...| chunk
ak_01HZ8YU...    | textral api key
pkey_01HZ8YV...  | registered provider key
qev_01HZ8YW...   | query event
```

Vectorize `vector_id` MUST equal the `chunk_id` so reverse-lookup is
free.

---

## 6. The Public API

Versioned at `/v1`. Authentication: `X-Textral-Api-Key: tx_live_...`.
Content type: `application/json`. Errors follow §15.

### 6.1 Tenant + key management

```
POST   /v1/tenants                                  (admin only — out of band)
POST   /v1/api-keys                                 — create
GET    /v1/api-keys
DELETE /v1/api-keys/:id

POST   /v1/provider-keys                            — register a BYOK
GET    /v1/provider-keys                            — list (returns metadata only)
DELETE /v1/provider-keys/:id
POST   /v1/provider-keys/:id/test                   — issues a 1-token call
```

### 6.2 Namespaces

```
POST   /v1/namespaces
GET    /v1/namespaces
GET    /v1/namespaces/:slug
PATCH  /v1/namespaces/:slug
DELETE /v1/namespaces/:slug
```

### 6.3 Documents

```
POST   /v1/namespaces/:ns/documents                 — register
POST   /v1/documents/:id/uploads                    — request a presigned R2 URL
POST   /v1/documents/:id/ingest                     — kick off ingestion (with config)
GET    /v1/documents/:id
GET    /v1/documents/:id/versions
DELETE /v1/documents/:id
```

### 6.4 Ingestion observability

```
GET    /v1/ingestion-jobs/:id
GET    /v1/ingestion-jobs/:id/logs
POST   /v1/ingestion-jobs/:id/retry
GET    /v1/documents/:id/ingestion-jobs
```

### 6.5 Query

```
POST   /v1/query                                    — synchronous
POST   /v1/query?stream=sse                         — streaming response
GET    /v1/query-events/:id                         — audit lookup
```

### 6.6 Eval

```
POST   /v1/namespaces/:ns/eval-sets                 — register golden questions
POST   /v1/namespaces/:ns/eval-sets/:id/runs        — run the set
GET    /v1/namespaces/:ns/eval-sets/:id/runs/:runId
```

### 6.7 The two flagship request bodies

**Ingest** (full configurability):

```json
{
  "version_id": "ver_01HZ...",
  "doc_type":   "lease_agreement",
  "embedding": {
    "provider": "openai",
    "model":    "text-embedding-3-large",
    "provider_key_ref": "openai-prod"
  },
  "chunking":  { "profile": "legal_clause_aware" },
  "enrichment": {
    "enabled": true,
    "default_model": { "provider": "openai", "model": "gpt-5.4-mini",
                       "provider_key_ref": "openai-prod" },
    "passes": [
      { "name": "clause_extraction",     "enabled": true,  "required": true },
      { "name": "obligation_extraction", "enabled": true,  "required": false,
        "model": { "provider": "openai", "model": "gpt-5.4",
                   "provider_key_ref": "openai-prod" } }
    ]
  },
  "indexing": {
    "replace_existing_vectors": true,
    "artifact_types": ["passage", "legal.clause", "legal.obligation"]
  }
}
```

**Query** (full configurability):

```json
{
  "namespace": "leases",
  "document_ids": ["doc_01HZ..."],
  "query": "What happens if the tenant pays rent late?",
  "embedding":  { "provider": "openai", "model": "text-embedding-3-large",
                  "provider_key_ref": "openai-prod" },
  "inference":  { "provider": "openai", "model": "gpt-5.5",
                  "provider_key_ref": "openai-prod",
                  "max_output_tokens": 1600 },
  "retrieval": {
    "strategy": "hybrid_rrf",
    "top_k_dense": 30,
    "top_k_sparse": 30,
    "rrf_k": 60,
    "rerank": { "enabled": true, "provider": "voyage", "model": "rerank-2",
                "top_n": 12 },
    "artifact_types": ["passage", "legal.clause", "legal.obligation"],
    "require_citations": true
  },
  "context": { "max_context_tokens": 12000, "allow_compression": false },
  "prompt": {
    "system": "You are analyzing lease documents for a landlord-facing SaaS application. Answer in plain English and distinguish contractual text from legal advice.",
    "developer": "Use only retrieved context. If insufficient, say so explicitly.",
    "template_id": "lease_plain_english_v1"
  },
  "output": {
    "mode": "structured",
    "schema": {
      "type": "object",
      "properties": {
        "answer": { "type": "string" },
        "risk_level": { "type": "string", "enum": ["low","medium","high","unknown"] },
        "citations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "chunk_id": { "type": "string" },
              "quote":    { "type": "string" }
            },
            "required": ["chunk_id", "quote"]
          }
        }
      },
      "required": ["answer", "risk_level", "citations"]
    }
  }
}
```

Sensible defaults flow from the namespace's `corpus_profile` so a
minimal request body is just `{ namespace, query }`.

---

## 7. Authentication, Tenancy, Provider Keys

### 7.1 Textral API keys

- Issued via `POST /v1/api-keys`.
- Format: `tx_live_<26-char ULID>_<32-char secret>`. The ULID is the
  display prefix; only argon2id of the full string lives in D1.
- `X-Textral-Api-Key` header on every request.
- Worker resolves key → `tenant_id` + scopes in O(1) via D1 lookup
  cached for 60 s in Workers KV.

### 7.2 Tenancy

- Every D1 table carries `tenant_id`.
- Every Vectorize query carries a `tenant_id` metadata filter.
- Every R2 key is prefixed by `tenant_id`.
- Every Queue message includes `tenant_id`.
- Cross-tenant access is impossible by construction, not by check —
  no path inside the codebase produces a query without `tenant_id` in
  its filter.

### 7.3 Provider keys (BYOK)

Per the discussion in `0-MIGRATION_PLAN_DRAFT.md` §6 and the
follow-up resolution: **register once, reference by name.**

```http
POST /v1/provider-keys
{
  "provider": "openai",
  "label": "prod",
  "key": "sk-proj-..."
}
```

On receipt:

1. Worker validates the request envelope.
2. Worker calls Cloudflare Secrets Store to store the raw key under a
   generated `secrets_store_id`.
3. Worker writes a `provider_keys` row with the metadata only.
4. Worker optionally issues a `POST .../test` request that runs a
   1-token model call to validate the key before accepting it.

Subsequent ingest/query requests reference by `provider_key_ref`
(matching `label`). The Worker resolves the ref to `secrets_store_id`,
the Container fetches the raw key from Secrets Store via its own
binding when it needs to make a provider call.

**Operational rules** (see also §8):

- Provider keys never appear in D1 columns, R2 objects, query strings,
  or response bodies.
- Worker has a single redaction middleware that strips
  `X-Provider-Key-*` headers and any `key` / `apiKey` JSON field
  before any logger sees the request.
- Error envelopes never echo provider key contents — they reference
  `provider_key_id` only.
- A `__redaction_check` route in dev environment fires fake leakage
  attempts and asserts logs are clean.

### 7.4 Workers AI as the no-key tier

If a request specifies `"provider": "workers_ai"` no `provider_key_ref`
is required — the Worker uses its bound `AI` binding directly, or
calls Workers AI through AI Gateway via the account's Cloudflare
credentials. This gives every tenant a free-tier path without
provider-key onboarding.

---

## 8. Ingestion Pipeline

### 8.1 Stages

```
fetch  →  normalize  →  chunk  →  embed  →  index  →  enrich(*) →  publish
```

- **fetch**: pull source bytes from R2.
- **normalize**: parse to Canonical Document Model (CDM). Handles
  txt/md/EPUB/HTML; PDF in v2.
- **chunk**: per `chunking_profile`, produce Layer-1 chunks
  (`artifact_type='passage'`). Section path stamped on every chunk.
- **embed**: batch-embed chunk text. Calls AI Gateway → resolved
  embedding provider.
- **index**: write chunk rows to D1 (FTS5 trigger fires) + write
  vectors to Vectorize. Both keyed on `chunk_id == vector_id`.
- **enrich(\*)**: per pass declared by the corpus profile or
  request-level config. Each pass is an independent stage that may
  produce additional artifact types (each with its own chunk row,
  FTS5 entry, and Vectorize vector).
- **publish**: mark job complete, set `documents.current_version_id`.

### 8.2 Idempotency

- `version_id` is derived from `sha256(normalized_text)`. Same content
  → same version → no duplicate ingestion.
- `chunk_id` is derived from `(version_id, ord)`. Same chunk position
  → same id, even on replay.
- `vector_id == chunk_id`. Vectorize upserts are deterministic.
- Stage logs are keyed by `(job_id, stage)` and updated in place.

### 8.3 Replay

If a stage fails non-fatally, the worker can re-enqueue the job. On
restart:

1. Look up `last_completed_stage` in `ingest_logs`.
2. Resume from `next(last_completed_stage)`.
3. Re-load any artifacts the next stage needs from R2 (CDM, chunks)
   rather than recomputing.

### 8.4 Failure dispatch

| Outcome | Behavior |
|---------|----------|
| stage success | log `completed`, advance |
| transient stage failure (network, 5xx, 429 throttle) | log `retryable_error`, exponential backoff, retry up to N |
| fatal stage failure (`insufficient_quota`, `invalid_api_key`, malformed input) | log `fatal_error`, mark job `failed`, set `dead_lettered=1`, write user-friendly `error_message` to job row, never re-enqueue |
| enrichment pass failure with `required=false` | log `failed`, continue to next pass, surface in `version_indexes.enrichment_status` |
| enrichment pass failure with `required=true` | treated as fatal stage failure |

The lesson from v1 (the OpenAI quota retry-loop incident) is encoded
in the failure dispatch table. There is no path that retries forever
on a billing error.

---

## 9. Corpus Profiles

A **corpus profile** is a named bundle of opinionated defaults for a
class of documents. It declares:

```yaml
id: legal
chunking:
  profile: legal_clause_aware
  target_tokens: 600
  overlap_tokens: 80
artifact_types:
  - id: passage
  - id: legal.clause
    enrichment_pass: clause_extraction
  - id: legal.obligation
    enrichment_pass: obligation_extraction
enrichment_passes:
  - id: clause_extraction
    recommended: true
    failure_is_fatal: false
    depends_on: []
  - id: obligation_extraction
    recommended: true
    depends_on: [clause_extraction]
retrieval_defaults:
  strategy: hybrid_rrf
  artifact_types: [passage, legal.clause, legal.obligation]
  rerank: { enabled: true, provider: voyage, model: rerank-2 }
prompt_defaults:
  system: |
    You are answering questions about legal documents. Distinguish
    between contractual language and your own analysis. Cite the
    specific clause IDs that ground your answer.
output_defaults:
  require_citations: true
```

Bundled profiles at MVP:

- `narrative` — ports v1 novel pipeline (passage, section_summary,
  scene, character_dossier, theme).
- `legal` — clause + obligation extraction, clause-aware chunking.
- `support` — troubleshooting-step extraction, FAQ-style retrieval.
- `technical` — endpoint/code-reference extraction, code-aware
  chunking.
- `generic` — passages only, no enrichment.

A request can override any field of the profile inline; auditing
records both the profile and the overrides for replay.

---

## 10. Embedding Strategy

### 10.1 Embedding profiles

Named bundles of `(provider, model, dimensions, distance_metric,
vectorize_index_name)`:

```yaml
openai-text-embedding-3-large:
  provider:   openai
  model:      text-embedding-3-large
  dimensions: 3072
  metric:     cosine
  index:      textral-prod-openai-text-embedding-3-large-3072-cosine

openai-text-embedding-3-small:
  provider:   openai
  model:      text-embedding-3-small
  dimensions: 1536
  metric:     cosine
  index:      textral-prod-openai-text-embedding-3-small-1536-cosine

workers-bge-large-en-v1-5:
  provider:   workers_ai
  model:      "@cf/baai/bge-large-en-v1.5"
  dimensions: 1024
  metric:     cosine
  index:      textral-prod-workers-bge-large-en-v1-5-1024-cosine
```

### 10.2 Compatibility gate

Every `document_versions` row stores `embedding_profile`. Every
`chunks` row denormalizes `embedding_profile` for query-time
validation. On every query:

```ts
if (request.embedding.profile !== version.embedding_profile) {
  return err(400, 'EMBEDDING_PROFILE_MISMATCH', {
    requested: request.embedding.profile,
    indexed:   version.embedding_profile,
    document_id, version_id,
    suggestion: 'Re-ingest the document with the requested profile, or query with the indexed profile.',
  });
}
```

No silent search across incompatible vectors. Ever.

### 10.3 Re-embedding

If a tenant changes their default embedding profile, existing
documents stay queryable under the old profile. To migrate, the
tenant issues `POST /v1/documents/:id/ingest { mode: "embed_only",
embedding: {...} }` which re-runs only the embed + index stages,
producing new chunk + vector rows under the new profile. The old
version's vectors live in the old index until manually pruned.

---

## 11. Retrieval Pipeline

### 11.1 Hybrid retrieval (Vectorize + D1 FTS5 + RRF)

```
                        query text
                            │
          ┌─────────────────┼─────────────────┐
          │                                   │
          ▼                                   ▼
     embed(query)                       tokenize(query)
          │                                   │
          ▼                                   ▼
   Vectorize.query                    D1 FTS5.match
   topK_dense=30                      topK_sparse=30
          │                                   │
          └──────────┬────────────────────────┘
                     ▼
             Reciprocal Rank Fusion
                     │
                     ▼
         Optional cross-encoder rerank
       (Voyage Rerank-2 / Cohere Rerank-3)
                     │
                     ▼
                 top_n = 12
```

Both arms are **filtered identically** by tenant + namespace +
version + artifact_type. Both arms run in parallel in the Worker.
Implementation:

```ts
const [dense, sparse] = await Promise.all([
  env.VECTORIZE_LARGE.query(queryEmbedding, {
    topK: req.retrieval.top_k_dense,
    filter: { tenant_id: tenantId, namespace_id: nsId,
              version_id: { $in: versionIds },
              artifact_type: { $in: req.retrieval.artifact_types } },
    returnMetadata: 'all',
  }),
  env.DB.prepare(`
    SELECT c.id AS chunk_id, c.text, c.metadata, bm25(chunks_fts) AS score
    FROM chunks c
    JOIN chunks_fts f ON f.rowid = c.rowid
    WHERE f.text MATCH ?1
      AND c.tenant_id = ?2 AND c.namespace_id = ?3
      AND c.version_id IN (${versionIds.map(()=>'?').join(',')})
      AND c.artifact_type IN (${artifactTypes.map(()=>'?').join(',')})
    ORDER BY score
    LIMIT ?4
  `).bind(ftsQuery, tenantId, nsId, ...versionIds, ...artifactTypes,
          req.retrieval.top_k_sparse).all(),
]);

const fused = rrf(dense, sparse, { k: req.retrieval.rrf_k });
```

### 11.2 Reranking

Reranking is a hosted-API call from the Worker:

- **Voyage Rerank** (recommended default): low latency, competitive
  quality, $0.05 per 1M input tokens.
- **Cohere Rerank**: alternative.
- **None**: tenant-configurable opt-out.

Rerank input: top ~30 RRF-fused candidates. Output: top_n (typically
12). Cost is low per query and stateless.

### 11.3 Multi-layer retrieval

The corpus profile's `retrieval_defaults.artifact_types` declares
which layers are searched. A request can override. Default plan for a
narrative profile:

```yaml
artifact_types:
  - passage              # primary evidence
  - section_summary      # broader context
  - narrative.scene      # chronological grounding
  - narrative.character_dossier  # relationship context
```

Each layer searches its own filtered subset of vectors in the same
Vectorize index (artifact_type filter). Per-layer budgets are honored
in context assembly (§12).

---

## 12. Synthesis

### 12.1 Context assembly

Given the reranked candidates and a `max_context_tokens` budget, the
Worker assembles a context block. Per-layer budget shares come from
the corpus profile; the request can override. Each chunk's text is
prefixed with a stable citation marker:

```
[1] (passage, chunk=chunk_01HZ8YT..., section=/ch3/scene2)
The full passage text here.

[2] (legal.clause, chunk=chunk_01HZ8YU...)
Clause text here.

[3] ...
```

Citations are **unified sequential `[1][2][3]`** across all layers.
No per-layer labels. (This was the gap in v1; it's the design here.)

### 12.2 Prompt construction

```
system  := request.prompt.system  ?? profile.prompt_defaults.system
developer := request.prompt.developer ?? profile.prompt_defaults.developer
user    := request.query
context := assembled context block
```

The platform appends one mandatory developer instruction **after**
the consumer's developer prompt:

```
You must cite the chunks you used by their numeric ID. Format: [N].
Cite only chunks that appear in the provided context.
```

This is non-negotiable — the platform owns citation integrity.

### 12.3 Structured output

If `output.mode === 'structured'`, the Worker uses the resolved
provider's structured-output API (OpenAI's `response_format`,
Anthropic's tool use, Workers AI's JSON mode). Output validation:

1. Parse against `output.schema`.
2. Validate every cited `chunk_id` exists in the assembled context.
   If not, the citation is dropped and the response is marked
   `degradation_level=no_citations`.

### 12.4 Streaming

`?stream=sse` returns Server-Sent Events. Two event types:

```
event: token
data: {"text": "..."}

event: done
data: {"answer": "...", "citations": [...], "degradation_level": "full",
       "query_event_id": "qev_...", "audit": {...}}
```

Worker streams tokens through from the upstream provider; on `done`,
runs citation validation before emitting the final event.

---

## 13. Provider Abstraction

### 13.1 The provider interface

Workers AI exposes an OpenAI-compatible REST endpoint. So does
Anthropic (via their SDK's compat layer) and OpenRouter. We normalize
on the **OpenAI request/response shape** and treat all providers as
interchangeable behind the `LLMProvider` and `EmbeddingProvider`
interfaces.

```ts
interface LLMProvider {
  chat(req: ChatRequest, options: ProviderOptions): Promise<LLMResult>;
  stream(req: ChatRequest, options: ProviderOptions): AsyncIterable<TokenEvent>;
}

interface EmbeddingProvider {
  embed(texts: string[], model: string, options: ProviderOptions): Promise<EmbeddingResult>;
}

interface RerankProvider {
  rerank(query: string, docs: string[], topN: number): Promise<RerankResult>;
}
```

Concrete implementations:

| Class | Backing |
|-------|---------|
| `OpenAICompatProvider` | OpenAI / Workers AI / OpenRouter / any compat endpoint |
| `AnthropicProvider` | Anthropic SDK (kept distinct: tools / extended thinking) |
| `WorkersAIBindingProvider` | direct `env.AI.run(...)` for the no-key tier |
| `VoyageRerankProvider` / `CohereRerankProvider` | rerank only |

### 13.2 AI Gateway routing

Every external provider call routes through Cloudflare AI Gateway
(`https://gateway.ai.cloudflare.com/...`). This gives us, for free:

- Per-tenant token + cost dashboards.
- Automatic retries (configurable).
- Prompt caching across identical calls.
- Unified analytics regardless of upstream provider.
- A single observable hop for every LLM call in the system.

Provider key + tenant ID become AI Gateway tags so per-tenant cost
attribution is dashboard-native.

### 13.3 Failure detection

The `insufficient_quota` lesson is baked in: any 429 with
`code='insufficient_quota'` (or 401 with `code='invalid_api_key'`) is
classified `fatal_error` and never retried. Provider-specific
detection lives in concrete provider classes; the interface only
distinguishes the four outcomes.

---

## 14. Failure Semantics

### 14.1 Provider outcomes

```ts
type ProviderOutcome =
  | 'success'             // valid output, return it
  | 'degraded_success'    // valid output but imperfect (e.g. partial batch); use + flag
  | 'retryable_error'     // transient (network, 5xx, throttle); retry per policy
  | 'fatal_error';        // permanent (auth, quota, malformed input); abort
```

### 14.2 Query degradation levels

```ts
type DegradationLevel =
  | 'full'              // retrieval + synthesis + citations all OK
  | 'no_citations'      // synthesis OK, citation validation failed
  | 'partial'           // retrieval OK, synthesis truncated/failed mid-stream
  | 'cannot_answer';    // retrieval empty or all providers exhausted
```

Every query response includes `degradation_level` in the audit
metadata. Streaming responses emit it on the `done` event.

### 14.3 Ingestion outcomes

```ts
type IngestionOutcome =
  | 'full_success'       // all stages + all required enrichments OK
  | 'partial_ingestion'  // core stages OK, some optional enrichments failed
  | 'fatal_failure';     // chunk/embed/index failed; nothing indexed
```

`partial_ingestion` is queryable but with reduced fidelity; the
`enrichment_status` field on the `version_indexes` row records which
passes failed (kept on the index row, not the job row, so it survives
job GC).

### 14.4 Standardized error envelope

Every error response from the public API:

```json
{
  "error": {
    "code": "EMBEDDING_PROFILE_MISMATCH",
    "message": "Requested embedding profile 'openai-text-embedding-3-large' is incompatible with indexed version (uses 'openai-text-embedding-3-small').",
    "request_id": "req_01HZ...",
    "details": { "..." : "machine-readable specifics" }
  }
}
```

Error codes are stable, documented, and machine-matchable. A
non-exhaustive set:

```
INVALID_API_KEY
TENANT_QUOTA_EXCEEDED
NAMESPACE_NOT_FOUND
DOCUMENT_NOT_FOUND
EMBEDDING_PROFILE_MISMATCH
PROVIDER_KEY_NOT_REGISTERED
PROVIDER_KEY_INVALID
PROVIDER_QUOTA_EXHAUSTED
PROVIDER_RATE_LIMITED
RETRIEVAL_FAILED
SYNTHESIS_FAILED
INGESTION_FAILED
```

---

## 15. Auditability & Observability

### 15.1 Persisted audit trails

Per the invariant — *parameterized RAG without auditability is
unevaluable*. We persist:

| What | Where | Why |
|------|-------|-----|
| Full ingestion request body (`config_json`) | `ingestion_jobs` | replay, debug, eval |
| Per-stage timing + metadata | `ingest_logs` | latency analysis, failure forensics |
| Full query request body (`request_config`) | `query_events` | replay, eval |
| Resolved embedding + inference model | `query_events` | per-tenant model usage analytics |
| Provider key reference (id only) | `query_events` | which BYOK was charged |
| Degradation level, latency, tokens, cost | `query_events` | SLO + billing |
| Full synthesis output | R2 (`answers/{qev_id}.json`) | dispute resolution, eval |

### 15.2 Live observability

- Worker `[observability]` block enabled with full sampling (per the
  reference repo convention) — every Worker log line is queryable in
  the Cloudflare dashboard for ~3 days.
- Container emits structured JSON logs to stdout; Cloudflare's
  Container log stream collects them.
- AI Gateway dashboards: per-provider, per-tenant, per-model spend +
  latency + error rate.
- Custom metrics surfaced via Workers Analytics Engine: per-tenant
  query QPS, ingestion-job throughput, degradation-level distribution,
  embedding-profile-mismatch rate.

### 15.3 Alerts

MVP alert set:

- `provider_fatal_error_rate > 1%` over 5 min (per provider)
- `degradation_level=cannot_answer` rate > 5% (per tenant)
- `dead_letter_queue_depth > 0` (any DLQ entry pages)
- `embedding_profile_mismatch_rate > 0.1%` (config drift)

---

## 16. Eval Contract

Per-namespace golden sets are first-class. The shape:

```http
POST /v1/namespaces/leases/eval-sets
{
  "name": "lease-late-rent-v1",
  "questions": [
    {
      "id": "q1",
      "query": "What happens if the tenant pays rent late?",
      "expected": {
        "must_mention": ["late fee", "grace period"],
        "must_not_mention": ["security deposit"],
        "citation_must_include_artifact_type": "legal.clause"
      },
      "judge_prompt_id": "lease-judge-v1"
    }
  ]
}
```

Running the set:

```http
POST /v1/namespaces/leases/eval-sets/lease-late-rent-v1/runs
{
  "against": { "namespace": "leases", "document_ids": ["doc_..."] },
  "query_overrides": { "inference": { "model": "gpt-5.4-mini" } }
}
```

Returns aggregate scores + per-question pass/fail. Tenants can run an
eval set as a regression gate in their own CI; we provide a CLI for
this. We also surface a "since-last-run" delta on the dashboard so
quality regressions surface visibly.

---

## 17. Cost Model

### 17.1 What Textral pays for

- Workers paid plan ($5/mo base + per-request).
- Vectorize storage + queries ($/1M vectors stored, $/1M queries).
- D1 storage + reads/writes (free tier covers MVP; meaningful past
  ~5M rows of activity).
- R2 storage (no egress fees) + Class A/B operations.
- Queues messages.
- AI Gateway (free).
- Container compute: instance-seconds while running (sleep when idle).

### 17.2 What the tenant pays for

- LLM inference (BYOK → tenant's provider account is charged
  directly).
- Embedding compute (BYOK or Workers AI tier — Workers AI cost goes
  to Textral; surface via `usage_records` if billing-through).
- Reranker calls (BYOK or Textral-provided; same).

### 17.3 Pricing the service (out of scope for this doc)

A separate doc owns pricing. The data model already records every
billable signal (`usage_records`) so any pricing model can be applied
later without retrofitting.

---

## 18. Portability

The Cloudflare-specific bindings are wrapped behind narrow
interfaces. A non-Cloudflare deployment swaps:

| Cloudflare | Interface | Fallback |
|------------|-----------|----------|
| R2 + binding | `ObjectStore` | S3, Azure Blob |
| D1 + binding | `MetadataStore` | Postgres + pgvector + tsvector for FTS |
| Queues + binding | `EventBus` | SQS, NATS, Redis Streams |
| Vectorize + binding | `VectorStore` | Qdrant, Weaviate, pgvector |
| Secrets Store | `SecretStore` | AWS Secrets Manager, HashiCorp Vault |
| AI Gateway | `LLMGateway` | direct provider SDK calls |
| Worker | runtime | Node + Hono on K8s |
| Container | runtime | Kubernetes Deployment |

The interface boundary is the only hard rule. Concrete bindings live
in `packages/cf-adapters` and `packages/node-adapters` (the latter
implemented when we need it, not before).

---

## 19. Repo Layout & Wrangler Conventions

Following the reference repos.

```
TEXTRAL_REFACTOR_WIP/
├── apps/
│   ├── api/                       # the Worker
│   │   ├── src/
│   │   │   ├── index.ts            # fetch + queue handlers
│   │   │   ├── routes/             # one file per resource
│   │   │   ├── auth/               # api-key + tenant resolution
│   │   │   ├── retrieval/          # hybrid + rrf + rerank
│   │   │   ├── synthesis/          # prompt + provider call
│   │   │   ├── providers/          # OpenAI compat, Anthropic, Workers AI
│   │   │   └── audit/
│   │   ├── migrations/             # D1 SQL migrations
│   │   └── wrangler.toml
│   └── ingest/                    # the Container
│       ├── app/
│       │   ├── stages/             # fetch / normalize / chunk / embed / index
│       │   ├── enrichment/         # one module per pass
│       │   ├── corpus_profiles/    # YAML + loader
│       │   └── workers/queue.py
│       └── Dockerfile
├── packages/
│   ├── contracts/                  # Zod schemas, shared types (TS)
│   ├── corpus-profiles/            # profile YAMLs (consumed by both apps)
│   └── eval-cli/                   # tenant-side CLI for eval runs
├── docs/
│   ├── 0-MIGRATION_PLAN_DRAFT.md   # source of intent
│   ├── 1-DESIGN.md                 # this doc
│   └── third-party/
└── infrastructure/
    └── (no docker-compose for prod; only used for local Container dev)
```

Wrangler conventions (matching the reference repos):

- Two explicit environments: `[env.prod]` and `[env.dev]`. Bare
  `wrangler deploy` is non-viable.
- Bindings declared per-environment. Dev points to dev resources
  (separate D1 / R2 / Vectorize indexes / Queue).
- `[observability]` block enabled at full sample rate.
- `compatibility_flags = ["nodejs_compat"]` for crypto + readable
  streams.
- Secrets via `wrangler secret put --env <env>`; never in
  `wrangler.toml`.
- `migrations_dir` co-located with the Worker.

---

## 20. Non-Goals

- **No frontend.** This is an API-only service. Tenants build their
  own UIs.
- **No multi-modal input** (images, audio, video). Text only at MVP.
- **No fine-tuning support.** Consumers bring fine-tuned models;
  Textral routes calls to them.
- **No conversation history persistence** as a platform concern.
  Consumers manage their own conversation state and pass relevant
  prior turns in the query payload if needed (a `conversation_history`
  array is a pass-through to the prompt builder).
- **No agent / tool-use orchestration.** Single-shot RAG only.
  Multi-step agents are the consumer's problem.
- **No PDF ingestion at MVP.** v2.
- **No custom on-device embeddings.** Hosted models only.
- **No real-time index updates from external sources.** Tenants push
  documents; we don't pull from S3/GDrive/etc.

---

## 21. Open Questions

These are deliberately unresolved at design time and tracked
separately:

1. **Streaming through AI Gateway**: confirm AI Gateway's SSE pass-through
   semantics for OpenAI structured output. May need to bypass for
   `stream=sse` requests.
2. **D1 row-count ceiling**: 10 GB / database. Plan for the
   tenant-prefix sharding migration before we hit it.
3. **Cross-tenant eval**: Textral may want to maintain its own
   reference eval corpus (no tenant data) to validate platform-level
   quality regressions independently of consumer eval sets. TBD.
4. **Reranker provider lock-in**: starting with Voyage as default;
   benchmark Cohere Rerank-3 and a self-hosted bge-reranker before
   GA.
5. **Per-tenant vs shared Vectorize index**: at scale, hot tenants
   may benefit from dedicated indexes. The schema supports it
   (just add a tenant-suffixed index name), but the routing logic
   stays per-tenant-as-metadata-filter at MVP.
6. **Workers AI quota model**: when we route a tenant's call through
   Workers AI we pay. Decide whether free-tier WAI usage is metered
   per tenant and capped, or whether it's a loss-leader.
7. **EPUB/PDF in the Worker**: long-term, a small WASM-based parser
   in the Worker could remove Container dependency for short docs.
   v3 territory.

---

## Final Statement

> Textral v2 is a generic, parameterized, multi-tenant RAG service.
> Cloudflare-native at the substrate, portable at the interfaces.
> Opinionated about correctness invariants, configurable about
> product semantics. Stateless on the query path, queue-driven on
> ingestion. Tenants bring documents, prompts, and (optionally)
> their own provider keys. Textral handles ingestion, retrieval,
> synthesis, and citations, and proves it did so with full audit.

Everything else is execution.
