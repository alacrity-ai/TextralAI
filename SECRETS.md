# Secrets

This document is the canonical list of every secret the Textral
service depends on. It is split by where the secret lives — Cloudflare
Secrets Store (bound into the Worker), Worker secrets (set via
`wrangler secret put`), or external (provider accounts).

Whenever a phase introduces a new secret, **add it here in the same
PR**. CI does not enforce this, but reviewers do.

---

## Cloudflare Secrets Store

Secrets bound into the Worker via `[[secrets_store_secrets]]` in
`wrangler.toml`. Store provisioned in Phase 1.1 (one per env).

| Secret name | Phase | Purpose |
|---|---|---|
| `api-key-pepper` | 1.3 | Server-side pepper used to HMAC-hash customer Textral API keys before D1 lookup. Different value per env. Rotate by re-issuing all API keys (one-shot migration script — out of scope for MVP). |
| `pkey-{tenant_id}-{provider}-{label}` | 1.5 | One per registered consumer provider key (BYOK). Encrypted at rest. The Worker resolves `provider_keys.secrets_store_secret_name` from D1 to fetch. |

> **Phase 3+4 status (2026-05):** the deploy-time API token in dev
> does not have Secrets Store permissions, so `pkey-*` storage falls
> through to Workers KV (the `CACHE` namespace) under the `pkey/`
> prefix. This is durable across isolates but **not encrypted at rest
> the way Secrets Store is**. Acceptable for dev; Phase 5 cuts over
> to a real Secrets Store binding. See PHASE_3_4_IMPLEMENTATION.md
> Appendix C.2.

Operations:

```bash
# Put / replace a secret in dev:
npx wrangler secrets-store secret put api-key-pepper \
  --store textral-secrets-dev --value "$(openssl rand -hex 32)"

# List:
npx wrangler secrets-store secret list --store textral-secrets-dev
```

---

## Worker secrets (`wrangler secret put`)

Secrets that should be visible to the Worker at runtime via `c.env.*`,
but don't need the storage primitives of Secrets Store.

| Secret name | Phase | Purpose |
|---|---|---|
| `ADMIN_BOOTSTRAP_TOKEN` | 1.4 | One-time token for the `/v1/admin/bootstrap` endpoint. Used by `make seed-dev` to create the first tenant. Revoke after seeding (set to a fresh random value or delete). |
| `API_KEY_PEPPER` | 1.3 | Phase-1 stand-in for the Secrets-Store-backed pepper. Rotate by re-issuing customer API keys. |
| `INTERNAL_HMAC_SECRET` | 3.4 | Shared secret signing every Container ↔ Worker `/internal/*` request. The `IngestContainer` DO mirrors it into the Container as an env var at start. When unset, all `/internal/*` routes 404. Rotate by re-deploying both the Worker and the Container. |
| `AUDIT_HASH_SALT` | 4.9 | Tenant-salt for `query_events.request_config_hash`. Distinct per env to prevent cross-env fingerprinting. Rotate only with a backfill plan — old hashes become unmatchable. |

Operations:

```bash
make secret-put-dev NAME=ADMIN_BOOTSTRAP_TOKEN
# Then paste the value when prompted.

# Generate + put all four Phase-3/4 worker secrets at once (dev):
make bootstrap-secrets-dev
```

---

## External (consumer-supplied)

Per-tenant provider keys that consumers register via
`POST /v1/provider-keys`. These are stored in Secrets Store under the
deterministic `pkey-{tenant_id}-{provider}-{label}` name above.

The platform itself **never** holds OpenAI / Anthropic / Voyage / Cohere
API keys; everything goes through the BYOK flow.

The one exception is Cloudflare itself: AI Gateway, Vectorize, R2, D1,
and Queues are bound directly via `wrangler.toml`, so no API token
lives in the Worker.

---

## Adding a new secret

1. Add a row to one of the tables above with the phase that introduced
   it and a one-line purpose.
2. Reference it in `wrangler.toml` (Secrets Store) or document the
   `wrangler secret put` step in the PR body.
3. Verify the redaction middleware (Phase 1.6) covers any plausible
   path the secret could leak through (logs, error envelopes, AI
   Gateway metadata tags).
