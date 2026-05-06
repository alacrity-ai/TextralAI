-- 0007 — Replace the provider_keys full-table UNIQUE with a partial
-- unique index that only enforces uniqueness across **active** rows
-- (revoked_at IS NULL).
--
-- Why: provider-key DELETE is a soft-delete (sets revoked_at). The
-- pre-existing UNIQUE(tenant_id, provider, label) covered every row
-- including revoked ones, so an operator who revoked a key and then
-- tried to re-register under the same (provider, label) hit a 500
-- INTERNAL on the INSERT (constraint violation), even though the
-- /v1/provider-keys POST pre-check (which filters revoked_at IS NULL)
-- said "no conflict." The two were inconsistent.
--
-- SQLite has no DROP CONSTRAINT for inline UNIQUE table constraints,
-- so we follow the 12-step ALTER pattern from sqlite.org/lang_altertable:
-- create the new table, copy data, drop the old, rename. Foreign-key
-- references off this table are stable (the PRIMARY KEY id column
-- doesn't change), so no FK rewiring is needed.
--
-- D1 doesn't accept raw `BEGIN`/`COMMIT` or PRAGMA wrapping (it
-- routes transactions through its own state.storage API and
-- foreign-key enforcement is off by default). Each migration
-- statement runs independently; D1's migration runner applies the
-- file as a unit and logs a failure if any statement errors. In
-- practice the rebuild is short and atomic-enough.

PRAGMA foreign_keys = OFF;

CREATE TABLE provider_keys_new (
    id                         TEXT PRIMARY KEY,
    tenant_id                  TEXT NOT NULL REFERENCES tenants(id),
    provider                   TEXT NOT NULL,
    label                      TEXT NOT NULL,
    secrets_store_secret_name  TEXT NOT NULL,
    last_validated_at          INTEGER,
    last_error_code            TEXT,
    created_at                 INTEGER NOT NULL,
    revoked_at                 INTEGER
    -- No table-level UNIQUE — replaced by the partial index below.
);

INSERT INTO provider_keys_new
    (id, tenant_id, provider, label, secrets_store_secret_name,
     last_validated_at, last_error_code, created_at, revoked_at)
  SELECT
     id, tenant_id, provider, label, secrets_store_secret_name,
     last_validated_at, last_error_code, created_at, revoked_at
  FROM provider_keys;

DROP TABLE provider_keys;
ALTER TABLE provider_keys_new RENAME TO provider_keys;

CREATE INDEX idx_provider_keys_tenant ON provider_keys(tenant_id);

-- The active-only uniqueness invariant. SQLite has supported partial
-- indexes since 3.8.0 (2014).
CREATE UNIQUE INDEX provider_keys_active_tenant_provider_label
    ON provider_keys(tenant_id, provider, label)
    WHERE revoked_at IS NULL;

PRAGMA foreign_keys = ON;
