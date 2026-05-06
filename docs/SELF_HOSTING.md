# Self-Hosting Textral

V3 Phase 2 ships a self-hostable build of `@textral/api` alongside the
managed Cloudflare deploy. The same Hono app, the same routes, the
same OpenAPI surface — different bindings underneath: Postgres for D1,
Redis for KV/Queue, MinIO (or any S3-compatible store) for R2, and
either Qdrant or Pinecone for vectors.

This is the operator runbook. If you're a developer working on the
codebase, read `docs/v3/PHASE-2_DETAILED_DESIGN.md` instead.

## 1. Prerequisites

| Thing                    | Required version |
|--------------------------|-----------------|
| Docker Engine            | 24.0+ (with Compose v2) |
| Free RAM                 | 4 GB (8 GB recommended) |
| Free disk                | 10 GB on the docker volume root |
| Outbound network         | OpenAI / Anthropic / Cohere / Voyage as needed |

A recent Linux/macOS host running Docker Desktop or a native Docker
daemon. Compose v2 ships inside Docker Desktop and modern Docker
Engine.

The repo is the build context — clone it locally; the api Dockerfile
and the ingest Dockerfile both read source from the workspace. No
prebuilt images are published yet.

```bash
git clone https://github.com/<your-fork>/textral.git
cd textral
```

## 2. Quickstart

End-to-end in roughly ten minutes on a clean machine.

### 2.1 Provision secrets

The four required secrets are HMAC, salt, pepper, and the bootstrap
token. Generate fresh values:

```bash
cp .env.selfhost.example .env.selfhost

# Generate secrets
INTERNAL_HMAC_SECRET=$(openssl rand -hex 32)
ADMIN_BOOTSTRAP_TOKEN=$(openssl rand -hex 32)
API_KEY_PEPPER=$(openssl rand -hex 32)
AUDIT_HASH_SALT=$(openssl rand -hex 16)

# Append to .env.selfhost
cat >> .env.selfhost <<EOF
INTERNAL_HMAC_SECRET=$INTERNAL_HMAC_SECRET
ADMIN_BOOTSTRAP_TOKEN=$ADMIN_BOOTSTRAP_TOKEN
API_KEY_PEPPER=$API_KEY_PEPPER
AUDIT_HASH_SALT=$AUDIT_HASH_SALT
EOF
chmod 600 .env.selfhost
```

The example file already wires `POSTGRES_*` / `REDIS_URL` / `MINIO_*`
to the compose service hostnames; you don't need to touch those for
the default single-host stack.

### 2.2 Bring up the stack

```bash
make selfhost-up
```

Compose pulls postgres:16, redis:7, qdrant/qdrant, minio/minio, and
builds two images locally (api + ingest). On a 4-core / 8 GB box this
takes 60–90s the first time (image pulls dominate); 5–10s
on subsequent restarts.

When `up --wait` returns clean, all six services are healthy. If one
isn't, see §10 Troubleshooting.

### 2.3 Apply Postgres migrations

The api container starts with a healthy Postgres but doesn't migrate
on boot. Apply the migration tree once:

```bash
make migrate-postgres-selfhost
```

This runs `node dist/scripts/migrate-postgres.mjs` inside a one-shot
api container against the same `.env.selfhost`. Idempotent — re-runs
no-op once everything is applied.

### 2.4 Verify health + bootstrap a tenant

```bash
curl http://localhost:8787/healthz
# {"ok":true,"runtime":"node","env":"self-host"}

# Bootstrap creates a tenant, namespace, and the first API key in one shot.
ADMIN_BOOTSTRAP_TOKEN=$(grep ADMIN_BOOTSTRAP_TOKEN .env.selfhost | cut -d= -f2) \
  pnpm --filter @textral/api exec tsx scripts/seed-self-host.ts
```

Save the printed `api_key.raw` value — it's the only time it's
displayed. Export it and run the cookbook validator:

```bash
export SELFHOST_API_KEY=<printed-value>
make selfhost-validate
```

