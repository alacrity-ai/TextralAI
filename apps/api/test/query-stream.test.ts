// Phase 6.5 — `/v1/query?stream=sse` SSE response.
//
// We mock both the embedding provider and the chat provider via
// globalThis.fetch. The chat provider is Anthropic — we send back an
// SSE-shaped response with three content_block_delta events then a
// message_stop.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { hmacKey } from '../src/auth/api-key.js';
import { readPepper } from '../src/auth/pepper.js';
import { callWorker } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

interface ApiKey {
  id: string;
  raw: string;
}

async function seedApiKey(e: Env, tenantId: string): Promise<ApiKey> {
  const id = newId('ak');
  const raw = `sk-textral-${Math.random().toString(36).slice(2)}`;
  const pepper = await readPepper(e);
  const hash = await hmacKey(pepper, raw);
  await e.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, tenantId, hash, raw.slice(0, 12), JSON.stringify(['*']), Date.now())
    .run();
  return { id, raw };
}

async function seedNamespaceWithChunks(
  e: Env,
): Promise<{ tenantId: string; slug: string; apiKey: ApiKey }> {
  const tenantId = `ten_${Math.random().toString(36).slice(2, 10)}`;
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'Stream Test', Date.now())
    .run();
  const nsId = newId('ns');
  const slug = `stream-${Math.random().toString(36).slice(2, 8)}`;
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, ?, 'generic', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(nsId, tenantId, slug, Date.now())
    .run();

  // Seed an OpenAI provider key (used for embedding) — raw key in test
  // Map.
  const pkeyId = newId('pkey');
  const secretName = `pkey-${tenantId}-openai-prod`;
  await e.DB.prepare(
    `INSERT INTO provider_keys (id, tenant_id, provider, label, secrets_store_secret_name, created_at)
     VALUES (?, ?, 'openai', 'prod', ?, ?)`,
  )
    .bind(pkeyId, tenantId, secretName, Date.now())
    .run();
  const anthroKeyId = newId('pkey');
  const anthroSecret = `pkey-${tenantId}-anthropic-prod`;
  await e.DB.prepare(
    `INSERT INTO provider_keys (id, tenant_id, provider, label, secrets_store_secret_name, created_at)
     VALUES (?, ?, 'anthropic', 'prod', ?, ?)`,
  )
    .bind(anthroKeyId, tenantId, anthroSecret, Date.now())
    .run();
  (e as unknown as Record<string, unknown>)['__TEST_PROVIDER_KEY_STORE__'] = new Map([
    [secretName, 'sk-test-openai'],
    [anthroSecret, 'sk-ant-fakefakefakefakefakefakefakefake'],
  ]);

  const docId = newId('doc');
  await e.DB.prepare(
    `INSERT INTO documents (id, tenant_id, namespace_id, current_version_id, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
  )
    .bind(docId, tenantId, nsId, Date.now())
    .run();
  const verId = newId('ver');
  await e.DB.prepare(
    `INSERT INTO document_versions
       (id, document_id, tenant_id, content_hash, source_r2_key, content_type, size_bytes, created_at)
     VALUES (?, ?, ?, 'h', 'k', 'text/plain', 1, ?)`,
  )
    .bind(verId, docId, tenantId, Date.now())
    .run();
  await e.DB.prepare(`UPDATE documents SET current_version_id = ? WHERE id = ?`)
    .bind(verId, docId)
    .run();
  const vidxId = newId('vidx');
  await e.DB.prepare(
    `INSERT INTO version_indexes
       (id, version_id, tenant_id, chunking_profile, chunking_target_tokens,
        chunking_overlap_tokens, embedding_profile, embedding_provider, embedding_model,
        embedding_dimensions, distance_metric, corpus_profile, enrichment_config, status, created_at)
     VALUES (?, ?, ?, 'generic', 600, 80,
             'openai-text-embedding-3-large-1536', 'openai', 'text-embedding-3-large',
             1536, 'cosine', 'generic', '{}', 'ready', ?)`,
  )
    .bind(vidxId, verId, tenantId, Date.now())
    .run();

  // One passage to ground the answer.
  await e.DB.prepare(
    `INSERT INTO chunks
       (id, tenant_id, namespace_id, document_id, version_id, version_index_id,
        artifact_type, section_path, ord, text,
        embedding_profile, chunking_profile, embedding_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'passage', '/', 0, ?,
             'openai-text-embedding-3-large-1536', 'generic', 'embedded', ?)`,
  )
    .bind(
      `chk_${verId}_00000`,
      tenantId,
      nsId,
      docId,
      verId,
      vidxId,
      'The library at Alexandria.',
      Date.now(),
    )
    .run();

  const apiKey = await seedApiKey(e, tenantId);
  return { tenantId, slug, apiKey };
}

interface FetchMock {
  fn: ReturnType<typeof vi.fn>;
}

function installFetchMock(): FetchMock {
  const fn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const u = String(url);
    void _init;
    // OpenAI embedding response.
    if (u.includes('/v1/embeddings')) {
      return new Response(
        JSON.stringify({
          data: [{ embedding: new Array(1536).fill(0).map(() => Math.random()) }],
          usage: { prompt_tokens: 5, total_tokens: 5 },
          model: 'text-embedding-3-large',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // Anthropic streaming response (SSE).
    if (u.includes('anthropic.com') || u.includes('/v1/messages')) {
      const sseBody = [
        `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 12, output_tokens: 0 } } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: 'text_delta', text: 'Alex' } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: 'text_delta', text: 'andria.' } })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ usage: { input_tokens: 12, output_tokens: 5 } })}\n\n`,
        `event: message_stop\ndata: {}\n\n`,
      ].join('');
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ error: 'unhandled' }), { status: 500 });
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return { fn };
}

void installFetchMock; // imported for future per-test installs

async function readSse(body: ReadableStream<Uint8Array>): Promise<
  Array<{ event: string; data: unknown }>
> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const out: Array<{ event: string; data: unknown }> = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = frame.split('\n');
      let event = '';
      let data = '';
      for (const l of lines) {
        if (l.startsWith('event: ')) event = l.slice(7);
        else if (l.startsWith('data: ')) data = l.slice(6);
      }
      if (event) {
        try {
          out.push({ event, data: JSON.parse(data) });
        } catch {
          out.push({ event, data });
        }
      }
    }
  }
  return out;
}

describe('Phase 6.5 — /v1/query?stream=sse', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM chunks`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM provider_keys`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
    await e.DB.prepare(`DELETE FROM query_events`).run();
    delete (e as unknown as Record<string, unknown>)['__TEST_PROVIDER_KEY_STORE__'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits token frames followed by a single done frame', async () => {
    const e = env as unknown as Env;
    const seed = await seedNamespaceWithChunks(e);
    installFetchMock();

    const reqBody = {
      namespace: seed.slug,
      query: 'Where was Alexandria?',
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 1536,
        provider_key_ref: 'prod',
      },
      inference: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        provider_key_ref: 'prod',
      },
      chunking: { profile: 'generic' },
      retrieval: { strategy: 'hybrid_rrf', top_k_dense: 5, top_k_sparse: 5 },
    };

    const res = await callWorker(
      e,
      new Request('http://x/v1/query?stream=sse', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-textral-api-key': seed.apiKey.raw,
        },
        body: JSON.stringify(reqBody),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames = await readSse(res.body!);
    const tokenFrames = frames.filter((f) => f.event === 'token');
    const doneFrames = frames.filter((f) => f.event === 'done');
    expect(tokenFrames.length).toBeGreaterThanOrEqual(1);
    expect(doneFrames).toHaveLength(1);
    const done = doneFrames[0]!.data as {
      degradation_level: string;
      audit: { latency_ms: number };
      query_event_id: string;
    };
    expect(done.query_event_id).toMatch(/^qev_/);
    expect(done.degradation_level).toBeTruthy();
    expect(typeof done.audit.latency_ms).toBe('number');
  });

  it('done frame on retrieval-empty namespace carries cannot_answer', async () => {
    const e = env as unknown as Env;
    const seed = await seedNamespaceWithChunks(e);
    // Wipe chunks so retrieval is empty.
    await e.DB.prepare(`DELETE FROM chunks`).run();
    installFetchMock();

    const res = await callWorker(
      e,
      new Request('http://x/v1/query?stream=sse', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-textral-api-key': seed.apiKey.raw,
        },
        body: JSON.stringify({
          namespace: seed.slug,
          query: 'Anything?',
          embedding: {
            provider: 'openai',
            model: 'text-embedding-3-large',
            dimensions: 1536,
            provider_key_ref: 'prod',
          },
          inference: {
            provider: 'anthropic',
            model: 'claude-haiku-4-5',
            provider_key_ref: 'prod',
          },
          chunking: { profile: 'generic' },
          retrieval: { strategy: 'hybrid_rrf', top_k_dense: 5, top_k_sparse: 5 },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const frames = await readSse(res.body!);
    const done = frames.find((f) => f.event === 'done')!.data as {
      degradation_level: string;
    };
    expect(done.degradation_level).toBe('cannot_answer');
  });
});
