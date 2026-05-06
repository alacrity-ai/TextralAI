// scripts/seed-dev.ts — bootstrap a dev tenant + namespace + API key.
//
// Usage:
//   ADMIN_BOOTSTRAP_TOKEN=<token> WORKER_URL=https://textral-api-dev.<sub>.workers.dev \
//     node --import tsx scripts/seed-dev.ts
//
// Or via the Makefile:
//   ADMIN_BOOTSTRAP_TOKEN=<token> WORKER_URL=https://... make seed-dev
//
// Idempotent: re-running with the same display_name returns the same
// tenant + namespace IDs but always issues a NEW API key (the old one
// stays valid until you revoke it).

const TOKEN = process.env.ADMIN_BOOTSTRAP_TOKEN;
const URL_BASE = process.env.WORKER_URL ?? 'http://localhost:8787';

if (!TOKEN) {
  console.error('ADMIN_BOOTSTRAP_TOKEN env var is required');
  process.exit(1);
}

const body = {
  tenant_display_name: 'Dev Tenant',
  namespace_slug: 'default',
  namespace_corpus_profile: 'generic',
  namespace_default_embedding_profile: 'openai-text-embedding-3-large',
  api_key_scopes: ['*'],
};

const res = await fetch(`${URL_BASE}/v1/admin/bootstrap`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-admin-bootstrap-token': TOKEN,
  },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error('seed failed:', res.status, await res.text());
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