All eight cookbook patterns should pass with the same audit shape
as the Cloudflare deploy (see §11 Parity).

### 2.5 Open the sandbox UI

`make selfhost-up` brings up the sandbox alongside the api at
**http://localhost:5173**. It's a Vite + React 19 + TypeScript single-
page app whose only job is to make every audit field, retrieval
candidate, citation decision, and provider call directly visible and
trivially comparable.

```bash
# In your browser:
open http://localhost:5173

# First-load gate: paste the API key from § 2.4 above (the value
# printed by seed-self-host.ts or seed-cookbook-self-host.ts).
# The key is stored in localStorage on this machine only.
```

What you get from the sandbox without leaving the browser:

| Page | What it does |
|------|---------------------------------------------------------------|
| Query Bench | Form covering every `/v1/query` field; answer + citations + audit drawer + retrieval candidates table. Submit with ⌘↵. |
| Compare | Two QueryBench panels side-by-side. Citations diff inline; per-metric Δ surfaces. The "is this change actually better?" answer. |
| Ingest | Drag-drop file → register → upload → finalize → ingest → live stage stream. |
| History | Last 100 query_events; click a row to replay on the bench. |
| Provider Keys | Register / test / revoke per-provider keys (BYOK). |
| Namespaces | List + create. Backend choice is locked at create time. |
| Documents | Look up a doc by id, browse its chunks, re-ingest with a tweaked profile. |
| Admin | DLQ + retry buttons; per-namespace enrichment runs. |

Hit `⌘K` from anywhere to open the command palette; `?` for the
keyboard cheatsheet. Audit drawers are `⌘A`. `/docs` (Scalar) is
linked from the help overlay for any spec lookup.

### 2.6 Add Textral to your agent (MCP)

Self-host mounts an MCP server in-process at `POST /v1/mcp` (Node
runtime only in Phase 1). Agents — Claude Code, Cursor, Windsurf,
Cline, internal orchestrators — can drive Textral via 16 named tools
without parsing OpenAPI.

```bash
# Local Claude Code, stdio:
claude mcp add textral \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=$SELFHOST_API_KEY \
  -- npx @textral/mcp

# Production embed (any MCP client):
{
  "mcpServers": {
    "textral": {
      "url": "https://api.textral.example.com/v1/mcp",
      "headers": { "X-Textral-Api-Key": "tx_live_…" }
    }
  }
}
```

Auth, redaction, and audit are end-to-end identical to REST: the MCP
server is a thin adapter. Tool invocations land in `mcp_tool_calls`,
inspectable via the Sandbox **Admin → MCP** tab. Full surface,
options, and troubleshooting in
[`docs/mcp/QUICKSTART.md`](./mcp/QUICKSTART.md).

```bash
# Confirm the embedded transport works against your local stack:
export SELFHOST_API_KEY=tx_live_…
make mcp-validate
```

## 3. Configuration reference

Every variable in `.env.selfhost.example`. Required-first.

