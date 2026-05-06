// /v1/query-events/{id}/response — mirrored answer retrieval.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { generateApiKey } from '../src/auth/api-key.js';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

interface SeededTenant {
  tenantId: string;
  rawKey: string;
  namespaceId: string;
}

async function seedTenant(e: Env, slug: string): Promise<SeededTenant> {
  const tenantId = `ten_${newId('ten').slice(4)}`;
  const pepper = e.API_KEY_PEPPER as unknown as string;
  const key = await generateApiKey(pepper);
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, `Tenant ${slug}`, Date.now())
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
     VALUES (?, ?, ?, 'generic', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(nsId, tenantId, slug, Date.now())
    .run();
  return { tenantId, rawKey: key.raw, namespaceId: nsId };
}

interface SeedRowOpts {
  tenantId: string;
  namespaceId: string;
  answer_r2_key?: string | null;
  mirror_error?: string | null;
  status?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}

async function seedRow(e: Env, opts: SeedRowOpts): Promise<string> {
  const id = newId('qev');
  await e.DB.prepare(
    `INSERT INTO query_events
       (id, tenant_id, namespace_id, status, query_text,
        request_config, request_config_hash,
        answer_r2_key, mirror_error,
        error_code, error_message,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.tenantId,
      opts.namespaceId,
      opts.status ?? 'completed',
      'who built this?',
      JSON.stringify({ namespace: 'cookbook', query: 'who built this?' }),
      `sha256-${id}`,
      opts.answer_r2_key ?? null,
      opts.mirror_error ?? null,
      opts.errorCode ?? null,
      opts.errorMessage ?? null,
      Date.now(),
    )
    .run();
  return id;
}

const SAMPLE_RESPONSE = {
  query_event_id: 'placeholder',
  answer: { mode: 'text' as const, text: 'Eratosthenes calculated the circumference of the Earth.' },
  citations: [
    { n: 1, chunk_id: 'chk_eratosthenes', section_path: 'Book III · §2', quote: 'Earth circumference' },
  ],
  degradation_level: 'full' as const,
  audit: {
    embedding_profile: 'openai-text-embedding-3-large',
    chunking_profile: 'generic',
    inference_provider: 'openai',
    inference_model: 'gpt-4o-mini',
    provider_key_id: 'pkey_test',
    retrieval_strategy: 'hybrid_rrf',
    retrieval_status: 'full' as const,
    dense_candidates_returned: 8,
    sparse_candidates_returned: 7,
    embedding_missing_count: 0,
    candidates_returned: 12,
    reranker: { enabled: false, executed: false, provider: null, model: null, top_n: null },
    citation_integrity: 'valid' as const,
    synthesis_status: 'success' as const,
    dropped_citations: [],
    tokens: {
      embedding_input: 12,
      synthesis_input: 980,
      synthesis_output: 210,
      context: 940,
    },
    total_cost_usd_micros: 4530,
    latency_ms: 1812,
  },
};

function call(e: Env, rawKey: string, id: string): Promise<Response> {
  return callJson(e, 'GET', `http://x/v1/query-events/${id}/response`, {
    'X-Textral-Api-Key': rawKey,
  });
}

