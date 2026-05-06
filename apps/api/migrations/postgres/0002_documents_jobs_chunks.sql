-- 0002_documents_jobs_chunks.sql (Postgres)
--
-- Phase 3 schema. See docs/1-DESIGN.md §5.1 + docs/development/PHASE_3_4_IMPLEMENTATION.md §3.1.
--
-- Source vs index versioning split (Option A from the feedback):
--   document_versions  = source bytes only (UNIQUE on content_hash)
--   version_indexes    = (version_id, chunking_profile, embedding_profile)
--   chunks             = points to version_index_id
--
-- ingest_stage_attempts preserves per-attempt forensic history.
-- ingestion_jobs has lease columns for queue-redelivery safety.
-- chunks has embedding_status + per-chunk diagnostic columns.
--
-- Postgres flavor: SQLite FTS5 virtual table is replaced by a generated
-- tsvector column on chunks, indexed with GIN. Postgres always enforces
-- FKs, so the SQLite `PRAGMA foreign_keys` is dropped.

-- ── tenants extension ──────────────────────────────────────────────────
-- audit_mode determines what portion of the request body is persisted in
-- query_events.request_config (full | redacted | metadata_only).
ALTER TABLE tenants ADD COLUMN audit_mode TEXT NOT NULL DEFAULT 'full';

-- ── documents ──────────────────────────────────────────────────────────
-- current_version_id is the latest successfully ingested SOURCE version,
-- embedding-profile-agnostic. Query resolution picks
-- (current_version_id, requested_profile) and looks up version_indexes.
CREATE TABLE documents (
    id                 TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL,
    namespace_id       TEXT NOT NULL REFERENCES namespaces(id),
    title              TEXT,
    doc_type           TEXT,
    metadata           JSONB,                       -- consumer-supplied
    current_version_id TEXT,                        -- nullable until first successful ingest
    created_at         BIGINT NOT NULL,
    deleted_at         BIGINT
);
CREATE INDEX idx_documents_tenant_ns ON documents(tenant_id, namespace_id);

-- ── document_versions: source identity only ────────────────────────────
-- UNIQUE(document_id, content_hash) is the dedup key — re-uploading
-- identical bytes returns the existing row.
CREATE TABLE document_versions (
    id                  TEXT PRIMARY KEY,           -- ver_<ULID>
    document_id         TEXT NOT NULL REFERENCES documents(id),
    tenant_id           TEXT NOT NULL,
    content_hash        TEXT NOT NULL,              -- sha256(source bytes)
    source_r2_key       TEXT NOT NULL,
    normalized_r2_key   TEXT,
    content_type        TEXT NOT NULL,
    size_bytes          BIGINT NOT NULL,
    created_at          BIGINT NOT NULL,
    UNIQUE(document_id, content_hash)
);
CREATE INDEX idx_document_versions_doc ON document_versions(document_id);

-- ── upload_intents: presign request memo ───────────────────────────────
-- Recorded at presign time; finalize verifies actual R2 object metadata
-- against these declared values before hashing.
CREATE TABLE upload_intents (
    id                    TEXT PRIMARY KEY,         -- upl_<ULID>
    document_id           TEXT NOT NULL REFERENCES documents(id),
    tenant_id             TEXT NOT NULL,
    upload_r2_key         TEXT NOT NULL,
    declared_size         BIGINT NOT NULL,
    declared_content_type TEXT NOT NULL,
    expires_at            BIGINT NOT NULL,
    created_at            BIGINT NOT NULL,
    consumed_at           BIGINT
);