| Var | What it does | Default |
|---|---|---|
| `POSTGRES_HOST/_PORT/_USER/_PASSWORD/_DB` | Postgres connection | `postgres / 5432 / textral / textral_dev / textral` |
| `POSTGRES_URL` | Alternative single-string form (overrides the split vars) | _unset_ |
| `POSTGRES_MAX_CONNECTIONS` | Pool max | `10` |
| `REDIS_URL` | Redis URL (queue + KV-cache) | `redis://redis:6379` |
| `MINIO_ENDPOINT` | S3-compatible blob endpoint | `http://minio:9000` |
| `MINIO_ROOT_USER/_PASSWORD` | S3 credentials | `textral / textral_dev` |
| `MINIO_BUCKET` | Source-of-truth bucket | `textral-blobs` |
| `S3_REGION` | SDK region (cosmetic for MinIO) | `us-east-1` |
| `QDRANT_URL` | Qdrant base URL | `http://qdrant:6333` |
| `QDRANT_API_KEY` | Qdrant Cloud API key | _unset (no auth on local)_ |
| `PINECONE_API_KEY` | Required iff a namespace picks `pinecone` | _unset_ |
| `CONTAINER_HOST` | Hostname of the Python ingest container | `ingest` |
| `CONTAINER_PORT` | Port for `/jobs/run` | `8000` |
| `WORKER_INTERNAL_URL` | URL the ingest container POSTs back to (D1/R2 callbacks) | `http://api:8787` |
| `INTERNAL_HMAC_SECRET` | HMAC for ingest → api callbacks | **REQUIRED** |
| `ADMIN_BOOTSTRAP_TOKEN` | Token for `/v1/admin/bootstrap` | **REQUIRED** |
| `API_KEY_PEPPER` | Server-side pepper for hashing customer API keys | **REQUIRED** |
| `AUDIT_HASH_SALT` | Tenant-salt for query_events.request_config_hash | **REQUIRED** |
| `AI_GATEWAY_BASE_URL` | LiteLLM / Helicone / etc. base URL — leave blank to call providers direct | _unset_ |
| `PORT` | api listen port | `8787` |
| `ENABLE_DEBUG_ROUTES` | `"true"` enables `/dev/*` + `/__redaction_check` | `false` |
| `NODE_ENV` | Set to `production` in the runtime image | _set by Dockerfile_ |

## 4. Vector backend choice

Each namespace picks a vector backend at create time. Self-host has
two viable choices:

### 4.1 Qdrant (default)

Local Qdrant is brought up as part of the compose stack. Zero extra
config — `seed-self-host.ts` defaults to it.

For Qdrant Cloud (managed), set:
```
QDRANT_URL=https://<your-cluster>.qdrant.io
QDRANT_API_KEY=<key>
```
…and **comment out** the `qdrant:` service block in
`infrastructure/docker/docker-compose.yml` so you don't run a local
copy you'll never use.

### 4.2 Pinecone

Set `PINECONE_API_KEY` and create namespaces with
`namespace_vector_backend=pinecone` and
`namespace_vector_index_name=https://<your-index>.svc.<region>.pinecone.io`.

Pinecone is per-namespace — different namespaces in the same tenant
can be Pinecone or Qdrant independently.

**Multi-tenancy via native Pinecone namespaces.** A Textral namespace
maps to a *Pinecone native namespace* inside the operator-provisioned
index, not to the index itself. This is the canonical Pinecone
multi-tenancy pattern: many Textral namespaces share one Pinecone
index, isolated by the `namespace` field on every Pinecone REST call.
Result: one operator-provisioned index, low cost, per-namespace
isolation, O(1) `delete-by-namespace` cleanup.

Pass `vector_namespace` on `POST /v1/namespaces` to pick the Pinecone
namespace name. Omit it and Textral defaults to the Textral slug.
Two Textral namespaces sharing the same Pinecone index + Pinecone
namespace name are rejected at create time (would silently corrupt
each other). The field is locked at create time alongside
`vector_backend` and `vector_index_name`.

```bash
# Two Textral namespaces, one Pinecone index, isolated by namespace.
POST /v1/namespaces
  { "slug": "lighthouse-tales",
    "vector_backend": "pinecone",
    "vector_index_name": "https://textral-index-xxx.svc.aped-4627-b74a.pinecone.io",
    "vector_namespace": "lighthouse-tales" }

POST /v1/namespaces
  { "slug": "support-kb",
    "vector_backend": "pinecone",
    "vector_index_name": "https://textral-index-xxx.svc.aped-4627-b74a.pinecone.io",
    "vector_namespace": "support-kb" }
```

The `tenant_id` metadata filter is preserved as defense in depth —
even if a misconfiguration sent two Textral tenants to the same
Pinecone namespace, the filter still isolates them. The Pinecone
namespace becomes the *primary* boundary; the metadata filter is
*secondary*.

### 4.3 Vectorize

Vectorize is a Cloudflare-native binding. **Self-host deploys reject
`vector_backend=vectorize` at namespace-create time** (`BAD_REQUEST`
with a clear error). Migrate Vectorize-backed namespaces to Qdrant
or Pinecone before moving off Cloudflare.

