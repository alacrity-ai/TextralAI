-- 0012 — tenant owner email.
--
-- Adds the email anchor that powers self-service registration + key
-- recovery. Nullable because:
--   1) D1/SQLite cannot ALTER TABLE ... ADD COLUMN NOT NULL on a non-
--      empty table without a default; existing tenants (admin-bootstrapped)
--      have no email associated.
--   2) Operator-bootstrapped tenants legitimately do not have an owner
--      email — `/v1/admin/bootstrap` mints them with `owner_email = NULL`.
--      Recovery via `/v1/auth/recover` simply does not find them, which
--      is the correct outcome.
--
-- New tenants created through `/v1/auth/redeem` (purpose='register') always
-- carry a non-null owner_email; the application enforces this at insert
-- time, not the schema.
--
-- The partial index is the recovery hot path: "find the active tenant
-- whose owner email matches X". Excluding deleted_at IS NOT NULL +
-- owner_email IS NULL keeps the index small.

ALTER TABLE tenants ADD COLUMN owner_email TEXT;

CREATE INDEX idx_tenants_owner_email_active
  ON tenants(owner_email)
  WHERE deleted_at IS NULL AND owner_email IS NOT NULL;
