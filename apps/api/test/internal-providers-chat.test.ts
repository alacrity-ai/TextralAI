// /internal/providers/chat — back-channel chat endpoint used by the
// Container's enrichment runner. Mirrors /internal/providers/embed:
// HMAC-signed, looks up the job to scope tenant_id, resolves the
// provider key by ref, calls provider.llm.chat(), proxies the response.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { callWorker } from './helpers/fetch.js';
import { signInternal } from './helpers/internal-sign.js';
import type { Env } from '../src/types.js';

const SECRET_NAME_PREFIX = 'pkey-';

async function seedJobAndKey(
  e: Env,
  opts: { provider: string; label: string; rawKey: string },
): Promise<{ jobId: string; tenantId: string; secretName: string }> {
  const tenantId = `ten_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'Chat Test', Date.now())
    .run();
  const nsId = newId('ns');
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, 'default', 'generic', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(nsId, tenantId, Date.now())
    .run();
  const docId = newId('doc');
  await e.DB.prepare(
    `INSERT INTO documents (id, tenant_id, namespace_id, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(docId, tenantId, nsId, Date.now())
    .run();
  const verId = newId('ver');
  await e.DB.prepare(
    `INSERT INTO document_versions
       (id, document_id, tenant_id, content_hash, source_r2_key,
        content_type, size_bytes, created_at)
     VALUES (?, ?, ?, 'h', 'k', 'text/plain', 1, ?)`,
  )
    .bind(verId, docId, tenantId, Date.now())
    .run();
  const vidxId = newId('vidx');
  await e.DB.prepare(
    `INSERT INTO version_indexes
       (id, version_id, tenant_id, chunking_profile, chunking_target_tokens,
        chunking_overlap_tokens, embedding_profile, embedding_provider, embedding_model,
        embedding_dimensions, distance_metric, corpus_profile, enrichment_config, created_at)
     VALUES (?, ?, ?, 'generic', 600, 80,
             'openai-text-embedding-3-large-1536', 'openai', 'text-embedding-3-large',
             1536, 'cosine', 'generic', '{}', ?)`,
  )
    .bind(vidxId, verId, tenantId, Date.now())
    .run();
  const jobId = newId('job');
  await e.DB.prepare(
    `INSERT INTO ingestion_jobs
       (id, tenant_id, document_id, version_id, version_index_id, mode, status,
        attempt_count, dead_lettered, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'full', 'running', 0, 0, '{}', ?)`,
  )
    .bind(jobId, tenantId, docId, verId, vidxId, Date.now())
    .run();
  const pkeyId = newId('pkey');
  const secretName = `${SECRET_NAME_PREFIX}${tenantId}-${opts.provider}-${opts.label}`;
  await e.DB.prepare(
    `INSERT INTO provider_keys (id, tenant_id, provider, label, secrets_store_secret_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(pkeyId, tenantId, opts.provider, opts.label, secretName, Date.now())
    .run();
  (e as unknown as Record<string, unknown>)['__TEST_PROVIDER_KEY_STORE__'] = new Map([
    [secretName, opts.rawKey],
  ]);
  return { jobId, tenantId, secretName };
}

async function postChat(
  e: Env,
  body: unknown,
): Promise<Response> {
  const secret = e.INTERNAL_HMAC_SECRET as unknown as string;
  const path = '/internal/providers/chat';
  const bodyStr = JSON.stringify(body);
  const sig = await signInternal(secret, 'POST', path, bodyStr);
  return callWorker(
    e,
    new Request(`http://x${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sig },
      body: bodyStr,
    }),
  );
}

describe('/internal/providers/chat', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM ingest_stage_attempts`).run();
    await e.DB.prepare(`DELETE FROM ingestion_jobs`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM provider_keys`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
    delete (e as unknown as Record<string, unknown>)['__TEST_PROVIDER_KEY_STORE__'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects requests with no signature', async () => {
    const e = env as unknown as Env;
    const res = await callWorker(
      e,
      new Request('http://x/internal/providers/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when job_id is unknown', async () => {
    const e = env as unknown as Env;
    const res = await postChat(e, {
      job_id: 'job_nonexistent',
      messages: [{ role: 'user', content: 'hi' }],
      model_override: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 when messages is empty', async () => {
    const e = env as unknown as Env;
    const { jobId } = await seedJobAndKey(e, {
      provider: 'anthropic',
      label: 'prod',
      rawKey: 'sk-ant-test',
    });
    const res = await postChat(e, {
      job_id: jobId,
      messages: [],
      model_override: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        provider_key_ref: 'prod',
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when provider_key_ref is missing for non-workers_ai provider', async () => {
    const e = env as unknown as Env;
    const { jobId } = await seedJobAndKey(e, {
      provider: 'anthropic',
      label: 'prod',
      rawKey: 'sk-ant-test',
    });
    const res = await postChat(e, {
      job_id: jobId,
      messages: [{ role: 'user', content: 'hi' }],
      model_override: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('provider_key_ref');
  });

  it('proxies a successful Anthropic chat call', async () => {
    const e = env as unknown as Env;
    const { jobId } = await seedJobAndKey(e, {
      provider: 'anthropic',
      label: 'prod',
      rawKey: 'sk-ant-fakefakefakefakefakefakefakefake',
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'pong' }],
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const res = await postChat(e, {
      job_id: jobId,
      messages: [{ role: 'user', content: 'ping' }],
      model_override: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        provider_key_ref: 'prod',
      },
      max_tokens: 16,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
      finish_reason: string;
    };
    expect(body.content).toBe('pong');
    expect(body.usage.input_tokens).toBe(4);
    expect(body.usage.output_tokens).toBe(1);
    expect(body.finish_reason).toBe('stop');
  });

  it('returns 422 on a fatal upstream auth error', async () => {
    const e = env as unknown as Env;
    const { jobId } = await seedJobAndKey(e, {
      provider: 'anthropic',
      label: 'prod',
      rawKey: 'sk-ant-bogusbogusbogusbogusbogusbogus',
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid key' },
        }),
        { status: 401 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const res = await postChat(e, {
      job_id: jobId,
      messages: [{ role: 'user', content: 'ping' }],
      model_override: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        provider_key_ref: 'prod',
      },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROVIDER_KEY_INVALID');
  });

  it('returns 503 on a retryable upstream error', async () => {
    const e = env as unknown as Env;
    const { jobId } = await seedJobAndKey(e, {
      provider: 'anthropic',
      label: 'prod',
      rawKey: 'sk-ant-fakefakefakefakefakefakefakefake',
    });
    // Anthropic provider retries on 429/529. Always-503 from a mocked
    // upstream eventually surfaces as a retryable error after the
    // retry budget is exhausted.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
        { status: 529 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const res = await postChat(e, {
      job_id: jobId,
      messages: [{ role: 'user', content: 'ping' }],
      model_override: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        provider_key_ref: 'prod',
      },
    });
    expect(res.status).toBe(503);
  });
});
