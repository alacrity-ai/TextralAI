-- 0012 — tenant owner email. Postgres parallel.
-- See `migrations/sqlite/0012_tenant_owner_email.sql` for the design
-- rationale. Adds the email anchor that powers self-service registration
-- and API-key recovery. Nullable for backwards compatibility with
-- admin-bootstrapped tenants.

ALTER TABLE tenants ADD COLUMN owner_email TEXT;

CREATE INDEX idx_tenants_owner_email_active
    ON tenants(owner_email)
    WHERE deleted_at IS NULL AND owner_email IS NOT NULL;
