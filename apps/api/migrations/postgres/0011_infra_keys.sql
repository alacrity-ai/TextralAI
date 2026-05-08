-- 0011 — infra_keys. Postgres parallel.
-- See `migrations/sqlite/0011_infra_keys.sql` for the full design
-- rationale. Tenant-scoped credentials for vector-store backends
-- (Pinecone today; Qdrant Cloud / managed-Postgres later). Distinct
-- from provider_keys because the resolution semantics differ
-- (at-most-one active per (tenant, provider) — picked implicitly by
-- vector_backend). Pre-fix the worker fell back to env.PINECONE_API_KEY,
-- a global Worker secret; post-migration the resolution is per-tenant.

CREATE TABLE infra_keys (
    id                         TEXT PRIMARY KEY,
    tenant_id                  TEXT NOT NULL REFERENCES tenants(id),
    provider                   TEXT NOT NULL,
    label                      TEXT NOT NULL,
    secrets_store_secret_name  TEXT NOT NULL,
    created_at                 BIGINT NOT NULL,
    last_validated_at          BIGINT,
    last_error_code            TEXT,
    revoked_at                 BIGINT
);

-- Lookup hot path: factory fetches the active infra key for
-- (tenant_id, provider) on every Pinecone-backed namespace operation.
CREATE INDEX idx_infra_keys_tenant_provider_active
    ON infra_keys(tenant_id, provider)
    WHERE revoked_at IS NULL;

-- KISS rule: at most one active key per (tenant, provider). To
-- rotate, revoke + re-register. Native Postgres partial unique index.
CREATE UNIQUE INDEX uq_infra_keys_active_per_provider
    ON infra_keys(tenant_id, provider)
    WHERE revoked_at IS NULL;
