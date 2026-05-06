-- 0001_baseline.sql
--
-- Tenants, API keys, namespaces, BYOK provider-key metadata, usage rollups.
-- See docs/1-DESIGN.md §5.1 for the canonical schema reference.
--
-- D1 is SQLite-at-the-edge. Identifiers are TEXT (ULIDs); timestamps are
-- INTEGER (epoch ms) for portability.

PRAGMA foreign_keys = ON;

-- ── Tenants ─────────────────────────────────────────────────────────────
CREATE TABLE tenants (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    plan         TEXT NOT NULL DEFAULT 'free',
    created_at   INTEGER NOT NULL,
    deleted_at   INTEGER
);

-- ── API keys ────────────────────────────────────────────────────────────
-- key_hash is HMAC-SHA-256(server-side pepper, raw_key) stored as a hex
-- string. Implementation choice supersedes the design doc's argon2id mention:
-- API keys are 32+ char random strings, so HMAC + pepper is the correct
-- primitive (matches Stripe / GitHub PAT model). Per-request lookup is O(1)
-- via the unique index.
CREATE TABLE api_keys (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id),
    key_hash     TEXT NOT NULL UNIQUE,
    key_prefix   TEXT NOT NULL,           -- first 12 chars, for display only
    scopes       TEXT NOT NULL,           -- JSON array
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX idx_api_keys_active ON api_keys(key_hash) WHERE revoked_at IS NULL;

-- ── Namespaces ──────────────────────────────────────────────────────────
CREATE TABLE namespaces (
    id                         TEXT PRIMARY KEY,
    tenant_id                  TEXT NOT NULL REFERENCES tenants(id),
    slug                       TEXT NOT NULL,
    corpus_profile             TEXT NOT NULL DEFAULT 'generic',
    default_embedding_profile  TEXT NOT NULL DEFAULT 'openai-text-embedding-3-large',
    default_inference_model    TEXT,
    default_prompt_template_id TEXT,
    created_at                 INTEGER NOT NULL,
    deleted_at                 INTEGER,
    UNIQUE(tenant_id, slug)
);
CREATE INDEX idx_namespaces_tenant ON namespaces(tenant_id);

-- ── Provider-key registrations (BYOK) ───────────────────────────────────
-- The encrypted raw key lives in Cloudflare Secrets Store, addressed by
-- secrets_store_secret_name. ONLY metadata lives in D1 — no raw key, no
-- ciphertext blob. Naming convention: pkey-{tenant_id}-{provider}-{label}.
CREATE TABLE provider_keys (
    id                         TEXT PRIMARY KEY,
    tenant_id                  TEXT NOT NULL REFERENCES tenants(id),
    provider                   TEXT NOT NULL,
    label                      TEXT NOT NULL,
    secrets_store_secret_name  TEXT NOT NULL,
    last_validated_at          INTEGER,
    last_error_code            TEXT,
    created_at                 INTEGER NOT NULL,
    revoked_at                 INTEGER,
    UNIQUE(tenant_id, provider, label)
);
CREATE INDEX idx_provider_keys_tenant ON provider_keys(tenant_id);

-- ── Usage rollups ───────────────────────────────────────────────────────
-- One row per (tenant, day-bucket). Phase 6 wires the writers; Phase 1
-- only needs the table to exist.
CREATE TABLE usage_records (
    tenant_id        TEXT NOT NULL,
    period_start     INTEGER NOT NULL,
    queries          INTEGER NOT NULL DEFAULT 0,
    ingestion_jobs   INTEGER NOT NULL DEFAULT 0,
    input_tokens     INTEGER NOT NULL DEFAULT 0,
    output_tokens    INTEGER NOT NULL DEFAULT 0,
    embedding_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(tenant_id, period_start)
);
