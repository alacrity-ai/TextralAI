-- 0014 — bulk_jobs.
--
-- One row per bulk-ingest submission; one bulk_job_files row per file
-- in that submission. The bulk pipeline is a thin orchestration layer
-- over the existing single-file primitives (upload_intents, documents,
-- document_versions, ingestion_jobs). No new chunking, no new embedding
-- path. See docs/development/bulk_ingest/BULK_UPLOADS_DESIGN.md §4.3.
--
-- Schema decisions:
--   * `state` is a string, not an enum. SQLite has no native enum; we
--     enforce the value via CHECK. Same approach as `ingestion_jobs.status`.
--   * `config_json` stores the shared IngestRequest (minus version_id)
--     so all per-file enqueues read identical config back. Mirrors
--     `ingestion_jobs.config_json`.
--   * `client_request_id` lives on bulk_jobs at job-level (24h tenant
--     dedupe) and on bulk_job_files at file-level (per-job dedupe).
--     Both nullable — caller can opt out and rely on hash dedupe at
--     finalize time only.
--   * Aggregate counts (`files_uploaded`, `files_succeeded`, etc.) are
--     denormalized for cheap progress polling. The recompute helper
--     (`bulk-rollup.ts`) recounts from `bulk_job_files` in one query
--     and updates this row whenever a per-file state transitions.
--   * `bulk_job_id` foreign key on `ingestion_jobs` lets the queue
--     consumer write back terminal state without a join table.
--
-- Why not partial unique on (tenant_id, client_request_id):
--   D1 (SQLite 3.43+) supports partial WHERE indexes, so we use one to
--   express the "only for non-null" constraint cheaply.
--
-- Cleanup: a nightly cron in apps/api/src/scheduled/bulk-job-expire.ts
-- transitions un-finalized jobs past `expires_at` to state='expired'
-- and deletes their `tmp/bulk/{job_id}/*` R2 prefix. Completed jobs
-- (state in 'complete' / 'partial' / 'failed') retain for 90 days
-- before audit cleanup.

CREATE TABLE bulk_jobs (
    bulk_job_id        TEXT PRIMARY KEY,                -- bjk_<ULID>
    tenant_id          TEXT NOT NULL,
    namespace_id       TEXT NOT NULL,
    state              TEXT NOT NULL CHECK (state IN (
                          'accepted','uploading','finalizing','processing',
                          'complete','partial','failed','cancelled','expired'
                       )),
    config_json        TEXT NOT NULL,
    on_existing        TEXT NOT NULL CHECK (on_existing IN (
                          'skip_if_unchanged','new_version','replace_current'
                       )),
    client_request_id  TEXT,
    total_files        INTEGER NOT NULL,
    files_uploaded     INTEGER NOT NULL DEFAULT 0,
    files_succeeded    INTEGER NOT NULL DEFAULT 0,
    files_failed       INTEGER NOT NULL DEFAULT 0,
    files_skipped      INTEGER NOT NULL DEFAULT 0,
    source             TEXT NOT NULL CHECK (source IN ('api','mcp','sandbox')),
    auto_finalize      INTEGER NOT NULL DEFAULT 1,
    created_at         INTEGER NOT NULL,
    finalized_at       INTEGER,
    completed_at       INTEGER,
    expires_at         INTEGER NOT NULL
);

CREATE INDEX idx_bulk_jobs_tenant
  ON bulk_jobs(tenant_id, created_at DESC);
CREATE INDEX idx_bulk_jobs_namespace
  ON bulk_jobs(namespace_id, created_at DESC);
-- Cron-driven expiry sweep — only un-finalized jobs need scanning.
CREATE INDEX idx_bulk_jobs_expires
  ON bulk_jobs(expires_at) WHERE state IN ('accepted','uploading');
-- 24h dedupe by (tenant, client_request_id). Partial index keeps it lean.
CREATE UNIQUE INDEX uq_bulk_jobs_client_dedupe
  ON bulk_jobs(tenant_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE TABLE bulk_job_files (
    bulk_job_id           TEXT NOT NULL REFERENCES bulk_jobs(bulk_job_id) ON DELETE CASCADE,
    ordinal               INTEGER NOT NULL,
    filename              TEXT NOT NULL,
    size_bytes            INTEGER NOT NULL,
    content_type          TEXT NOT NULL,
    state                 TEXT NOT NULL CHECK (state IN (
                            'pending','uploaded','finalized',
                            'enqueued','processing','succeeded',
                            'failed','skipped'
                          )),
    upload_id             TEXT,                          -- references upload_intents(id) when issued
    upload_url_expires_at INTEGER,
    document_id           TEXT,                          -- after register
    version_id            TEXT,                          -- after finalize
    ingestion_job_id      TEXT,                          -- after enqueue
    error_code            TEXT,                          -- canonical catalog ref
    error_detail          TEXT,
    client_request_id     TEXT,
    PRIMARY KEY (bulk_job_id, ordinal)
);

CREATE INDEX idx_bulk_job_files_state
  ON bulk_job_files(bulk_job_id, state);
-- Audit join: documents/versions/ingestion_jobs by bulk job
CREATE INDEX idx_bulk_job_files_document
  ON bulk_job_files(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX idx_bulk_job_files_ingestion
  ON bulk_job_files(ingestion_job_id) WHERE ingestion_job_id IS NOT NULL;
-- Per-job file-level dedupe key
CREATE UNIQUE INDEX uq_bulk_job_files_client_dedupe
  ON bulk_job_files(bulk_job_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- Queue worker write-back foreign key. Nullable: existing single-file
-- ingestion_jobs (created via /v1/documents/{id}/ingest) carry NULL
-- here. Bulk-driven enqueues set it; the worker's terminal-state
-- handler checks for non-null and writes back to bulk_job_files.
ALTER TABLE ingestion_jobs ADD COLUMN bulk_job_id TEXT
  REFERENCES bulk_jobs(bulk_job_id) ON DELETE SET NULL;
CREATE INDEX idx_ingestion_jobs_bulk
  ON ingestion_jobs(bulk_job_id) WHERE bulk_job_id IS NOT NULL;
