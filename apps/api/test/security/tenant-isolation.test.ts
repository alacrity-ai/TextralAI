// Phase 8.2 — multi-tenant isolation.
//
// Pin the contract: every cross-tenant probe returns 404 (never 403,
// never leaks existence). The exception is INSUFFICIENT_SCOPE, which
// is 403 — but only for the caller's OWN tenant; the cross-tenant
// case still 404s.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { hmacKey } from '../../src/auth/api-key.js';
import { readPepper } from '../../src/auth/pepper.js';
import { callJson } from '../helpers/fetch.js';
import type { Env } from '../../src/types.js';

interface ApiKey {
  raw: string;
}

async function seedApiKey(e: Env, tenantId: string, scopes: string[]): Promise<ApiKey> {
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
  return { raw };
}

interface Tenant {
  id: string;
  slug: string;
  apiKey: ApiKey;
  docId: string;
  jobId: string;
  qevId: string;
  evsetId: string;
}

async function seedTenant(e: Env, scopes: string[] = ['*']): Promise<Tenant> {
  const id = `ten_${Math.random().toString(36).slice(2, 10)}`;
  const slug = `ns-${Math.random().toString(36).slice(2, 8)}`;
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(id, 'Iso', Date.now())
    .run();
  const nsId = newId('ns');
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, ?, 'generic', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(nsId, id, slug, Date.now())
    .run();
  const docId = newId('doc');
  await e.DB.prepare(
    `INSERT INTO documents (id, tenant_id, namespace_id, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(docId, id, nsId, Date.now())
    .run();
  const verId = newId('ver');
  await e.DB.prepare(
    `INSERT INTO document_versions
       (id, document_id, tenant_id, content_hash, source_r2_key, content_type, size_bytes, created_at)
     VALUES (?, ?, ?, 'h', 'k', 'text/plain', 1, ?)`,
  )
    .bind(verId, docId, id, Date.now())
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
    .bind(vidxId, verId, id, Date.now())
    .run();
  const jobId = newId('job');
  await e.DB.prepare(
    `INSERT INTO ingestion_jobs
       (id, tenant_id, document_id, version_id, version_index_id, mode, status,
        attempt_count, dead_lettered, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'full', 'failed', 3, 1, '{}', ?)`,
  )
    .bind(jobId, id, docId, verId, vidxId, Date.now())
    .run();
  const qevId = newId('qev');
  await e.DB.prepare(
    `INSERT INTO query_events
       (id, tenant_id, namespace_id, status, query_text, request_config,
        request_config_hash, created_at)
     VALUES (?, ?, ?, 'completed', 'q', '{}', 'h', ?)`,
  )
    .bind(qevId, id, nsId, Date.now())
    .run();
  const evsetId = newId('evset');
  await e.DB.prepare(
    `INSERT INTO eval_sets (id, tenant_id, namespace_id, name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(evsetId, id, nsId, `set-${id}`, Date.now())
    .run();
  const apiKey = await seedApiKey(e, id, scopes);
  return { id, slug, apiKey, docId, jobId, qevId, evsetId };
}

describe('Phase 8.2 — multi-tenant isolation', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM eval_results`).run();
    await e.DB.prepare(`DELETE FROM eval_runs`).run();
    await e.DB.prepare(`DELETE FROM eval_questions`).run();
    await e.DB.prepare(`DELETE FROM eval_sets`).run();
    await e.DB.prepare(`DELETE FROM query_events`).run();
    await e.DB.prepare(`DELETE FROM ingestion_jobs`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('A cannot read B namespace', async () => {
    const e = env as unknown as Env;
    const a = await seedTenant(e);
    const b = await seedTenant(e);
    const res = await callJson(
      e,
      'GET',
      `http://x/v1/namespaces/${b.slug}`,
      { 'x-textral-api-key': a.apiKey.raw },
    );
    expect(res.status).toBe(404);
  });

  it('A cannot read B document', async () => {
    const e = env as unknown as Env;
    const a = await seedTenant(e);
    const b = await seedTenant(e);
    const res = await callJson(
      e,
      'GET',
      `http://x/v1/documents/${b.docId}`,
      { 'x-textral-api-key': a.apiKey.raw },
    );
    expect(res.status).toBe(404);
  });

  it('A cannot read B ingestion job', async () => {
    const e = env as unknown as Env;
    const a = await seedTenant(e);
    const b = await seedTenant(e);
    const res = await callJson(
      e,
      'GET',
      `http://x/v1/ingestion-jobs/${b.jobId}`,
      { 'x-textral-api-key': a.apiKey.raw },
    );
    expect(res.status).toBe(404);
  });

  it('A cannot read B query event', async () => {
    const e = env as unknown as Env;
    const a = await seedTenant(e);
    const b = await seedTenant(e);
    const res = await callJson(
      e,
      'GET',
      `http://x/v1/query-events/${b.qevId}`,
      { 'x-textral-api-key': a.apiKey.raw },
    );
    expect(res.status).toBe(404);
  });

  it('A cannot retry B dead-lettered job (404 DLQ_NOT_FOUND)', async () => {
    const e = env as unknown as Env;
    const a = await seedTenant(e);
    const b = await seedTenant(e);
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

  it('A admin endpoint listing only sees A jobs', async () => {
    const e = env as unknown as Env;
    const a = await seedTenant(e);
    const b = await seedTenant(e);
    const res = await callJson(
      e,
      'GET',
      `http://x/v1/admin/ingestion-jobs?dead_lettered=1`,
      { 'x-textral-api-key': a.apiKey.raw },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; tenant_id: string }> };
    for (const j of body.items) {
      expect(j.tenant_id).toBe(a.id);
      expect(j.id).not.toBe(b.jobId);
    }
  });

  it('A bulk enrichment-runs against B namespace returns 404', async () => {
    const e = env as unknown as Env;
    const a = await seedTenant(e);
    const b = await seedTenant(e);
    const res = await callJson(
      e,
      'POST',
      `http://x/v1/admin/namespaces/${b.slug}/enrichment-runs`,
      { 'x-textral-api-key': a.apiKey.raw },
      { dry_run: true },
    );
    expect(res.status).toBe(404);
  });

  it('A cannot read B eval set', async () => {
    const e = env as unknown as Env;
    const a = await seedTenant(e);
    const b = await seedTenant(e);
    const res = await callJson(
      e,
      'GET',
      `http://x/v1/namespaces/${b.slug}/eval-sets/${b.evsetId}`,
      { 'x-textral-api-key': a.apiKey.raw },
    );
    // Even the namespace itself is 404 from A's view, so this should
    // also be 404.
    expect(res.status).toBe(404);
  });

  it('non-admin same-tenant probe returns 403 (own tenant only)', async () => {
    const e = env as unknown as Env;
    const reader = await seedTenant(e, ['read']);
    const res = await callJson(
      e,
      'POST',
      `http://x/v1/ingestion-jobs/${reader.jobId}/retry`,
      { 'x-textral-api-key': reader.apiKey.raw },
      {},
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE');
  });
});
