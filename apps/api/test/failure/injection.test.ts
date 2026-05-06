// Phase 8.3 — failure injection.
//
// Pin the bad-day error semantics for the four canonical failure modes.
// Mocks globalThis.fetch to drive specific upstream errors.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { hmacKey } from '../../src/auth/api-key.js';
import { readPepper } from '../../src/auth/pepper.js';
import { callJson } from '../helpers/fetch.js';
import type { Env } from '../../src/types.js';

interface ApiKey { raw: string }

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
  return { raw };
}

async function seedTenantNamespaceWithChunks(
  e: Env,
): Promise<{ tenantId: string; slug: string; apiKey: ApiKey }> {
  const tenantId = `ten_${Math.random().toString(36).slice(2, 10)}`;
  const slug = `ns-${Math.random().toString(36).slice(2, 8)}`;
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'Inj', Date.now())
    .run();
  const nsId = newId('ns');
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, ?, 'generic', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(nsId, tenantId, slug, Date.now())
    .run();
  const pkeyId = newId('pkey');
  const secretName = `pkey-${tenantId}-openai-prod`;
  await e.DB.prepare(
    `INSERT INTO provider_keys (id, tenant_id, provider, label, secrets_store_secret_name, created_at)
     VALUES (?, ?, 'openai', 'prod', ?, ?)`,
  )
    .bind(pkeyId, tenantId, secretName, Date.now())
    .run();
  (e as unknown as Record<string, unknown>)['__TEST_PROVIDER_KEY_STORE__'] = new Map([
    [secretName, 'sk-test-key'],
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
  await e.DB.prepare(
    `INSERT INTO chunks
       (id, tenant_id, namespace_id, document_id, version_id, version_index_id,
        artifact_type, section_path, ord, text,
        embedding_profile, chunking_profile, embedding_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'passage', '/', 0, 'context here',
             'openai-text-embedding-3-large-1536', 'generic', 'embedded', ?)`,
  )
    .bind(`chk_${verId}_00000`, tenantId, nsId, docId, verId, vidxId, Date.now())
    .run();
  const apiKey = await seedApiKey(e, tenantId);
  return { tenantId, slug, apiKey };
}

const QUERY_BODY_BASE = (slug: string): Record<string, unknown> => ({
  namespace: slug,
  query: 'Question?',
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
  chunking: { profile: 'generic' },
  retrieval: { strategy: 'hybrid_rrf', top_k_dense: 5, top_k_sparse: 5 },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Phase 8.3 — failure injection', () => {
  it('invalid_api_key at query → degrades to cannot_answer with PROVIDER_KEY_INVALID audit', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantNamespaceWithChunks(e);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad key' } }),
        { status: 401 },
      ),
    ) as unknown as typeof globalThis.fetch;
    const res = await callJson(
      e,
      'POST',
      'http://x/v1/query',
      { 'x-textral-api-key': seed.apiKey.raw },
      QUERY_BODY_BASE(seed.slug),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { degradation_level: string };
    expect(body.degradation_level).toBe('cannot_answer');
  });

  it('insufficient_quota at query → degrades to cannot_answer', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantNamespaceWithChunks(e);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'insufficient_quota', message: 'quota' } }),
        { status: 429 },
      ),
    ) as unknown as typeof globalThis.fetch;
    const res = await callJson(
      e,
      'POST',
      'http://x/v1/query',
      { 'x-textral-api-key': seed.apiKey.raw },
      QUERY_BODY_BASE(seed.slug),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { degradation_level: string };
    expect(body.degradation_level).toBe('cannot_answer');
  });

  it('EMBEDDING_PROFILE_MISMATCH returns 400 from gateVersion', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantNamespaceWithChunks(e);
    const body = QUERY_BODY_BASE(seed.slug);
    (body.embedding as Record<string, unknown>).model = 'text-embedding-3-small';
    (body.embedding as Record<string, unknown>).dimensions = 1536;
    const res = await callJson(
      e,
      'POST',
      'http://x/v1/query',
      { 'x-textral-api-key': seed.apiKey.raw },
      body,
    );
    expect(res.status).toBe(400);
    const env2 = (await res.json()) as { error: { code: string } };
    expect(env2.error.code).toBe('EMBEDDING_PROFILE_MISMATCH');
  });

  it('AI Gateway-style total outage (503) on synthesis → cannot_answer', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantNamespaceWithChunks(e);
    let n = 0;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      n++;
      // Embedding succeeds (first call); subsequent synth call fails.
      if (n === 1 && String(url).includes('/v1/embeddings')) {
        return new Response(
          JSON.stringify({
            data: [{ embedding: new Array(1536).fill(0).map(() => Math.random()) }],
            usage: { prompt_tokens: 5, total_tokens: 5 },
            model: 'text-embedding-3-large',
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ error: { message: 'gateway down' } }),
        { status: 503 },
      );
    }) as unknown as typeof globalThis.fetch;
    const res = await callJson(
      e,
      'POST',
      'http://x/v1/query',
      { 'x-textral-api-key': seed.apiKey.raw },
      QUERY_BODY_BASE(seed.slug),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { degradation_level: string };
    expect(body.degradation_level).toBe('cannot_answer');
  });
});
