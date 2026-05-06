// Phase 6.2 — DLQ admin endpoints.
//
// Scope: tenant-scoped reads (admin scope only); CAS-based retry that
// clears dead_lettered and re-enqueues. Cross-tenant probes return 404.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { hmacKey } from '../src/auth/api-key.js';
import { readPepper } from '../src/auth/pepper.js';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

interface ApiKey {
  id: string;
  raw: string;
}

async function seedApiKey(
  e: Env,
  tenantId: string,
  scopes: string[],
): Promise<ApiKey> {
  const id = newId('ak');
  const raw = `sk-textral-${Math.random().toString(36).slice(2)}`;
  const pepper = await readPepper(e);
  const hash = await hmacKey(pepper, raw);
  await e.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, tenantId, hash, raw.slice(0, 12), JSON.stringify(scopes), Date.now())
    .run();
  return { id, raw };
}

async function seedTenantWithJob(
  e: Env,
  opts: { dead_lettered: boolean },
): Promise<{ tenantId: string; jobId: string; apiKey: ApiKey }> {
  const tenantId = `ten_${Math.random().toString(36).slice(2, 10)}`;
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'DLQ Test', Date.now())
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
        attempt_count, dead_lettered, error_code, error_message, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'full', ?, ?, ?, ?, ?, '{}', ?)`,
  )
    .bind(
      jobId,
      tenantId,
      docId,
      verId,
      vidxId,
      opts.dead_lettered ? 'failed' : 'pending',
      opts.dead_lettered ? 3 : 0,
      opts.dead_lettered ? 1 : 0,
      opts.dead_lettered ? 'PROVIDER_KEY_INVALID' : null,
      opts.dead_lettered ? 'invalid key' : null,
      Date.now(),
    )
    .run();
  const apiKey = await seedApiKey(e, tenantId, ['admin']);
  return { tenantId, jobId, apiKey };
}

describe('Phase 6.2 — DLQ admin', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM ingestion_jobs`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('GET /v1/admin/ingestion-jobs?dead_lettered=1 lists only DLQ rows', async () => {
    const e = env as unknown as Env;
    const a = await seedTenantWithJob(e, { dead_lettered: true });
    // Add a non-DLQ job for the same tenant.
    const otherJobId = newId('job');
    await e.DB.prepare(
      `INSERT INTO ingestion_jobs
         (id, tenant_id, document_id, version_id, version_index_id, mode, status,
          attempt_count, dead_lettered, config_json, created_at)
       VALUES (?, ?, (SELECT document_id FROM ingestion_jobs WHERE id = ?),
               (SELECT version_id FROM ingestion_jobs WHERE id = ?),
               (SELECT version_index_id FROM ingestion_jobs WHERE id = ?),
               'full', 'pending', 0, 0, '{}', ?)`,
    )
      .bind(otherJobId, a.tenantId, a.jobId, a.jobId, a.jobId, Date.now() + 1)
      .run();

    const res = await callJson(
      e,
      'GET',
      'http://x/v1/admin/ingestion-jobs?dead_lettered=1',
      { 'x-textral-api-key': a.apiKey.raw },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; next_cursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(a.jobId);
    expect(body.next_cursor).toBeNull();
  });

  it('rejects non-admin scoped keys with 403 INSUFFICIENT_SCOPE', async () => {
    const e = env as unknown as Env;
    const a = await seedTenantWithJob(e, { dead_lettered: true });
    // Replace the API key with a non-admin one.
    const apiKey = await seedApiKey(e, a.tenantId, ['read']);
    const res = await callJson(
      e,
      'GET',
      'http://x/v1/admin/ingestion-jobs?dead_lettered=1',
      { 'x-textral-api-key': apiKey.raw },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('POST /v1/ingestion-jobs/:id/retry clears dead_lettered and reposts to queue', async () => {
    const e = env as unknown as Env;
    const a = await seedTenantWithJob(e, { dead_lettered: true });
    const res = await callJson(
      e,
      'POST',
      `http://x/v1/ingestion-jobs/${a.jobId}/retry`,
      { 'x-textral-api-key': a.apiKey.raw },
      {},
    );
    expect(res.status).toBe(200);
    const row = await e.DB.prepare(
      `SELECT dead_lettered, status, attempt_count, error_code FROM ingestion_jobs WHERE id = ?`,
    )
      .bind(a.jobId)
      .first<{
        dead_lettered: number;
        status: string;
        attempt_count: number;
        error_code: string | null;
      }>();
    expect(row?.dead_lettered).toBe(0);
    expect(row?.status).toBe('pending');
    expect(row?.attempt_count).toBe(0);
    expect(row?.error_code).toBeNull();
  });

  it('refuses to retry a non-DLQ job with 400 DLQ_NOT_DEAD_LETTERED', async () => {
    const e = env as unknown as Env;
    const a = await seedTenantWithJob(e, { dead_lettered: false });
    const res = await callJson(
      e,
      'POST',
      `http://x/v1/ingestion-jobs/${a.jobId}/retry`,
      { 'x-textral-api-key': a.apiKey.raw },
      {},
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DLQ_NOT_DEAD_LETTERED');
  });

  it('cross-tenant retry returns 404 DLQ_NOT_FOUND', async () => {
    const e = env as unknown as Env;
    const a = await seedTenantWithJob(e, { dead_lettered: true });
    const b = await seedTenantWithJob(e, { dead_lettered: true });
    // Tenant A's API key against tenant B's job.
    const res = await callJson(
      e,
      'POST',
      `http://x/v1/ingestion-jobs/${b.jobId}/retry`,
      { 'x-textral-api-key': a.apiKey.raw },
      {},
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DLQ_NOT_FOUND');
  });

  it('idempotent: retry a second time returns 400 DLQ_NOT_DEAD_LETTERED', async () => {
    const e = env as unknown as Env;
    const a = await seedTenantWithJob(e, { dead_lettered: true });
    const r1 = await callJson(
      e,
      'POST',
      `http://x/v1/ingestion-jobs/${a.jobId}/retry`,
      { 'x-textral-api-key': a.apiKey.raw },
      {},
    );
    expect(r1.status).toBe(200);
    const r2 = await callJson(
      e,
      'POST',
      `http://x/v1/ingestion-jobs/${a.jobId}/retry`,
      { 'x-textral-api-key': a.apiKey.raw },
      {},
    );
    expect(r2.status).toBe(400);
    const body = (await r2.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DLQ_NOT_DEAD_LETTERED');
  });
});
