-- 0014 — bulk_jobs. Postgres parallel.
--
-- See migrations/sqlite/0014_bulk_jobs.sql for the full design rationale.
-- Postgres flavor uses BIGINT for epoch-ms timestamps and BOOLEAN for
-- auto_finalize. JSONB for config_json. Otherwise identical structure.

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
    total_files        INTEGER NOT NULL,
    files_uploaded     INTEGER NOT NULL DEFAULT 0,
    files_succeeded    INTEGER NOT NULL DEFAULT 0,
    files_failed       INTEGER NOT NULL DEFAULT 0,
    files_skipped      INTEGER NOT NULL DEFAULT 0,
    source             TEXT NOT NULL CHECK (source IN ('api','mcp','sandbox')),
    auto_finalize      BOOLEAN NOT NULL DEFAULT TRUE,
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
