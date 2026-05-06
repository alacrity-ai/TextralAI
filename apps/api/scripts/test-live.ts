// scripts/test-live.ts — End-to-end live test against the deployed Worker
// (and its Container + Vectorize binding).
//
// Why a Node script and not a vitest test? vitest-pool-workers runs tests
// inside Workers, where `process.env` doesn't pass through. The e2e
// scenario only needs `fetch()` against an already-deployed URL, so a
// plain Node script is the right runner.
//
// Setup the user must perform once:
//   1. `make deploy-dev`     — Worker + Container.
//   2. `make migrate-dev`    — Apply D1 schema.
//   3. `wrangler secret put INTERNAL_HMAC_SECRET --env dev` (and
//      AUDIT_HASH_SALT, API_KEY_PEPPER, ADMIN_BOOTSTRAP_TOKEN).
//   4. `make seed-dev`        — Provision a tenant + namespace + API key.
//
// Then:
//   LIVE_WORKER_URL=https://textral-api-dev.<sub>.workers.dev \
//   LIVE_API_KEY=<seeded key> \
//   OPENAI_API_KEY=<your openai key> \
//     pnpm --filter @textral/api exec tsx scripts/test-live.ts
//
// Exits 0 on success, non-zero with a diagnostic on failure.

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
  content_hash: string;
  source_r2_key: string;
  size_bytes: number;
  content_type: string;
  deduplicated: boolean;
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

async function pollJobUntilDone(jobId: string, timeoutMs = 240_000): Promise<IngestionJobResponse> {
  const start = Date.now();
  let last: IngestionJobResponse | undefined;
  while (Date.now() - start < timeoutMs) {
    const r = await api<IngestionJobResponse>('GET', `/v1/ingestion-jobs/${jobId}`);
    last = r;
    process.stdout.write(`  job.status=${r.status}/stage=${r.current_stage ?? '-'}\n`);
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

const FIXTURE_TEXT = `
The Library of Alexandria stood near the harbor of the ancient city. Its scrolls
included works on geometry, astronomy, and medicine. Eratosthenes, a librarian
there, calculated the circumference of the Earth using the angle of shadows
cast at noon in two different cities on the same day.

Centuries later, the library was lost. Estimates of its destruction range from
a fire during Caesar's siege in 48 BCE to slow institutional decline. Modern
scholars assemble its catalog from later citations: a paragraph here, a
fragment there, drifting through Byzantine sermons and Arabic encyclopedias.
`.trim();

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  console.log(`Live e2e against ${WORKER_URL}`);

  // 1. Register a BYOK OpenAI provider key.
  const label = `live-${Date.now().toString(36)}`;
  console.log('1. Register OpenAI BYOK key');
  const pkey = await api<ProviderKeyResponse>('POST', '/v1/provider-keys', {
    provider: 'openai',
    label,
    key: OPENAI_KEY,
  });
  check('provider_key registered', pkey.provider === 'openai');

  // 2. Create the document shell.
  console.log('2. Create document');
  const doc = await api<DocumentResponse>(
    'POST',
    '/v1/namespaces/default/documents',
    {
      title: 'Library of Alexandria — live test fixture',
      doc_type: 'passage',
    },
  );
  check('document.id', doc.id?.startsWith('doc_'));

  // 3. Presign + upload + finalize.
  console.log('3. Presign + upload + finalize');
  const upload = await api<UploadResponse>(
    'POST',
    `/v1/documents/${doc.id}/uploads`,
    { content_type: 'text/plain', size_bytes: FIXTURE_TEXT.length },
  );
  // Worker-proxied upload (the deploy isn't configured for native R2
  // presigning). The URL points at /v1/documents/{id}/uploads/{uid}/data
  // and is API-key-authenticated.
  const putHeaders: Record<string, string> = { 'content-type': 'text/plain' };
  if (upload.url.startsWith(WORKER_URL)) putHeaders['x-textral-api-key'] = API_KEY;
  const putRes = await fetch(upload.url, {
    method: 'PUT',
    headers: putHeaders,
    body: FIXTURE_TEXT,
  });
  if (!putRes.ok) {
    console.error(`  PUT body: ${await putRes.text()}`);
  }
  check(`upload PUT (${putRes.status})`, putRes.ok);

  const finalize = await api<FinalizeResponse>(
    'POST',
    `/v1/documents/${doc.id}/uploads/${upload.upload_id}/finalize`,
    {},
  );
  check(`finalize size=${finalize.size_bytes}`, finalize.size_bytes === FIXTURE_TEXT.length);

  // 4. Ingest.
  console.log('4. Trigger ingestion');
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
  check('job_id created', ingest.job_id?.startsWith('job_'));

  // 5. Poll the job to completion.
  console.log('5. Poll job → Container processes via queue');
  const job = await pollJobUntilDone(ingest.job_id, 240_000);
  check('job completed', job.status === 'completed');

  // 5b. Vectorize is eventually-consistent — upsert returns a mutationId
  // immediately but the vector isn't queryable until propagation. The
  // typical window is a few seconds; we sleep ~25 s to be safe.
  console.log('5b. Waiting 25s for Vectorize propagation');
  await new Promise((r) => setTimeout(r, 25_000));

  // 6. Query.
  console.log('6. Query');
  const q = await api<QueryResponse>('POST', '/v1/query', {
    namespace: 'default',
    document_ids: [doc.id],
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

  console.log('7. Synthesis assertions');
  check('degradation_level=full', q.degradation_level === 'full', `got ${q.degradation_level}`);
  check(
    'retrieval_status=full',
    q.audit.retrieval_status === 'full',
    `got ${q.audit.retrieval_status}`,
  );
  check(
    'dense_candidates>0',
    q.audit.dense_candidates_returned > 0,
    `got ${q.audit.dense_candidates_returned}`,
  );
  check(
    'sparse_candidates>0',
    q.audit.sparse_candidates_returned > 0,
    `got ${q.audit.sparse_candidates_returned}`,
  );
  check('citations>0', q.citations.length > 0, `got ${q.citations.length}`);
  check(
    'citation_integrity=valid',
    q.audit.citation_integrity === 'valid',
    `got ${q.audit.citation_integrity}`,
  );
  check(
    'tokens.synthesis_input>0',
    q.audit.tokens.synthesis_input > 0,
    `got ${q.audit.tokens.synthesis_input}`,
  );
  check(
    'tokens.synthesis_output>0',
    q.audit.tokens.synthesis_output > 0,
    `got ${q.audit.tokens.synthesis_output}`,
  );

  if (q.answer.mode !== 'text') {
    check(`answer.mode=text`, false, `got ${q.answer.mode}`);
  } else {
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