## 5. AI Gateway proxy (optional)

Cloudflare AI Gateway is a CF-only product. To get equivalent
observability + caching on self-host, point a self-hosted proxy at
the upstream providers:

- [LiteLLM Proxy](https://github.com/BerriAI/litellm) — drop-in
  OpenAI-compatible proxy with caching and tag-based logging.
- [Helicone](https://helicone.ai) — managed observability with a
  self-hosted variant.

Set:
```
AI_GATEWAY_BASE_URL=http://litellm:4000
```
and add the proxy as a sidecar service in your compose. Textral
sends `x-aig-*` metadata headers; the proxy can match Cloudflare's
`cf-aig-*` tag-based reporting if you configure mappings on your end.

Leave unset to call upstream providers (OpenAI / Anthropic / Cohere /
Voyage) directly.

## 6. TLS termination

Compose ships HTTP-only on the api service. Put a reverse proxy
in front for TLS — example Caddyfile:

```caddy
api.textral.example.com {
    reverse_proxy localhost:8787
}
```

Caddy auto-provisions Let's Encrypt certs. For Traefik or nginx,
the same shape — proxy `:443 → :8787` with whatever cert source
you prefer.

Bind the api service to `127.0.0.1:8787` (instead of `0.0.0.0:8787`)
in compose if your reverse proxy lives on the same host:

```yaml
api:
  ports: ["127.0.0.1:8787:8787"]
```

## 7. Backups

### 7.1 Postgres

```bash
docker compose -f infrastructure/docker/docker-compose.yml exec -T postgres \
  pg_dump -U textral textral | gzip > textral-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
```

Runs nightly in cron is the typical setup. Restore:

```bash
gunzip -c textral-<ts>.sql.gz | \
  docker compose -f infrastructure/docker/docker-compose.yml exec -T postgres \
    psql -U textral textral
```

### 7.2 MinIO (blobs)

```bash
docker run --rm --network host \
  -v $(pwd)/minio-backup:/backup \
  minio/mc:latest \
  alias set local http://localhost:9000 textral textral_dev
docker run --rm --network host \
  -v $(pwd)/minio-backup:/backup \
  minio/mc:latest \
  mirror local/textral-blobs /backup/textral-blobs
```

For incremental backups, use `mc mirror --watch` or pair MinIO with
S3 cross-region replication.

### 7.3 Qdrant

Qdrant has a built-in snapshot API:

```bash
curl -X POST http://localhost:6333/collections/<collection>/snapshots
# returns { result: { name: "<name>" } }
docker compose -f infrastructure/docker/docker-compose.yml exec qdrant \
  cat /qdrant/snapshots/<collection>/<name> > <collection>-<ts>.snapshot
```

### 7.4 Redis

Redis here is queue + cache only — no source-of-truth data lives in
it. Routine backups are unnecessary; treat Redis as ephemeral.

## 8. Upgrades

```bash
git pull
docker compose -f infrastructure/docker/docker-compose.yml build api ingest-worker ingest
docker compose -f infrastructure/docker/docker-compose.yml up -d --wait

# Apply any new migrations
make migrate-postgres-selfhost
```

The migrate runner is idempotent — applies new files since last run,
no-ops if everything is up-to-date.

For a zero-downtime upgrade, use compose's rolling-restart pattern
or wire the api container behind a reverse proxy that supports
draining (Caddy `lb_try_duration`, Traefik weighted services).

## 9. Migration from Cloudflare V2

Manual runbook. A one-button migration tool is post-Phase-2.

### 9.1 Postgres bootstrap

Bring the self-host stack up empty (steps 2.1 – 2.3 above), then
import the V2 D1 dump:

```bash
# On the dev machine — export D1 to SQL
cd apps/api
npx wrangler d1 export textral-prod --remote --output v2.sql

# Translate SQLite-isms → Postgres
sed -i 's/AUTOINCREMENT/serial/g; s/INTEGER PRIMARY KEY/SERIAL PRIMARY KEY/g' v2.sql

# Apply
docker compose -f infrastructure/docker/docker-compose.yml exec -T postgres \
  psql -U textral textral < v2.sql
```

You'll likely hit a few SQLite-specific functions (`IFNULL`,
`STRFTIME`) the sed doesn't catch — fix in-place. The migration
tree's column types match the V3 design, so the data shape lines up.

### 9.2 R2 → MinIO

Use the AWS S3-compatible mc client:

```bash
# Cloudflare R2 has an S3-compatible endpoint
mc alias set cf-r2 https://<account>.r2.cloudflarestorage.com \
  <r2-access-key> <r2-secret-key>
mc alias set local http://localhost:9000 textral textral_dev

# Mirror everything
mc mirror cf-r2/textral-blobs local/textral-blobs
```

### 9.3 Vectorize → Qdrant (re-embed)

There's no Vectorize → Qdrant data export. Re-embed under
`mode='embed_only'`:

```bash
# Per-document re-ingest; the Container's embed_only mode skips
# extraction and just writes new embeddings to the namespace's
# new (Qdrant) backing collection.
curl -X POST $SELFHOST_URL/v1/documents/$DOC_ID/ingest \
  -H "X-Textral-Api-Key: $SELFHOST_API_KEY" \
  -H "content-type: application/json" \
  -d '{"mode":"embed_only"}'
```

Tenants who want to skip re-embedding can run their existing
embeddings through the Qdrant adapter directly — small helper
script available on request.

### 9.4 DNS cutover

Change your tenant's `api.textral.example.com` (or whatever) DNS
record to point at the self-host's reverse proxy. API contract is
identical; client code needs no changes.

## 10. Troubleshooting

| Symptom | Likely cause | Diagnostic |
|---|---|---|
| `api` healthcheck never goes green | Postgres migrations not applied | `make migrate-postgres-selfhost`, then `docker compose restart api` |
| `/healthz` 500s with `API_KEY_PEPPER not configured` | `.env.selfhost` missing the secret | Check the file; `chmod 600` if you regenerated |
| Cookbook validator: `Vectorize backend unavailable` | Bootstrap didn't override the default | Pass `NAMESPACE_VECTOR_BACKEND=qdrant` to seed-self-host (default behavior in V3 — older configs may need manual update) |
| `ingest` container can't reach `api` | `WORKER_INTERNAL_URL` wrong | Should be `http://api:8787` inside the compose network |
| Slow first ingestion (~30s) | Cold Qdrant collection creation | Normal; subsequent jobs are fast |
| `ingest-worker` keeps restarting | api isn't healthy yet | `docker compose logs api` — it waits on a healthy api |
| MinIO startup fails on Apple Silicon | linux/arm64 image variant | Add `platform: linux/arm64` under the `minio:` service |

For deeper issues, set `ENABLE_DEBUG_ROUTES=true` in `.env.selfhost`
and probe `/dev/ingest-ping` (CF-only) — the equivalent on self-host
is `docker compose logs ingest-worker --tail=50`.

## 11. Parity with the managed Cloudflare deploy

The cookbook validator (`apps/api/scripts/validate-cookbook.ts`)
runs the same eight patterns against either deploy. Audit shape is
the parity proof: `audit.tokens.*`, `audit.degradation_level`,
`audit.reranker.executed`, `audit.synthesis_model_id` — all present
and identical-shape on both runtimes.

The two surfaces that intentionally diverge:

1. **Workers AI no-key tier** — Cloudflare provides a default OpenAI
   embedding model with no customer key required. Self-host has no
   equivalent; bring your own OpenAI / Cohere / Voyage key, or wire
   LiteLLM with a deploy-side default.
2. **Vectorize backend** — Cloudflare-only. Self-host namespaces use
   Qdrant or Pinecone (see §4 above).

Everything else — chunking, embedding, retrieval, hybrid scoring,
synthesis, citations, audit logging, rate limits, eval — is bit-
exact byte-for-byte identical between runtimes. CI's
`cf × node × {unit, integration}` matrix enforces it.
