-- 0011 — infra_keys.
--
-- Tenant-scoped credentials for vector-store backends (Pinecone today,
-- Qdrant Cloud / managed-Postgres later). Same shape as provider_keys
-- but lives in its own table because the resolution semantics differ:
--
--   * provider_keys: many per (tenant, provider), distinguished by
--     `label`, picked at request time via `provider_key_ref`. Powers
--     BYOK for OpenAI / Anthropic / Cohere / Voyage / Workers AI.
--
--   * infra_keys: at most ONE active per (tenant, provider). Picked
--     implicitly by `vector_backend` at namespace-create + every
--     subsequent upsert/query/delete. The label is for operator
--     bookkeeping (e.g. "prod-account") — future multi-account
--     support might enforce uniqueness on (tenant, provider, label)
--     instead, but for now KISS = one active per backend.
--
-- Pre-fix the worker fell back to `env.PINECONE_API_KEY` (a global
-- worker secret), which forced operators to hard-register infra
-- credentials per-deploy. Post-migration, infra keys are tenant-
-- scoped just like provider keys; the worker secret path is removed.
--
-- Storage: raw key bytes ride on the same KV-backed Secrets Store
-- shim used by provider_keys, under a deterministic
-- `ikey-{tenant_id}-{provider}-{label}` name. Deterministic-naming
-- keeps the lookup index-free and revocation atomic.

CREATE TABLE infra_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  secrets_store_secret_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_validated_at INTEGER,
  last_error_code TEXT,
  revoked_at INTEGER
);

-- Lookup hot path (vector-store factory at every upsert/query):
-- "find the active infra key for this tenant + this backend".
CREATE INDEX idx_infra_keys_tenant_provider_active
  ON infra_keys(tenant_id, provider)
  WHERE revoked_at IS NULL;

-- KISS rule: at most one active key per (tenant, provider). To
-- register a new one, revoke the old one first.
CREATE UNIQUE INDEX uq_infra_keys_active_per_provider
  ON infra_keys(tenant_id, provider)
  WHERE revoked_at IS NULL;
