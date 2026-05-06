// scripts/seed-cookbook-self-host.ts — provision the per-backend
// cookbook namespace + the narrative-tiny fixture inside a running
// self-host stack, so the cookbook validator
// (`scripts/validate-cookbook.ts`) has somewhere to query against.
//
// What it does, end-to-end:
//   1. Bootstrap "Self-Host Tenant" + `cookbook-qdrant` namespace
//      (qdrant-backed, collection `cookbook-qdrant-passages`,
//      narrative corpus profile) + a fresh `*`-scoped API key.
//      Idempotent on tenant + namespace; always issues a new key.
//   2. Register the operator's OpenAI key under label `default`.
//      The cookbook patterns reference `provider_key_ref: 'default'`
//      so this label is required.
//   3. Register a document, upload narrative-tiny.md, finalize it.
//   4. Trigger ingestion (`mode='full'`) against
//      `text-embedding-3-large` (1536 dims).
//   5. Poll the ingestion job until it reports `completed`.
//   6. Print the API key + the `make selfhost-validate` command line
//      so the operator can run the cookbook validator immediately.
//
// Usage (from the host, against `make selfhost-up`):
//
//   ADMIN_BOOTSTRAP_TOKEN=<token from .env.selfhost> \
//   OPENAI_API_KEY=sk-... \
//     pnpm --filter @textral/api exec tsx scripts/seed-cookbook-self-host.ts
//
// Mirror of `seed-self-host.ts` but goes further — that script just
// mints the tenant/namespace/key; this one carries it through to a
// queryable ingested fixture. Required because self-host has no
// equivalent of the Phase-1 manual one-time setup that the cookbook
// validator originally depended on.
//
// Re-running: idempotent on the namespace itself (bootstrap returns
// the existing one), but each run inserts another document version
// + ingestion job — kept simple over de-duplicating, since cookbook
// fixtures are tiny and the duplicate version adds no signal.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const TOKEN = process.env.ADMIN_BOOTSTRAP_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const URL_BASE = process.env.WORKER_URL ?? 'http://localhost:8787';

if (!TOKEN || !OPENAI_KEY) {
  console.error(
    'Both ADMIN_BOOTSTRAP_TOKEN and OPENAI_API_KEY are required.',
  );
  console.error(
    '  ADMIN_BOOTSTRAP_TOKEN: read from .env.selfhost',
  );
  console.error(
    '  OPENAI_API_KEY: your OpenAI key (used for embeddings + synthesis)',
  );
  process.exit(1);
}

// ── shapes (mirror test-live.ts) ─────────────────────────────────
interface BootstrapResponse {
  tenant: { id: string; display_name: string };
  namespace: { id: string; slug: string };
  api_key: { id: string; raw: string; prefix: string };
}
interface ProviderKeyResponse {
  id: string;
  provider: string;
  label: string;
}
interface DocumentResponse {
  id: string;
}
interface UploadResponse {
  upload_id: string;
  url: string;
  key: string;
  expires_at: number;
}
interface FinalizeResponse {
  version_id: string;
  content_hash: string;
  source_r2_key: string;
  size_bytes: number;
  content_type: string;
  deduplicated: boolean;
}
interface IngestionJobResponse {
  id: string;
  status: 'pending' | 'running' | 'retrying' | 'completed' | 'failed';
  error_code: string | null;
  error_message: string | null;
  current_stage: string | null;
}

const NAMESPACE_SLUG = 'cookbook-qdrant';
const NAMESPACE_INDEX_NAME = 'cookbook-qdrant-passages';
const PROVIDER_KEY_LABEL = 'default';
const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'narrative-tiny.md',
);

let API_KEY = '';

async function adminPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-bootstrap-token': TOKEN!,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      'x-textral-api-key': API_KEY,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${URL_BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function pollJobUntilDone(
  jobId: string,
  timeoutMs = 240_000,
): Promise<IngestionJobResponse> {
  const start = Date.now();
  let last: IngestionJobResponse | undefined;
  while (Date.now() - start < timeoutMs) {
    const r = await api<IngestionJobResponse>(
      'GET',
      `/v1/ingestion-jobs/${jobId}`,
    );
    last = r;
    process.stdout.write(
      `  job.status=${r.status}/stage=${r.current_stage ?? '-'}\n`,
    );
    if (r.status === 'completed') return r;
    if (r.status === 'failed') {
      throw new Error(
        `Ingestion failed: ${r.error_code ?? 'UNKNOWN'} — ${r.error_message ?? ''} (stage: ${r.current_stage ?? '?'})`,
      );
    }
    await new Promise((rs) => setTimeout(rs, 3_000));
  }
  throw new Error(
    `Ingestion did not complete within ${timeoutMs}ms (last status: ${last?.status ?? '?'}/stage: ${last?.current_stage ?? '?'})`,
  );
}