-- ── version_indexes: (version × chunking × embedding) combos ───────────
-- One row per pipeline-state instance. Re-ingesting the same source under
-- a different profile creates a new version_index, not a new version.
CREATE TABLE version_indexes (
    id                       TEXT PRIMARY KEY,      -- vidx_<ULID>
    version_id               TEXT NOT NULL REFERENCES document_versions(id),
    tenant_id                TEXT NOT NULL,
    chunking_profile         TEXT NOT NULL,
    chunking_target_tokens   BIGINT NOT NULL,
    chunking_overlap_tokens  BIGINT NOT NULL,
    embedding_profile        TEXT NOT NULL,
    embedding_provider       TEXT NOT NULL,
    embedding_model          TEXT NOT NULL,
    embedding_dimensions     BIGINT NOT NULL,
    distance_metric          TEXT NOT NULL,
    corpus_profile           TEXT NOT NULL,
    enrichment_config        JSONB NOT NULL,
    -- enrichment_status lives on version_indexes (not ingestion_jobs)
    -- by design. Rationale: the index is the durable artifact; the
    -- job row may be GC'd while the index lives on. Phase 5 read paths
    -- (query.ts profile resolution, retrieval coverage gate) need the
    -- enrichment outcome long after the job is gone — keeping it on
    -- the index avoids a join-through-jobs that would break once jobs
    -- are pruned. Values: 'pending' | 'full' | 'partial' | 'failed'.
    enrichment_status        TEXT NOT NULL DEFAULT 'pending',
    status                   TEXT NOT NULL DEFAULT 'pending', -- pending | building | ready | partial | failed
    chunk_count              BIGINT,
    embedding_missing_count  BIGINT NOT NULL DEFAULT 0,
    created_at               BIGINT NOT NULL,
    UNIQUE(version_id, chunking_profile, embedding_profile)
);
CREATE INDEX idx_vidx_version ON version_indexes(version_id);
CREATE INDEX idx_vidx_tenant_status ON version_indexes(tenant_id, status);

-- ── ingestion_jobs: lease-bearing job rows ─────────────────────────────
-- Every job ties a (version_id) to a (version_index_id). The lease
-- columns guard against queue redelivery; CAS claim returns
-- meta.changes === 1 exactly once per redelivery.
CREATE TABLE ingestion_jobs (
    id                 TEXT PRIMARY KEY,            -- job_<ULID>
    tenant_id          TEXT NOT NULL,
    document_id        TEXT NOT NULL REFERENCES documents(id),
    version_id         TEXT NOT NULL REFERENCES document_versions(id),
    version_index_id   TEXT NOT NULL REFERENCES version_indexes(id),
    mode               TEXT NOT NULL,               -- full | embed_only | enrichment_only
    status             TEXT NOT NULL,               -- pending | running | retrying | completed | failed
    current_stage      TEXT,
    error_code         TEXT,
    error_message      TEXT,
    attempt_count      BIGINT NOT NULL DEFAULT 0,
    locked_at          BIGINT,
    locked_by          TEXT,                        -- container instance id
    lease_expires_at   BIGINT,
    heartbeat_at       BIGINT,
    dead_lettered      BIGINT NOT NULL DEFAULT 0,
    config_json        JSONB NOT NULL,              -- request body, post-default-merge,
                                                    -- with provider_key_ref → provider_key_id
    created_at         BIGINT NOT NULL,
    completed_at       BIGINT
);
CREATE INDEX idx_jobs_tenant_status ON ingestion_jobs(tenant_id, status);
CREATE INDEX idx_jobs_lease ON ingestion_jobs(status, lease_expires_at);

-- ── ingest_stage_attempts: forensic history ────────────────────────────
-- One row per attempt; latest computed via MAX(attempt) WHERE status='completed'.
CREATE TABLE ingest_stage_attempts (
    job_id        TEXT NOT NULL REFERENCES ingestion_jobs(id),
    stage         TEXT NOT NULL,
    attempt       BIGINT NOT NULL,
    tenant_id     TEXT NOT NULL,
    status        TEXT NOT NULL,                    -- started | completed | failed | skipped
    started_at    BIGINT NOT NULL,
    completed_at  BIGINT,
    duration_ms   BIGINT,
    metadata      JSONB,                            -- chunk_count, mutation_id, ...
    error_code    TEXT,
    error_message TEXT,
    PRIMARY KEY(job_id, stage, attempt)
);
CREATE INDEX idx_stage_job ON ingest_stage_attempts(job_id);
CREATE INDEX idx_stage_job_started ON ingest_stage_attempts(job_id, started_at);

