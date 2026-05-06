// scripts/seed-self-host.ts — bootstrap a tenant + namespace + API
// key against a running self-host stack.
//
// Mirror of `seed-dev.ts` (which targets the deployed CF Worker)
// but defaults to the local self-host endpoint and uses self-host-
// flavored display names so the data is identifiable.
//
// Usage (from the host, against `make selfhost-up`):
//
//   ADMIN_BOOTSTRAP_TOKEN=<token> \
//     pnpm --filter @textral/api exec tsx scripts/seed-self-host.ts
//
// Or from inside the running api container (the bundled form is
// what the design-doc Step-26 runbook calls):
//
//   docker compose -f infrastructure/docker/docker-compose.yml exec api \
//     node dist/scripts/seed-self-host.mjs
//
// Token: read from `.env.selfhost`. The api container surfaces it as
// `ADMIN_BOOTSTRAP_TOKEN` env, so `process.env.ADMIN_BOOTSTRAP_TOKEN`
// works both from the host and from inside the container.
//
// Idempotent: same display_name + namespace_slug returns the same
// IDs but always issues a NEW api key (rotation by re-seed). Save
// the printed `api_key.raw` — it's never shown again.
//
// Default vector backend is `qdrant` since self-host has no
// Vectorize. Override via `NAMESPACE_VECTOR_BACKEND=pinecone` if
// the operator wired Pinecone via `PINECONE_API_KEY`.

const TOKEN = process.env.ADMIN_BOOTSTRAP_TOKEN;
const URL_BASE = process.env.WORKER_URL ?? 'http://localhost:8787';
if (!TOKEN) {
  console.error(
    'ADMIN_BOOTSTRAP_TOKEN env var is required. Read it from .env.selfhost.',
  );
  process.exit(1);
}

const body: Record<string, unknown> = {
  tenant_display_name: 'Self-Host Tenant',
  namespace_slug: 'default',
  namespace_corpus_profile: 'generic',
  namespace_default_embedding_profile: 'openai-text-embedding-3-large',
  api_key_scopes: ['*'],
};
// Optional overrides — when unset the bootstrap endpoint picks the
// runtime default ('qdrant' on self-host, 'vectorize' on CF).
if (process.env.NAMESPACE_VECTOR_BACKEND) {
  body.namespace_vector_backend = process.env.NAMESPACE_VECTOR_BACKEND;
}
if (process.env.NAMESPACE_VECTOR_INDEX_NAME) {
  body.namespace_vector_index_name = process.env.NAMESPACE_VECTOR_INDEX_NAME;
}

const res = await fetch(`${URL_BASE}/v1/admin/bootstrap`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-admin-bootstrap-token': TOKEN,
  },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error('seed-self-host failed:', res.status, await res.text());
  process.exit(1);
}

const out = (await res.json()) as {
  tenant: { id: string; display_name: string };
  namespace: { id: string; slug: string };
  api_key: { id: string; raw: string; prefix: string };
};

console.log(JSON.stringify(out, null, 2));
console.error('');
console.error('Save the api_key.raw value — it will never be shown again.');
console.error('');
console.error(
  '  export SELFHOST_API_KEY=' + out.api_key.raw + '\n' +
    '  make selfhost-validate',
);
