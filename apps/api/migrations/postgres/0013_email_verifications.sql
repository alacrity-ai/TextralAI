-- 0013 — email_verifications. Postgres parallel.
-- See `migrations/sqlite/0013_email_verifications.sql` for the full
-- design rationale. Single-use, time-bounded tokens for self-service
-- tenant registration and API-key recovery.

CREATE TABLE email_verifications (
    id            TEXT PRIMARY KEY,
    purpose       TEXT NOT NULL,
    email         TEXT NOT NULL,
    display_name  TEXT,
    tenant_id     TEXT,
    token_hash    TEXT NOT NULL UNIQUE,
    expires_at    BIGINT NOT NULL,
    consumed_at   BIGINT,
    created_at    BIGINT NOT NULL,
    ip_hash       TEXT
);

CREATE INDEX idx_email_verifications_active
    ON email_verifications(email, purpose)
    WHERE consumed_at IS NULL;
