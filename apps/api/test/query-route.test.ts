// Query route smoke tests against the Worker bindings.
//
// Vectorize isn't emulated locally; tests that hit dense retrieval
// stub `globalThis.fetch` for the embedding call and stub the
// Vectorize binding's `query`. Sparse-only paths exercise FTS5
// against the real D1 binding.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey } from '../src/auth/api-key.js';
import { newId } from '@textral/contracts';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

async function seedFullCorpus(
  e: Env,
): Promise<{
  rawKey: string;
  tenantId: string;
  namespaceId: string;
  documentId: string;
  versionId: string;
  vidxId: string;
}> {
  const tenantId = `ten_${newId('ten').slice(4)}`;
  const pepper = e.API_KEY_PEPPER as unknown as string;
  const key = await generateApiKey(pepper);
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'Q Test', Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(key.id, tenantId, key.hash, key.prefix, '["*"]', Date.now())
    .run();
  const nsId = newId('ns');
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, 'default', 'generic', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(nsId, tenantId, Date.now())
    .run();
  // Provider key (the test stubs fetch so this is just the metadata hookup).
  const pkeyId = newId('pkey');
  const secretName = `pkey-${tenantId}-openai-prod`;
  await e.DB.prepare(
    `INSERT INTO provider_keys (id, tenant_id, provider, label, secrets_store_secret_name, created_at)
     VALUES (?, ?, 'openai', 'prod', ?, ?)`,
  )
    .bind(pkeyId, tenantId, secretName, Date.now())
    .run();
  // Stub Secrets Store.
  (e as unknown as Record<string, unknown>)['__TEST_PROVIDER_KEY_STORE__'] = new Map([
    [secretName, 'sk-test-key'],
  ]);
  // Document + version + version_index + chunks.
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
     VALUES (?, ?, ?, 'h', 'k', 'text/plain', 100, ?)`,
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
  // Two passages so sparse retrieval can find them.
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
      'The quick brown fox jumps over the lazy dog.',
      Date.now(),
    )
    .run();
  await e.DB.prepare(
    `INSERT INTO chunks
       (id, tenant_id, namespace_id, document_id, version_id, version_index_id,
        artifact_type, section_path, ord, text,
        embedding_profile, chunking_profile, embedding_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'passage', '/', 1, ?,
             'openai-text-embedding-3-large-1536', 'generic', 'embedded', ?)`,
  )
    .bind(
      `chk_${verId}_00001`,
      tenantId,
      nsId,
      docId,
      verId,
      vidxId,
      'Forty-two is the answer to life the universe and everything.',
      Date.now(),
    )
    .run();
  return {
    rawKey: key.raw,
    tenantId,
    namespaceId: nsId,
    documentId: docId,
    versionId: verId,
    vidxId,
  };
}

function makeQueryBody(): Record<string, unknown> {
  return {
    namespace: 'default',
    query: 'fox',
    embedding: {
      provider: 'openai',
      model: 'text-embedding-3-large',
      dimensions: 1536,
      provider_key_ref: 'prod',
    },
    inference: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      provider_key_ref: 'prod',
    },
  };
}

function call(e: Env, rawKey: string, body: unknown): Promise<Response> {
  return callJson(e, 'POST', 'http://x/v1/query', { 'X-Textral-Api-Key': rawKey }, body);
}

describe('POST /v1/query', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM query_events`).run();
    await e.DB.prepare(`DELETE FROM chunks`).run();
    await e.DB.prepare(`DELETE FROM ingest_stage_attempts`).run();
    await e.DB.prepare(`DELETE FROM ingestion_jobs`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM upload_intents`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM provider_keys`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
    delete (e as unknown as Record<string, unknown>)['__TEST_PROVIDER_KEY_STORE__'];
  });
  afterEach(() => vi.restoreAllMocks());

  it('writes a query_events row even when retrieval is empty (cannot_answer)', async () => {
    const e = env as unknown as Env;
    const { rawKey } = await seedFullCorpus(e);

    // Stub embedding + chat: chat won't be called when retrieval is empty,
    // but embedding is. The query 'xyzzyz' won't match any chunks via
    // FTS5, and we'll force Vectorize to return empty by stubbing.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: Array(1536).fill(0.1) }],
            model: 'text-embedding-3-large',
            usage: { prompt_tokens: 1 },
          }),
          { status: 200 },
        ),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    // Stub Vectorize: return zero matches.
    const realVectorize = e.VECTORIZE_OPENAI_LARGE;
    (e as unknown as Record<string, unknown>)['VECTORIZE_OPENAI_LARGE'] = {
      query: vi.fn().mockResolvedValue({ matches: [], count: 0 }),
      upsert: vi.fn().mockResolvedValue({ mutationId: 'mut_x' }),
      deleteByIds: vi.fn().mockResolvedValue({ mutationId: 'mut_y' }),
    };

    try {
      const body = makeQueryBody();
      body.query = 'xyzzyqqqq';
      const res = await call(e, rawKey, body);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { degradation_level: string; query_event_id: string };
      expect(json.degradation_level).toBe('cannot_answer');
      // query_events row exists.
      const row = await e.DB.prepare(
        `SELECT status, degradation_level FROM query_events WHERE id = ?`,
      )
        .bind(json.query_event_id)
        .first<{ status: string; degradation_level: string }>();
      expect(row?.status).toBe('failed');
      expect(row?.degradation_level).toBe('cannot_answer');
    } finally {
      (e as unknown as Record<string, unknown>)['VECTORIZE_OPENAI_LARGE'] = realVectorize;
    }
  });

  it('returns EMBEDDING_PROFILE_MISMATCH when chunking_profile differs from indexed', async () => {
    const e = env as unknown as Env;
    const { rawKey } = await seedFullCorpus(e);
    const body = makeQueryBody();
    (body.chunking as Record<string, unknown>) = { profile: 'legal' };
    body.chunking = { profile: 'legal' };
    const res = await call(e, rawKey, body);
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string; details: { dimension: string } } };
    expect(err.error.code).toBe('EMBEDDING_PROFILE_MISMATCH');
    expect(err.error.details.dimension).toBe('chunking');
  });

  it('returns audit.reranker.enabled = false (Phase 4 no-op)', async () => {
    const e = env as unknown as Env;
    const { rawKey } = await seedFullCorpus(e);
    const fetchMock = vi.fn().mockImplementation((_url, _init) => {
      // Both embedding + chat go through fetch.
      const u = String(_url);
      if (u.endsWith('/embeddings')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ embedding: Array(1536).fill(0.1) }],
              model: 'text-embedding-3-large',
              usage: { prompt_tokens: 1 },
            }),
            { status: 200 },
          ),
        );
      }
      // Chat completion.
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: 'The fox is mentioned in [1].' },
                finish_reason: 'stop',
              },
            ],
            model: 'gpt-4o-mini',
            usage: { prompt_tokens: 12, completion_tokens: 7 },
          }),
          { status: 200 },
        ),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const realVectorize = e.VECTORIZE_OPENAI_LARGE;
    (e as unknown as Record<string, unknown>)['VECTORIZE_OPENAI_LARGE'] = {
      query: vi.fn().mockResolvedValue({ matches: [], count: 0 }),
      upsert: vi.fn().mockResolvedValue({ mutationId: 'mut_x' }),
      deleteByIds: vi.fn().mockResolvedValue({ mutationId: 'mut_y' }),
    };

    try {
      const res = await call(e, rawKey, makeQueryBody());
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        degradation_level: string;
        answer: { mode: string; text?: string };
        audit: { reranker: { enabled: boolean }; retrieval_status: string };
        citations: Array<{ n: number }>;
      };
      // Both arms succeeded (dense returned 0 matches, sparse 1+); the
      // status is 'full' even though dense had no hits — that's the
      // arm-fulfilled distinction, not arm-with-results.
      expect(json.audit.reranker.enabled).toBe(false);
      expect(json.audit.retrieval_status).toBe('full');
      expect(json.answer.mode).toBe('text');
      expect(json.answer.text).toContain('[1]');
      expect(json.citations.length).toBeGreaterThanOrEqual(1);
      expect(json.degradation_level).toBe('full');
    } finally {
      (e as unknown as Record<string, unknown>)['VECTORIZE_OPENAI_LARGE'] = realVectorize;
    }
  });

  it('writes a query_events row when synthesis fails (insufficient_quota)', async () => {
    const e = env as unknown as Env;
    const { rawKey } = await seedFullCorpus(e);

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((_url, _init) => {
      callCount++;
      const u = String(_url);
      if (u.endsWith('/embeddings')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ embedding: Array(1536).fill(0.1) }],
              model: 'text-embedding-3-large',
              usage: { prompt_tokens: 1 },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'insufficient_quota',
              message: 'You exceeded your current quota.',
            },
          }),
          { status: 429 },
        ),
      );
    }) as unknown as typeof globalThis.fetch;
    const realVectorize = e.VECTORIZE_OPENAI_LARGE;
    (e as unknown as Record<string, unknown>)['VECTORIZE_OPENAI_LARGE'] = {
      query: vi.fn().mockResolvedValue({ matches: [], count: 0 }),
      upsert: vi.fn().mockResolvedValue({ mutationId: 'mut_x' }),
      deleteByIds: vi.fn().mockResolvedValue({ mutationId: 'mut_y' }),
    };
    try {
      const res = await call(e, rawKey, makeQueryBody());
      expect(res.status).toBe(200);
      const json = (await res.json()) as { query_event_id: string; degradation_level: string };
      expect(json.degradation_level).toBe('cannot_answer');
      const row = await e.DB.prepare(`SELECT status, error_message FROM query_events WHERE id = ?`)
        .bind(json.query_event_id)
        .first<{ status: string; error_message: string }>();
      expect(row?.status).toBe('failed');
      expect(row?.error_message).toContain('quota');
    } finally {
      (e as unknown as Record<string, unknown>)['VECTORIZE_OPENAI_LARGE'] = realVectorize;
      void callCount;
    }
  });
});