-- ── chunks ─────────────────────────────────────────────────────────────
-- Points to version_index_id. embedding_status makes the partial-ingestion
-- contract explicit. Diagnostic columns let ops verify a Vectorize vector
-- corresponds to expected text without persisting the vector.
--
-- The trailing `tsv` column replaces the SQLite chunks_fts virtual table:
-- it is auto-maintained by Postgres via the GENERATED ALWAYS AS clause,
-- so no triggers are needed (the SQLite chunks_ai/ad/au triggers are
-- intentionally dropped here — the generated column self-syncs).
CREATE TABLE chunks (
    id                            TEXT PRIMARY KEY, -- chk_<version_id>_<padded_ord>
    tenant_id                     TEXT NOT NULL,
    namespace_id                  TEXT NOT NULL,
    document_id                   TEXT NOT NULL,
    version_id                    TEXT NOT NULL,
    version_index_id              TEXT NOT NULL REFERENCES version_indexes(id),
    artifact_type                 TEXT NOT NULL,    -- 'passage' | ...
    section_path                  TEXT,
    ord                           BIGINT NOT NULL,
    text                          TEXT NOT NULL,
    metadata                      JSONB,
    -- Denormalized from version_indexes for cheap query-time gating
    embedding_profile             TEXT NOT NULL,
    chunking_profile              TEXT NOT NULL,
    -- Partial-ingestion invariant
    embedding_status              TEXT NOT NULL DEFAULT 'pending', -- pending | embedded | missing
    -- Diagnostic columns
    embedding_input_hash          TEXT,
    embedding_provider_request_id TEXT,
    embedding_dimensions          BIGINT,
    -- Vectorize boundary (kept = id for clarity)
    vector_id                     TEXT,
    created_at                    BIGINT NOT NULL,
    -- BM25 sparse index, replaces SQLite chunks_fts (FTS5 virtual table).
    tsv                           tsvector
        GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED
);
CREATE INDEX idx_chunks_doc ON chunks(tenant_id, document_id, version_id);
CREATE INDEX idx_chunks_vidx ON chunks(version_index_id);
CREATE INDEX idx_chunks_ns_artifact ON chunks(tenant_id, namespace_id, artifact_type);
CREATE INDEX chunks_tsv_idx ON chunks USING GIN (tsv);

-- ── query_events: insert-early audit ───────────────────────────────────
-- Inserted as soon as tenant + namespace are resolved, updated as the query
-- progresses. Failed queries are recorded too. total_cost_usd_micros is
-- NULL in Phase 4 (Phase 6 fills it in via a price table with effective dates).
CREATE TABLE query_events (
    id                       TEXT PRIMARY KEY,    -- qev_<ULID>
    tenant_id                TEXT NOT NULL,
    namespace_id             TEXT NOT NULL,
    status                   TEXT NOT NULL,       -- received | retrieval_started | retrieval_completed
                                                  -- | synthesis_started | completed | failed
    query_text               TEXT NOT NULL,
    request_config           JSONB NOT NULL,      -- per tenants.audit_mode
    request_config_hash      TEXT NOT NULL,       -- tenant-salted sha256 of unredacted JSON
    embedding_profile_used   TEXT,
    chunking_profile_used    TEXT,
    inference_model_used     TEXT,
    inference_provider       TEXT,
    provider_key_id          TEXT,
    retrieval_strategy       TEXT,
    retrieval_status         TEXT,                -- full | dense_only | sparse_only | empty
    citation_integrity       TEXT,                -- valid | invalid_removed | missing
    synthesis_status         TEXT,                -- success | truncated | failed
    candidates_returned      BIGINT,
    dense_candidates_returned  BIGINT,
    sparse_candidates_returned BIGINT,
    embedding_missing_count  BIGINT,
    citations_returned       BIGINT,
    dropped_citations        JSONB,               -- array of int Ns
    degradation_level        TEXT,
    latency_ms               BIGINT,
    embedding_input_tokens   BIGINT,
    synthesis_input_tokens   BIGINT,
    synthesis_output_tokens  BIGINT,
    context_tokens           BIGINT,
    total_cost_usd_micros    BIGINT,              -- NULL in Phase 4
    answer_r2_key            TEXT,
    mirror_error             TEXT,
    error_code               TEXT,
    error_message            TEXT,
    created_at               BIGINT NOT NULL,
    completed_at             BIGINT
);
CREATE INDEX idx_query_events_tenant ON query_events(tenant_id, created_at);
CREATE INDEX idx_query_events_status ON query_events(tenant_id, status);
