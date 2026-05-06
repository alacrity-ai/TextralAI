// Phase 6.8 — bulk enrichment-only admin endpoint.
//
// Covers: scope check, dry-run preview, real enqueue (jobs row + queue
// post), filter by profile_id, rate-limit at 10/min/tenant.

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
  return { id, raw };
}

async function seedTenantNamespaceAndIndexes(
  e: Env,
  opts: { profile: string; statuses: ('ready' | 'partial' | 'building')[] },
): Promise<{ tenantId: string; slug: string; apiKey: ApiKey; vidxIds: string[] }> {
  const tenantId = `ten_${Math.random().toString(36).slice(2, 10)}`;
  const slug = `ns-${Math.random().toString(36).slice(2, 8)}`;
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'Bulk Test', Date.now())
    .run();
  const nsId = newId('ns');
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, ?, ?, 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(nsId, tenantId, slug, opts.profile, Date.now())
    .run();

  const vidxIds: string[] = [];
  for (let i = 0; i < opts.statuses.length; i++) {
    const docId = newId('doc');
    await e.DB.prepare(
      `INSERT INTO documents (id, tenant_id, namespace_id, created_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(docId, tenantId, nsId, Date.now() + i)
      .run();
    const verId = newId('ver');
    await e.DB.prepare(
      `INSERT INTO document_versions
         (id, document_id, tenant_id, content_hash, source_r2_key,
          content_type, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, 'text/plain', 1, ?)`,
    )
      .bind(verId, docId, tenantId, `hash-${i}`, `key-${i}`, Date.now() + i)
      .run();
    const vidxId = newId('vidx');
    await e.DB.prepare(
      `INSERT INTO version_indexes
         (id, version_id, tenant_id, chunking_profile, chunking_target_tokens,
          chunking_overlap_tokens, embedding_profile, embedding_provider, embedding_model,
          embedding_dimensions, distance_metric, corpus_profile, enrichment_config,
          status, created_at)
       VALUES (?, ?, ?, 'generic', 600, 80,
               'openai-text-embedding-3-large-1536', 'openai', 'text-embedding-3-large',
               1536, 'cosine', ?, '{}', ?, ?)`,
    )
      .bind(vidxId, verId, tenantId, opts.profile, opts.statuses[i]!, Date.now() + i)
      .run();
    vidxIds.push(vidxId);
  }

  const apiKey = await seedApiKey(e, tenantId, ['admin']);
  return { tenantId, slug, apiKey, vidxIds };
}

describe('Phase 6.8 — bulk enrichment-only admin', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM ingestion_jobs`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
    await e.DB.prepare(`DELETE FROM admin_rate_limits`).run();
  });

  it('dry-run reports matched count without enqueuing', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantNamespaceAndIndexes(e, {
      profile: 'narrative',
      statuses: ['ready', 'partial', 'building'],
    });
    const res = await callJson(
      e,
      'POST',
      `http://x/v1/admin/namespaces/${seed.slug}/enrichment-runs`,
      { 'x-textral-api-key': seed.apiKey.raw },
      { dry_run: true },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: number; enqueued: number; dry_run: boolean };
    // ready + partial = 2; building excluded.
    expect(body.matched).toBe(2);
    expect(body.enqueued).toBe(0);
    expect(body.dry_run).toBe(true);

    const jobs = await e.DB.prepare(
      `SELECT COUNT(*) AS c FROM ingestion_jobs WHERE tenant_id = ?`,
    )
      .bind(seed.tenantId)
      .first<{ c: number }>();
    expect(jobs?.c).toBe(0);
  });

  it('real run enqueues enrichment_only jobs for matched indexes', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantNamespaceAndIndexes(e, {
      profile: 'narrative',
      statuses: ['ready', 'partial'],
    });
    const res = await callJson(
      e,
      'POST',
      `http://x/v1/admin/namespaces/${seed.slug}/enrichment-runs`,
      { 'x-textral-api-key': seed.apiKey.raw },
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: number; enqueued: number };
    expect(body.matched).toBe(2);
    expect(body.enqueued).toBe(2);

    const jobs = await e.DB.prepare(
      `SELECT mode, status FROM ingestion_jobs WHERE tenant_id = ? ORDER BY created_at ASC`,
    )
      .bind(seed.tenantId)
      .all<{ mode: string; status: string }>();
    expect(jobs.results).toHaveLength(2);
    for (const r of jobs.results ?? []) {
      expect(r.mode).toBe('enrichment_only');
      expect(r.status).toBe('pending');
    }
  });

  it('filter by profile_id selects only matching indexes', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantNamespaceAndIndexes(e, {
      profile: 'narrative',
      statuses: ['ready'],
    });
    // Filter to a non-existent profile.
    const res = await callJson(
      e,
      'POST',
      `http://x/v1/admin/namespaces/${seed.slug}/enrichment-runs`,
      { 'x-textral-api-key': seed.apiKey.raw },
      { dry_run: true, filter: { profile_id: 'legal' } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: number };
    expect(body.matched).toBe(0);
  });

  it('rejects non-admin scope with 403', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantNamespaceAndIndexes(e, {
      profile: 'narrative',
      statuses: ['ready'],
    });
    const nonAdmin = await seedApiKey(e, seed.tenantId, ['read']);
    const res = await callJson(
      e,
      'POST',
      `http://x/v1/admin/namespaces/${seed.slug}/enrichment-runs`,
      { 'x-textral-api-key': nonAdmin.raw },
      { dry_run: true },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('returns 404 NAMESPACE_NOT_FOUND when slug does not exist', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantNamespaceAndIndexes(e, {
      profile: 'narrative',
      statuses: ['ready'],
    });
    const res = await callJson(
      e,
      'POST',
      `http://x/v1/admin/namespaces/does-not-exist/enrichment-runs`,
      { 'x-textral-api-key': seed.apiKey.raw },
      { dry_run: true },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NAMESPACE_NOT_FOUND');
  });

  it('rate-limits at 10/min/tenant', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantNamespaceAndIndexes(e, {
      profile: 'narrative',
      statuses: ['ready'],
    });
    // 10 successful calls.
    for (let i = 0; i < 10; i++) {
      const res = await callJson(
        e,
        'POST',
        `http://x/v1/admin/namespaces/${seed.slug}/enrichment-runs`,
        { 'x-textral-api-key': seed.apiKey.raw },
        { dry_run: true },
      );
      expect(res.status).toBe(200);
    }
    // 11th — over the limit.
    const over = await callJson(
      e,
      'POST',
      `http://x/v1/admin/namespaces/${seed.slug}/enrichment-runs`,
      { 'x-textral-api-key': seed.apiKey.raw },
      { dry_run: true },
    );
    expect(over.status).toBe(429);
    const body = (await over.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ADMIN_RATE_LIMITED');
  });
});
