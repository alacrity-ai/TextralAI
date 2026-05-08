-- 0014 — bulk_jobs. Postgres parallel.
--
-- See migrations/sqlite/0014_bulk_jobs.sql for the full design rationale.
--
-- Cross-runtime parity decisions (matches the convention from
-- 0002_documents_jobs_chunks.sql for `dead_lettered`, `attempt_count`,
-- and the usage_records counter columns):
--   * Booleans (`auto_finalize`) are stored as BIGINT 0|1 rather than
--     native BOOLEAN. The pg-db adapter's setTypeParser(20) coerces
--     BIGINT to a JS `number`; SQLite's INTEGER also returns `number`.
--     Native BOOLEAN would arrive as a JS `boolean` from Postgres but
--     `0|1` from SQLite — and existing route code treats these
--     fields uniformly (`if (job.auto_finalize)` works for both, but
--     `WHERE auto_finalize = 1` in SQL would only work for the
--     INTEGER form).
--   * Counter columns (`total_files`, `files_*`) are BIGINT in
--     Postgres / INTEGER in SQLite — same as `dead_lettered`,
--     `attempt_count`, `usage_records.queries`. The pg-db adapter
--     coerces BIGINT to `number` on read.
--   * Timestamps are BIGINT epoch ms.
--   * `config_json` is JSONB; the pg-db type-parser passes it
--     through as a raw string so callers can `JSON.parse(row.x)`
--     identically across runtimes.

CREATE TABLE bulk_jobs (
    bulk_job_id        TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL,
    namespace_id       TEXT NOT NULL,
    state              TEXT NOT NULL CHECK (state IN (
                          'accepted','uploading','finalizing','processing',
                          'complete','partial','failed','cancelled','expired'
                       )),
    config_json        JSONB NOT NULL,
    on_existing        TEXT NOT NULL CHECK (on_existing IN (
                          'skip_if_unchanged','new_version','replace_current'
                       )),
    client_request_id  TEXT,
    total_files        BIGINT NOT NULL,
    files_uploaded     BIGINT NOT NULL DEFAULT 0,
    files_succeeded    BIGINT NOT NULL DEFAULT 0,
    files_failed       BIGINT NOT NULL DEFAULT 0,
    files_skipped      BIGINT NOT NULL DEFAULT 0,
    source             TEXT NOT NULL CHECK (source IN ('api','mcp','sandbox')),
    auto_finalize      BIGINT NOT NULL DEFAULT 1,
    created_at         BIGINT NOT NULL,
    finalized_at       BIGINT,
    completed_at       BIGINT,
    expires_at         BIGINT NOT NULL
);

CREATE INDEX idx_bulk_jobs_tenant
  ON bulk_jobs(tenant_id, created_at DESC);
CREATE INDEX idx_bulk_jobs_namespace
  ON bulk_jobs(namespace_id, created_at DESC);
CREATE INDEX idx_bulk_jobs_expires
  ON bulk_jobs(expires_at) WHERE state IN ('accepted','uploading');
CREATE UNIQUE INDEX uq_bulk_jobs_client_dedupe
  ON bulk_jobs(tenant_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE TABLE bulk_job_files (
    bulk_job_id           TEXT NOT NULL REFERENCES bulk_jobs(bulk_job_id) ON DELETE CASCADE,
    ordinal               INTEGER NOT NULL,
    filename              TEXT NOT NULL,
    size_bytes            BIGINT NOT NULL,
    content_type          TEXT NOT NULL,
    state                 TEXT NOT NULL CHECK (state IN (
                            'pending','uploaded','finalized',
                            'enqueued','processing','succeeded',
                            'failed','skipped'
                          )),
    upload_id             TEXT,
    upload_url_expires_at BIGINT,
    document_id           TEXT,
    version_id            TEXT,
    ingestion_job_id      TEXT,
    error_code            TEXT,
    error_detail          TEXT,
    client_request_id     TEXT,
    PRIMARY KEY (bulk_job_id, ordinal)
);

CREATE INDEX idx_bulk_job_files_state
  ON bulk_job_files(bulk_job_id, state);
CREATE INDEX idx_bulk_job_files_document
  ON bulk_job_files(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX idx_bulk_job_files_ingestion
  ON bulk_job_files(ingestion_job_id) WHERE ingestion_job_id IS NOT NULL;
CREATE UNIQUE INDEX uq_bulk_job_files_client_dedupe
  ON bulk_job_files(bulk_job_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

ALTER TABLE ingestion_jobs ADD COLUMN bulk_job_id TEXT
  REFERENCES bulk_jobs(bulk_job_id) ON DELETE SET NULL;
CREATE INDEX idx_ingestion_jobs_bulk
  ON ingestion_jobs(bulk_job_id) WHERE bulk_job_id IS NOT NULL;
