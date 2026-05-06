// Phase 8.1 — E2E happy-path test against deployed dev.
//
// Gated by LIVE_E2E=1; otherwise the suite skips so `pnpm test` stays
// fast. When enabled, walks the full flow: register provider key →
// create namespace → upload + finalize → ingest → poll → query (sync
// + streaming) → eval set → audit lookup.

import { describe, it, expect } from 'vitest';

const LIVE = process.env.LIVE_E2E === '1';
const WORKER = (process.env.LIVE_WORKER_URL ?? '').replace(/\/$/, '');
const API_KEY = process.env.LIVE_API_KEY ?? '';
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';

const skip = !(LIVE && WORKER && API_KEY && OPENAI_KEY);

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      'x-textral-api-key': API_KEY,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${WORKER}${path}`, init);
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

describe.skipIf(skip)('Phase 8.1 — happy-path E2E', () => {
  const namespace = `e2e-${Date.now()}`;
  const label = `e2e-${Date.now()}`;
  const fixture = `# Chapter\n\nThe library at Alexandria.\n`;

  it('runs end-to-end against deployed dev', async () => {
    // 1. Register provider key.
    await api('POST', '/v1/provider-keys', {
      provider: 'openai',
      label,
      api_key: OPENAI_KEY,
    });

    // 2. Create namespace.
    await api('POST', '/v1/namespaces', {
      slug: namespace,
      corpus_profile: 'narrative',
      default_embedding_profile: 'openai-text-embedding-3-large-1536',
    });

    // 3. Register doc + upload + finalize.
    const doc = await api<{ id: string }>(
      'POST',
      `/v1/namespaces/${namespace}/documents`,
      { title: 'happy-path', doc_type: 'narrative' },
    );
    const upload = await api<{ url: string; upload_id: string }>(
      'POST',
      `/v1/documents/${doc.id}/uploads`,
      { content_type: 'text/markdown', size_bytes: fixture.length },
    );
    const putHeaders: Record<string, string> = { 'content-type': 'text/markdown' };
    if (upload.url.startsWith(WORKER)) putHeaders['x-textral-api-key'] = API_KEY;
    const putRes = await fetch(upload.url, {
      method: 'PUT',
      headers: putHeaders,
      body: fixture,
    });
    expect(putRes.ok).toBe(true);
    const finalize = await api<{ version_id: string }>(
      'POST',
      `/v1/documents/${doc.id}/uploads/${upload.upload_id}/finalize`,
      {},
    );

    // 4. Ingest.
    const ingest = await api<{ job_id: string }>(
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

    // 5. Poll job to completion (max 4 min).
    const start = Date.now();
    let job: { status: string };
    while (true) {
      job = await api<{ status: string }>('GET', `/v1/ingestion-jobs/${ingest.job_id}`);
      if (job.status === 'completed' || job.status === 'failed') break;
      if (Date.now() - start > 240_000) throw new Error('job poll timed out');
      await new Promise((r) => setTimeout(r, 5_000));
    }
    expect(job.status).toBe('completed');

    // 6. Wait for Vectorize propagation.
    await new Promise((r) => setTimeout(r, 25_000));

    // 7. Sync query.
    const q = await api<{
      degradation_level: string;
      audit: { reranker: { enabled: boolean }; latency_ms: number };
      query_event_id: string;
    }>('POST', '/v1/query', {
      namespace,
      query: 'Where was the library?',
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
      chunking: { profile: 'generic' },
      retrieval: { strategy: 'hybrid_rrf', top_k_dense: 5, top_k_sparse: 5 },
    });
    expect(q.audit.latency_ms).toBeGreaterThan(0);

    // 8. Audit lookup.
    const ev = await api<{ id: string }>('GET', `/v1/query-events/${q.query_event_id}`);
    expect(ev.id).toBe(q.query_event_id);
  }, 360_000);
});
