-- 0013 — email_verifications.
--
-- Single-use, time-bounded tokens that back the self-service tenant
-- registration + key-recovery flows. The route layer issues a token at
-- /v1/auth/register or /v1/auth/recover, dispatches it via Mailgun, and
-- then consumes it at /v1/auth/redeem.
--
-- Schema decisions:
--   * `purpose` is a free-form TEXT (we don't pay for a CHECK constraint
--     here — the route layer validates against {'register','recover'}).
--   * `token_hash` is sha256(cleartext) hex; cleartext lives only inside
--     the URL Mailgun delivers. UNIQUE so D1 enforces collision-resistance
--     at the DB layer (256-bit entropy makes this redundant in practice
--     but free in cost).
--   * `tenant_id` is null for `purpose='register'` (the tenant doesn't
--     exist until redeem) and set for `purpose='recover'` (we know which
--     tenant to mint a fresh API key for).
--   * `display_name` is null for `recover`; carried for `register` so the
--     tenant insert at redeem-time has it without a separate lookup.
--   * `consumed_at` is the single-use flag. Atomic conditional update
--     in the route layer (`UPDATE ... WHERE consumed_at IS NULL`)
--     handles the double-click race.
--   * `ip_hash` is sha256(salt + remote_ip) hex — anonymized abuse
--     forensics. Salt is a Worker secret (RATE_LIMIT_IP_SALT) so the
--     rotation strategy is "rotate the salt; existing hashes become
--     anonymous to the operator." Nullable for self-host where the
--     route layer has no Cloudflare-provided IP.
--   * No background cleanup task. The unique partial index keeps the
--     active-token lookup fast; expired rows accumulate at low rate.

CREATE TABLE email_verifications (
    id            TEXT PRIMARY KEY,
    purpose       TEXT NOT NULL,
    email         TEXT NOT NULL,
    display_name  TEXT,
    tenant_id     TEXT,
    token_hash    TEXT NOT NULL UNIQUE,
    expires_at    INTEGER NOT NULL,
    consumed_at   INTEGER,
    created_at    INTEGER NOT NULL,
    ip_hash       TEXT
);

-- Active-token lookup by (email, purpose). Powers the supersession
-- step at register/recover time ("invalidate any prior unconsumed
-- token for this email + purpose before issuing a new one"). The
-- partial-where keeps the index small (consumed rows excluded).
CREATE INDEX idx_email_verifications_active
  ON email_verifications(email, purpose) WHERE consumed_at IS NULL;
