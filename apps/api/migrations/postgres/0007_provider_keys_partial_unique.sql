-- 0007 — Replace the provider_keys full-table UNIQUE with a partial
-- unique index that only enforces uniqueness across active rows
-- (revoked_at IS NULL). Same intent as the parallel SQLite migration.
--
-- Why: provider-key DELETE is a soft-delete (sets revoked_at). The
-- pre-existing UNIQUE(tenant_id, provider, label) covered every row
-- including revoked ones, so an operator who revoked a key and then
-- tried to re-register under the same (provider, label) hit a 500
-- INTERNAL on the INSERT (constraint violation), even though the
-- /v1/provider-keys POST pre-check (which filters revoked_at IS NULL)
-- said "no conflict."
--
-- Postgres makes this easy: DROP CONSTRAINT (the auto-generated name
-- is `<table>_<cols>_key`) + CREATE UNIQUE INDEX with WHERE.

ALTER TABLE provider_keys
    DROP CONSTRAINT provider_keys_tenant_id_provider_label_key;

CREATE UNIQUE INDEX provider_keys_active_tenant_provider_label
    ON provider_keys(tenant_id, provider, label)
    WHERE revoked_at IS NULL;
