// scripts/test-live-phase5.ts — Phase 5 live e2e against deployed Worker.
//
// Demonstrates:
//   * profile-driven retrieval defaults (narrative profile auto-includes
//     `narrative.*` artifact types in retrieval.artifact_types)
//   * reranker fallback to RRF top-K when no Voyage key is registered
//     (audit.reranker.executed=false, fallback_reason=PROVIDER_KEY_NOT_FOUND,
//      actionable=true)
//
// Run after `make deploy-dev` + `make migrate-dev`. The narrative
// namespace must already exist (the smoke check below creates it
// idempotently).
//
// What it does NOT yet demonstrate (deferred to Phase 6 follow-up):
//   * the `enrich` stage running in the Container — the runner is
//     tested in unit tests, but it depends on /internal/providers/chat
//     which Phase 6 ships.
//
// Required env: LIVE_WORKER_URL, LIVE_API_KEY, OPENAI_API_KEY.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WORKER_URL = (process.env.LIVE_WORKER_URL ?? '').replace(/\/$/, '');
const API_KEY = process.env.LIVE_API_KEY ?? '';
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';

if (!WORKER_URL || !API_KEY || !OPENAI_KEY) {
  console.error('Missing one of: LIVE_WORKER_URL, LIVE_API_KEY, OPENAI_API_KEY');
  process.exit(1);
}

