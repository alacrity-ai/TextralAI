-- 0004_admin_rate_limits.sql (Postgres)
--
-- Phase 6.8 — minute-windowed rate limiter for admin batch endpoints.
--
-- Each admin scope (e.g. `enrichment_runs`) gets its own bucket key per
-- minute. The handler does an upsert with `count = count + 1` and
-- compares the result against the configured per-minute cap.
-- Rows older than 5 minutes are pruned by the same handler at admission
-- time (no scheduled cron in MVP).

CREATE TABLE admin_rate_limits (
    tenant_id    TEXT NOT NULL,
    bucket_key   TEXT NOT NULL,
    window_start BIGINT NOT NULL,
    count        BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, bucket_key)
);
CREATE INDEX idx_admin_rate_limits_window ON admin_rate_limits(window_start);
