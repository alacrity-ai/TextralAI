# V3 Phase 1 — Operator Quickstart

> Get the dev stack up + create a Qdrant-backed namespace + run a
> query through it. Target: ≤10 minutes from clone to a working
> response. Pairs with the V3 Phase 1 detailed design
> (`docs/v3/PHASE-1_DETAILED_DESIGN.md`) and the implementation
> guide (`docs/development/v3/PHASE_1_IMPLEMENTATION.md`).

## Prereqs

- Node 24, pnpm, Docker Compose v2.
- A Cloudflare account with the dev resources from V2 already
  provisioned (D1, R2, KV, Vectorize V2, Workers AI binding,
  Container DO + queue). The `make migrate-dev` target applies
  any new migrations including V3's `0006_namespace_vector_backend.sql`.
- An OpenAI API key (BYOK).

## 1. Boot the dev stack (~30 s)

```bash
make dev-stack
```

This starts:

- **Qdrant** at `http://localhost:6333` (HTTP REST + healthcheck).
- **ingest** Container at `http://localhost:8000` (the same image
  V2 already builds; pulls `INTERNAL_HMAC_SECRET` from
  `apps/api/.secrets.dev.env`).

Both come up healthy. Run `docker compose -f
infrastructure/docker/docker-compose.dev.yml ps` to confirm.

## 2. Boot the api Worker (separate terminal)

```bash
make dev-api-remote
```

This is a `wrangler dev --remote --env dev` — the Worker code
runs locally but the bindings (D1, R2, queues, AI) are real CF
dev resources. The Worker reaches the local Qdrant via
`http://host.docker.internal:6333`.

Set the env on your wrangler.toml dev block (or via env override):

```
QDRANT_URL = "http://host.docker.internal:6333"
```

(Already declared in `wrangler.toml`'s `[env.dev.vars]` — leave
empty when you want Qdrant disabled, set this URL when you want
the local stack reachable.)

## 3. Migrate (one-time)

```bash
make migrate-dev
```

Applies `0006_namespace_vector_backend.sql` to the remote dev D1.
Adds `vector_backend` + `vector_index_name` columns to
`namespaces` and `version_indexes`. Existing rows default to
`vectorize` so V2 namespaces keep working unchanged.

## 4. Bootstrap a tenant (or reuse an existing one)

If you don't have a dev tenant yet:

```bash
WORKER_URL=https://textral-api-dev.<your-subdomain>.workers.dev \
ADMIN_BOOTSTRAP_TOKEN=<token> \
  make seed-dev
```

Save the `tx_live_…` API key. Set:

```bash
export LIVE_WORKER_URL=https://textral-api-dev.<your-subdomain>.workers.dev
export LIVE_API_KEY=tx_live_...
```

Register your OpenAI key:

```bash
curl -X POST "$LIVE_WORKER_URL/v1/provider-keys" \
  -H "X-Textral-Api-Key: $LIVE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"provider":"openai","label":"default","key":"sk-..."}'
```

## 5. Create a Qdrant-backed namespace

```bash
curl -X POST "$LIVE_WORKER_URL/v1/namespaces" \
  -H "X-Textral-Api-Key: $LIVE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "slug": "v3-quickstart",
    "corpus_profile": "narrative",
    "default_embedding_profile": "openai-text-embedding-3-large-1536",
    "vector_backend": "qdrant",
    "vector_index_name": "v3-quickstart-passages"
  }'
```

The route handler:

1. Validates the backend + `vector_index_name` consistency.
2. Inserts the namespace row.
3. Calls `QdrantAdapter.ensureBackingExists()`, which idempotently
   `PUT`s the Qdrant collection (`v3-quickstart-passages`,
   size=1536, cosine) and creates payload indexes on
   `tenant_id` / `version_id` / `artifact_type`.

Confirm Qdrant has the collection:

```bash
curl -s http://localhost:6333/collections | jq .
```

## 6. Ingest a document (use any V2 path)

The standard upload + finalize + ingest sequence works unchanged.
The `version_indexes` row written during ingest dispatch
denormalizes `vector_backend`/`vector_index_name` from the
namespace, so the embed → upsert hot path goes straight to
Qdrant via the adapter.

## 7. Query it

```bash
curl -X POST "$LIVE_WORKER_URL/v1/query" \
  -H "X-Textral-Api-Key: $LIVE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "namespace":"v3-quickstart",
    "query":"What does the document say?",
    "embedding":{"provider":"openai","model":"text-embedding-3-large","dimensions":1536,"provider_key_ref":"default"},
    "inference":{"provider":"openai","model":"gpt-4o-mini","provider_key_ref":"default"},
    "chunking":{"profile":"generic"},
    "retrieval":{"strategy":"hybrid_rrf","top_k_dense":5,"top_k_sparse":5}
  }'
```

The response shape is identical to a Vectorize-backed namespace —
same `audit.candidates_returned`, same `audit.retrieval_status`,
same citations array. The dense arm just hit Qdrant instead of
Vectorize.

## 8. Tear down

```bash
make dev-stack-down
```

Removes the local Qdrant + ingest containers; volume `qdrantdata`
persists across runs.

## Pinecone variant

Same flow, three differences:

1. Pre-provision the index in the Pinecone console
   (dimensions=1536, cosine, region of your choice). Copy the
   host URL.
2. Set the API key:
   ```bash
   wrangler secret put PINECONE_API_KEY --env dev
   ```
3. Create the namespace:
   ```json
   {
     "vector_backend": "pinecone",
     "vector_index_name": "https://my-idx-xxxxx.svc.us-east-1-aws.pinecone.io"
   }
   ```

The adapter verifies reachability via `/describe_index_stats`
and surfaces a clean 400 if the index doesn't exist.

## Switching backends for an existing namespace

Not supported in Phase 1 — backend is locked at create time.
To migrate, create a new namespace under the new backend +
re-ingest under `mode='full'`. Documented in the **Namespaces**
tag under `/docs`.

## Troubleshooting

- **`BAD_REQUEST: qdrant backend selected but QDRANT_URL is unset`** —
  Set `QDRANT_URL` in `wrangler.toml`'s `[env.dev.vars]` and
  redeploy (or in the `--remote` Worker process env).
- **`BAD_REQUEST: vectorize backend does not accept vector_index_name`** —
  Drop the field; Vectorize binding is global.
- **`Pinecone index at ... not found`** — Provision the index in
  Pinecone first; the adapter does not auto-create.
- **Qdrant collection name collision** — Pick a different
  `vector_index_name`. Adapter rejects writes when the existing
  collection's dimensions differ from the requested ones.