describe('GET /v1/query-events/{id}/response', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM query_events`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('returns the mirrored QueryResponse exactly as written', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'r-happy');
    const id = newId('qev');
    const key = `${t.tenantId}/${t.namespaceId}/answers/${id}.json`;
    const payload = { ...SAMPLE_RESPONSE, query_event_id: id };
    await e.BLOBS.put(key, new TextEncoder().encode(JSON.stringify(payload)), {
      httpMetadata: { contentType: 'application/json' },
    });
    // Insert the row pointing at that blob.
    await e.DB.prepare(
      `INSERT INTO query_events
         (id, tenant_id, namespace_id, status, query_text,
          request_config, request_config_hash,
          answer_r2_key, created_at)
       VALUES (?, ?, ?, 'completed', 'who built this?',
               ?, ?, ?, ?)`,
    )
      .bind(
        id,
        t.tenantId,
        t.namespaceId,
        JSON.stringify({ q: 'x' }),
        `sha256-${id}`,
        key,
        Date.now(),
      )
      .run();

    const res = await call(e, t.rawKey, id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(payload);
  });

  it('returns 404 when the row does not exist', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'r-missing');
    const res = await call(e, t.rawKey, 'qev_does_not_exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 410 QUERY_RESPONSE_UNAVAILABLE when answer_r2_key is null (never mirrored)', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'r-null-key');
    const id = await seedRow(e, {
      tenantId: t.tenantId,
      namespaceId: t.namespaceId,
      answer_r2_key: null,
      status: 'completed',
      errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
      errorMessage: 'OpenAI quota tripped',
    });

    const res = await call(e, t.rawKey, id);
    expect(res.status).toBe(410);
    const body = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('QUERY_RESPONSE_UNAVAILABLE');
    expect(body.error.details).toMatchObject({
      reason: 'never_mirrored',
      event_error_code: 'PROVIDER_QUOTA_EXHAUSTED',
    });
  });

  it('returns 410 with reason=mirror_error when the mirror call itself failed', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'r-mirror-err');
    const id = await seedRow(e, {
      tenantId: t.tenantId,
      namespaceId: t.namespaceId,
      answer_r2_key: null,
      mirror_error: 'connection refused: blob endpoint unreachable',
      status: 'completed',
    });

    const res = await call(e, t.rawKey, id);
    expect(res.status).toBe(410);
    const body = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('QUERY_RESPONSE_UNAVAILABLE');
    expect(body.error.details).toMatchObject({
      reason: 'mirror_error',
      mirror_error: 'connection refused: blob endpoint unreachable',
    });
  });

  it('returns 410 with reason=reaped when the row points at a key whose blob is gone', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'r-reaped');
    const id = newId('qev');
    const key = `${t.tenantId}/${t.namespaceId}/answers/${id}.json`;
    // Row references a key, but we never actually put a blob — simulates
    // a reaped/expired mirror.
    await e.DB.prepare(
      `INSERT INTO query_events
         (id, tenant_id, namespace_id, status, query_text,
          request_config, request_config_hash,
          answer_r2_key, created_at)
       VALUES (?, ?, ?, 'completed', 'who built this?',
               ?, ?, ?, ?)`,
    )
      .bind(
        id,
        t.tenantId,
        t.namespaceId,
        JSON.stringify({ q: 'x' }),
        `sha256-${id}`,
        key,
        Date.now(),
      )
      .run();

    const res = await call(e, t.rawKey, id);
    expect(res.status).toBe(410);
    const body = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('QUERY_RESPONSE_UNAVAILABLE');
    expect(body.error.details).toMatchObject({ reason: 'reaped' });
  });

  it('cross-tenant isolation: tenant B receives 404, never the row', async () => {
    const e = env as unknown as Env;
    const tA = await seedTenant(e, 'iso-a');
    const tB = await seedTenant(e, 'iso-b');

    const id = newId('qev');
    const key = `${tA.tenantId}/${tA.namespaceId}/answers/${id}.json`;
    await e.BLOBS.put(
      key,
      new TextEncoder().encode(JSON.stringify({ ...SAMPLE_RESPONSE, query_event_id: id })),
      { httpMetadata: { contentType: 'application/json' } },
    );
    await e.DB.prepare(
      `INSERT INTO query_events
         (id, tenant_id, namespace_id, status, query_text,
          request_config, request_config_hash,
          answer_r2_key, created_at)
       VALUES (?, ?, ?, 'completed', 'q', ?, ?, ?, ?)`,
    )
      .bind(
        id,
        tA.tenantId,
        tA.namespaceId,
        JSON.stringify({ q: 'x' }),
        `sha256-${id}`,
        key,
        Date.now(),
      )
      .run();

    const aRes = await call(e, tA.rawKey, id);
    expect(aRes.status).toBe(200);

    const bRes = await call(e, tB.rawKey, id);
    expect(bRes.status).toBe(404);
    const body = (await bRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 502 INTERNAL when the mirror is not parseable JSON', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'r-corrupt');
    const id = newId('qev');
    const key = `${t.tenantId}/${t.namespaceId}/answers/${id}.json`;
    await e.BLOBS.put(key, new TextEncoder().encode('{ not valid json'), {
      httpMetadata: { contentType: 'application/json' },
    });
    await e.DB.prepare(
      `INSERT INTO query_events
         (id, tenant_id, namespace_id, status, query_text,
          request_config, request_config_hash,
          answer_r2_key, created_at)
       VALUES (?, ?, ?, 'completed', 'q', ?, ?, ?, ?)`,
    )
      .bind(
        id,
        t.tenantId,
        t.namespaceId,
        JSON.stringify({ q: 'x' }),
        `sha256-${id}`,
        key,
        Date.now(),
      )
      .run();

    const res = await call(e, t.rawKey, id);
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.details).toMatchObject({ reason: 'corrupt_mirror' });
  });

  it('rejects unauthenticated access (401)', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', 'http://x/v1/query-events/qev_anything/response');
    expect(res.status).toBe(401);
  });
});