async function main(): Promise<void> {
  console.log(`Cookbook seed against ${URL_BASE}`);

  // 1. Bootstrap tenant + cookbook-qdrant namespace + key.
  console.log('1. Bootstrap tenant + cookbook-qdrant namespace');
  const bootstrap = await adminPost<BootstrapResponse>(
    '/v1/admin/bootstrap',
    {
      tenant_display_name: 'Self-Host Tenant',
      namespace_slug: NAMESPACE_SLUG,
      namespace_corpus_profile: 'generic',
      namespace_default_embedding_profile: 'openai-text-embedding-3-large',
      namespace_vector_backend: 'qdrant',
      namespace_vector_index_name: NAMESPACE_INDEX_NAME,
      api_key_scopes: ['*'],
    },
  );
  API_KEY = bootstrap.api_key.raw;
  console.log(`   namespace=${bootstrap.namespace.slug} (id=${bootstrap.namespace.id})`);
  console.log(`   tenant=${bootstrap.tenant.id}`);
  console.log(`   api_key.prefix=${bootstrap.api_key.prefix}`);

  // 2. Register OpenAI BYOK key. Idempotent: re-runs find the
  //    existing key by (provider, label) and skip the POST so the
  //    operator can re-seed without manual cleanup. The provider
  //    keys list is tenant-scoped via the api key we just minted.
  console.log('2. Register OpenAI BYOK key');
  const existing = await api<{ data: ProviderKeyResponse[] }>(
    'GET',
    '/v1/provider-keys',
  );
  const already = existing.data.find(
    (k) => k.provider === 'openai' && k.label === PROVIDER_KEY_LABEL,
  );
  if (already) {
    console.log(
      `   provider_key.label=${already.label} (already registered, skipping)`,
    );
  } else {
    const pkey = await api<ProviderKeyResponse>('POST', '/v1/provider-keys', {
      provider: 'openai',
      label: PROVIDER_KEY_LABEL,
      key: OPENAI_KEY,
    });
    console.log(`   provider_key.label=${pkey.label}`);
  }

  // 3. Create document → upload → finalize.
  console.log('3. Create document');
  const fixture = readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = await api<DocumentResponse>(
    'POST',
    `/v1/namespaces/${NAMESPACE_SLUG}/documents`,
    {
      title: 'Narrative-tiny — cookbook fixture',
      doc_type: 'passage',
    },
  );
  console.log(`   doc=${doc.id}`);

  console.log('4. Presign + upload + finalize');
  const upload = await api<UploadResponse>(
    'POST',
    `/v1/documents/${doc.id}/uploads`,
    { content_type: 'text/markdown', size_bytes: fixture.length },
  );
  // Worker-proxied upload — the URL points back at the api with a
  // header-auth requirement.
  const putHeaders: Record<string, string> = { 'content-type': 'text/markdown' };
  if (upload.url.startsWith(URL_BASE)) putHeaders['x-textral-api-key'] = API_KEY;
  const putRes = await fetch(upload.url, {
    method: 'PUT',
    headers: putHeaders,
    body: fixture,
  });
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`upload PUT failed: ${putRes.status} ${body}`);
  }
  console.log(`   upload PUT=${putRes.status}`);
  const finalize = await api<FinalizeResponse>(
    'POST',
    `/v1/documents/${doc.id}/uploads/${upload.upload_id}/finalize`,
    {},
  );
  console.log(
    `   version=${finalize.version_id} size=${finalize.size_bytes} dedup=${finalize.deduplicated}`,
  );

  // 4. Ingest.
  console.log('5. Trigger ingestion');
  const ingest = await api<{ job_id: string; version_id: string }>(
    'POST',
    `/v1/documents/${doc.id}/ingest`,
    {
      version_id: finalize.version_id,
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 1536,
        provider_key_ref: PROVIDER_KEY_LABEL,
      },
      chunking: { profile: 'generic', target_tokens: 200, overlap_tokens: 30 },
      mode: 'full',
    },
  );
  console.log(`   job=${ingest.job_id}`);

  // 5. Poll job to completion.
  console.log('6. Poll job → ingest container processes via Redis queue');
  const job = await pollJobUntilDone(ingest.job_id, 240_000);
  console.log(`   job.status=${job.status}`);

  // 6. Print the API key + next-step.
  console.log('');
  console.log('Cookbook namespace seeded. Next:');
  console.log('');
  console.log(`  export SELFHOST_API_KEY=${API_KEY}`);
  console.log('  make selfhost-validate');
  console.log('');
  console.log(
    '(SELFHOST_API_KEY is *only printed here* — save it now. The bootstrap',
  );
  console.log(
    ' endpoint never re-emits raw key bodies; running this script again issues',
  );
  console.log(' a fresh key, but the previous one stays valid until revoked.)');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});