interface ProviderKeyResponse {
  id: string;
  provider: string;
  label: string;
}
interface UploadResponse {
  upload_id: string;
  url: string;
  key: string;
  expires_at: number;
}
interface FinalizeResponse {
  version_id: string;
  size_bytes: number;
}
interface DocumentResponse {
  id: string;
}
interface IngestionJobResponse {
  id: string;
  status: 'pending' | 'running' | 'retrying' | 'completed' | 'failed';
  error_code: string | null;
  error_message: string | null;
  current_stage: string | null;
}
interface QueryResponse {
  query_event_id: string;
  answer: { mode: 'text'; text: string } | { mode: 'structured'; object: unknown };
  citations: Array<{ n: number; chunk_id: string }>;
  degradation_level: 'full' | 'no_citations' | 'partial' | 'cannot_answer';
  audit: {
    retrieval_status: 'full' | 'dense_only' | 'sparse_only' | 'empty';
    citation_integrity: 'valid' | 'invalid_removed' | 'missing' | null;
    candidates_returned: number;
    dense_candidates_returned: number;
    sparse_candidates_returned: number;
    reranker: {
      enabled: boolean;
      executed: boolean;
      provider?: string | null;
      model?: string | null;
      top_n?: number | null;
      fallback_reason?: string | null;
      actionable?: boolean | null;
    };
    tokens: {
      embedding_input: number;
      synthesis_input: number;
      synthesis_output: number;
      context: number;
    };
  };
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
  const res = await fetch(`${WORKER_URL}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function pollJob(jobId: string, timeoutMs = 240_000): Promise<IngestionJobResponse> {
  const start = Date.now();
  let last: IngestionJobResponse | undefined;
  while (Date.now() - start < timeoutMs) {
    const r = await api<IngestionJobResponse>('GET', `/v1/ingestion-jobs/${jobId}`);
    last = r;
    process.stdout.write(`  job.status=${r.status}/stage=${r.current_stage ?? '-'}\n`);
    if (r.status === 'completed' || r.status === 'failed') return r;
    await new Promise((rs) => setTimeout(rs, 3_000));
  }
  throw new Error(`timed out (last=${last?.status})`);
}

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', 'test', 'fixtures');
const NARRATIVE_FIXTURE = readFileSync(join(FIXTURES_DIR, 'narrative-tiny.md'), 'utf-8');

async function main(): Promise<void> {
  console.log(`Phase 5 live e2e against ${WORKER_URL}`);

  // 1. Idempotent: ensure the narrative namespace exists. (Manual seed
  // step in the runbook also creates it.)
  console.log('1. Ensure namespace `narrative` exists');
  try {
    await api('POST', '/v1/namespaces', {
      slug: 'narrative',
      corpus_profile: 'narrative',
      default_embedding_profile: 'openai-text-embedding-3-large-1536',
    });
    console.log('  created');
  } catch (e) {
    if (String(e).includes('NAMESPACE_ALREADY_EXISTS')) {
      console.log('  already exists');
    } else {
      throw e;
    }
  }

  // 2. BYOK OpenAI key (idempotent label).
  console.log('2. Register OpenAI BYOK key');
  const label = 'phase5-live';
  try {
    await api<ProviderKeyResponse>('POST', '/v1/provider-keys', {
      provider: 'openai',
      label,
      key: OPENAI_KEY,
    });
    console.log('  created');
  } catch (e) {
    const msg = String(e);
    if (msg.includes('already exists')) console.log('  already exists');
    else throw e;
  }

  // 3. Document + upload + finalize under the narrative namespace.
  console.log('3. Create document under narrative namespace');
  const doc = await api<DocumentResponse>('POST', '/v1/namespaces/narrative/documents', {
    title: 'Library of Alexandria — Phase 5 fixture',
    doc_type: 'narrative',
  });
  check('document.id', doc.id.startsWith('doc_'));

  console.log('4. Presign + upload + finalize');
  const upload = await api<UploadResponse>('POST', `/v1/documents/${doc.id}/uploads`, {
    content_type: 'text/markdown',
    size_bytes: NARRATIVE_FIXTURE.length,
  });
  const putHeaders: Record<string, string> = { 'content-type': 'text/markdown' };
  if (upload.url.startsWith(WORKER_URL)) putHeaders['x-textral-api-key'] = API_KEY;
  const putRes = await fetch(upload.url, {
    method: 'PUT',
    headers: putHeaders,
    body: NARRATIVE_FIXTURE,
  });
  check(`upload PUT (${putRes.status})`, putRes.ok);
  const finalize = await api<FinalizeResponse>(
    'POST',
    `/v1/documents/${doc.id}/uploads/${upload.upload_id}/finalize`,
    {},
  );
  check(`finalize size=${finalize.size_bytes}`, finalize.size_bytes === NARRATIVE_FIXTURE.length);

  console.log('5. Trigger ingestion (narrative profile)');
  const ingest = await api<{ job_id: string; version_id: string }>(
    'POST',
    `/v1/documents/${doc.id}/ingest`,
    {
      version_id: finalize.version_id,
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 1536,
        provider_key_ref: label,
      },
      chunking: { profile: 'generic', target_tokens: 200, overlap_tokens: 30 },
      mode: 'full',
    },
  );
  check('job_id created', ingest.job_id.startsWith('job_'));

  console.log('6. Poll job → completion');
  const job = await pollJob(ingest.job_id, 240_000);
  check('job completed', job.status === 'completed');

  console.log('7. Wait 25s for Vectorize propagation');
  await new Promise((rs) => setTimeout(rs, 25_000));

  console.log('8. Query via narrative namespace (profile defaults rerank=on)');
  const q = await api<QueryResponse>('POST', '/v1/query', {
    namespace: 'narrative',
    query: 'Who calculated the circumference of the Earth?',
    embedding: {
      provider: 'openai',
      model: 'text-embedding-3-large',
      dimensions: 1536,
      provider_key_ref: label,
    },
    inference: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      provider_key_ref: label,
    },
    retrieval: { strategy: 'hybrid_rrf', top_k_dense: 5, top_k_sparse: 5 },
  });

  console.log('9. Phase 5 audit assertions');
  check(
    'audit.reranker.enabled=true (narrative profile)',
    q.audit.reranker.enabled === true,
    `got ${q.audit.reranker.enabled}`,
  );
  check(
    'audit.reranker.executed=false (no Voyage key → fallback)',
    q.audit.reranker.executed === false,
    `got ${q.audit.reranker.executed}`,
  );
  check(
    'audit.reranker.fallback_reason=PROVIDER_KEY_NOT_FOUND',
    q.audit.reranker.fallback_reason === 'PROVIDER_KEY_NOT_FOUND',
    `got ${q.audit.reranker.fallback_reason}`,
  );
  check(
    'audit.reranker.actionable=true (operator should register Voyage key)',
    q.audit.reranker.actionable === true,
    `got ${q.audit.reranker.actionable}`,
  );
  check(
    'degradation_level=full (rerank fallback is not a degradation)',
    q.degradation_level === 'full',
    `got ${q.degradation_level}`,
  );
  if (q.answer.mode === 'text') {
    check(
      'answer mentions Eratosthenes',
      /eratosthenes/i.test(q.answer.text),
      q.answer.text.slice(0, 200),
    );
    console.log(`\n  Answer: ${q.answer.text}\n`);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});
