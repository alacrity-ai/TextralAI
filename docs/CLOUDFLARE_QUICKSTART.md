# Textral — Cloudflare Quickstart

5-minute path from clone to a working query against a deployed
Cloudflare dev environment. If a step takes longer than its budget,
the docs are wrong — file an issue.

> **Picking a path?** This guide covers the **Cloudflare-managed**
> deploy (Workers + D1 + R2 + Vectorize). For the self-hostable
> docker-compose deploy (Postgres + Redis + MinIO + Qdrant), see
> [`SELF_HOSTING.md`](./SELF_HOSTING.md). The runtime decision
> doesn't affect the API contract — same routes, same OpenAPI, same
> audit shape.

## Prereqs

- Node 24 + pnpm 10
- Python 3.12+ (for the Container's tests; not needed to use the API)
- `wrangler` (`pnpm add -g wrangler` or use the workspace-pinned one)
- A Cloudflare account with: D1, R2, KV, Vectorize V2, Workers, AI
  Gateway, Containers all enabled
- An OpenAI API key (for embedding + synthesis BYOK)

## 1. Clone + install (1 min)

```bash
git clone <repo-url> textral
cd textral
make install
```

## 2. Configure secrets (1 min)

```bash
cp .env.example .env
$EDITOR .env             # set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
```

## 3. Migrate + deploy dev (1.5 min)

```bash
make migrate-dev
make deploy-dev
make bootstrap-secrets-dev      # generates 4 worker secrets, writes .secrets.dev.env
make deploy-dev                 # re-deploy to mirror INTERNAL_HMAC_SECRET into the Container
```

## 4. Seed a tenant + API key (30 sec)

```bash
set -a; . apps/api/.secrets.dev.env; set +a
WORKER_URL=https://<your-worker>.workers.dev make seed-dev
# Save the printed API key — only shown once.
```

## 5. Register a BYOK provider key + run a query (1 min)

```bash
export LIVE_WORKER_URL=https://<your-worker>.workers.dev
export LIVE_API_KEY=<from previous step>
export OPENAI_API_KEY=sk-...

# Register the OpenAI key under label "default":
curl -X POST "$LIVE_WORKER_URL/v1/provider-keys" \
  -H "x-textral-api-key: $LIVE_API_KEY" \
  -H 'content-type: application/json' \
  -d "{\"provider\":\"openai\",\"label\":\"default\",\"api_key\":\"$OPENAI_API_KEY\"}"

# Run the live e2e (registers narrative namespace, ingests fixture,
# queries it):
make test-live
```

If the e2e prints `OK` for every step, you're done. The system is
working: you uploaded a document, it ingested through the Container,
chunks are in D1 + Vectorize, and a synthesized answer with
citations came back.

## Next steps

- **Browse the docs:** open `https://<your-worker>.workers.dev/docs`
  for the auto-generated API reference (Scalar UI).
- **Try streaming:** `POST /v1/query?stream=sse` returns Server-Sent
  Events. See `docs/API.md`.
- **Add an eval set:** `tsx packages/eval-cli/src/index.ts eval ls`
  (after configuring `~/.textralrc`).
- **Read the design:** `docs/1-DESIGN.md` is the architecture canon.

## Troubleshooting

- **`/v1/query` returns 404 NAMESPACE_NOT_FOUND:** the namespace must
  exist before query. Use `POST /v1/namespaces` or run
  `make test-live` which seeds one.
- **`PROVIDER_KEY_NOT_FOUND`:** the `provider_key_ref` in the request
  doesn't match a registered BYOK label. List with
  `GET /v1/provider-keys`.
- **`EMBEDDING_PROFILE_MISMATCH`:** the query's embedding profile
  doesn't match what the namespace was indexed with. Re-ingest, or
  query with the matching `embedding.model`.
- **Migration fails on `0005_eval.sql`:** check that prior migrations
  applied (`wrangler d1 migrations list textral-dev`).
