# Deploy Runbook

Phase 8.7. Production deploy checklist. Use for first deploys + every
subsequent release.

## Pre-flight

- [ ] `pnpm -r typecheck` clean.
- [ ] `pnpm -r lint` clean.
- [ ] `pnpm -r test` green.
- [ ] `make test-ingest` green.
- [ ] Live e2e green: `make test-live`, `make test-live-phase5`.
- [ ] `tools/check-no-inline-d1.sh` passes (CI guard).
- [ ] Threat model reviewed (`docs/security/THREAT_MODEL.md`); no ✗.
- [ ] Migrations applied to a clean dev account (sanity check).
- [ ] CF account permissions confirmed: D1 read/write, R2 read/write,
      KV read/write, Vectorize V2, Workers, AI Gateway, Containers.

## Required secrets

Set via `wrangler secret put --env prod`:

- `INTERNAL_HMAC_SECRET` — HMAC for the Worker ↔ Container
  back-channel. Mirrored into the Container at deploy time.
- `API_KEY_PEPPER` — server-side pepper for hashing customer API keys.
- `AUDIT_HASH_SALT` — per-tenant salt for `query_events.request_config_hash`.
- `ADMIN_BOOTSTRAP_TOKEN` — one-time bootstrap token for tenant
  registration. Rotate or delete after seeding.

## Required bindings

In `apps/api/wrangler.toml` under `[env.prod]`:

- `DB` (D1)
- `BLOBS` (R2 bucket)
- `INGEST_QUEUE` (Queue)
- `VECTORIZE_OPENAI_LARGE` (Vectorize V2 index, 1536 dim, cosine)
- `CACHE` (KV namespace)
- `INGEST_CONTAINER` (Durable Object namespace for the Container)
- `AI` (Workers AI binding)
- (optional) `AE_METRICS` (Analytics Engine dataset)

If `AE_METRICS` is absent, metric writes are no-ops — the system
works but dashboards are empty. Add the binding before declaring the
deploy "production-grade."

## Deploy steps

```bash
make migrate-prod
make deploy-prod
make bootstrap-secrets-prod    # writes apps/api/.secrets.prod.env
make deploy-prod               # re-deploy with mirrored INTERNAL_HMAC_SECRET
```

## Verification

```bash
WORKER=https://textral-api.workers.dev
curl -s "$WORKER/healthz"      # 200
curl -s "$WORKER/openapi.json" | jq '.paths | length'   # > 20

# Run live e2e against prod (requires a seed tenant + BYOK):
LIVE_WORKER_URL=$WORKER LIVE_API_KEY=... OPENAI_API_KEY=... make test-live
```

Then check:

- AI Gateway dashboard shows tenant_id grouping working.
- D1 tables populated (`SELECT count(*) FROM tenants`).
- R2 bucket has the `tenant_id/.../source.{ext}` paths.
- No rows in `ingestion_jobs` with `dead_lettered=1`.

## Rollback

```bash
wrangler deployments list --env prod   # find a known-good version_id
wrangler rollback <version_id> --env prod
```

D1 migrations are append-only; rollback the Worker but **don't**
roll back the schema. If a migration introduced a bug, ship a new
migration that reverses it.

## Post-deploy

- [ ] Live e2e green for 24h continuously.
- [ ] Cost reconciliation run: `tools/billing/reconcile.ts`.
- [ ] At least one external tenant onboarded.
- [ ] Sign off `docs/SIGNOFF.md`.

## Common deploy failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `wrangler deploy` fails on Container build | corpus-profiles dir missing | `make build-ingest` first; the Makefile guard catches this |
| `INTERNAL_HMAC_SECRET` mismatch (Container says 401) | secret rotated on Worker but Container deploy stale | `make deploy-prod` again to re-mirror |
| Vectorize index width mismatch | bound a 1024-dim index where contracts expect 1536 | recreate the index with `--dimensions 1536`; re-ingest |
| KV cache returns stale tenant | API key revoked < 60 s ago | wait 60 s for TTL; documented in design §7.1 |
