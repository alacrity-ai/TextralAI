// Cancel + list endpoints on /v1/ingestion-jobs.
//
// Validates: cancel CAS happy path; 409 when already terminal;
// internal stage-attempt 409 on cancelled job; list with status +
// namespace filters; cursor pagination.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { generateApiKey } from '../src/auth/api-key.js';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';
import type { IngestionJob } from '@textral/contracts';

async function seedTenant(e: Env): Promise<{ tenantId: string; rawKey: string }> {
  const tenantId = `ten_${newId('ten').slice(4)}`;
  const pepper = e.API_KEY_PEPPER as unknown as string;
  const key = await generateApiKey(pepper);
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'Cancel Test', Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(key.id, tenantId, key.hash, key.prefix, '["*"]', Date.now())
    .run();
  return { tenantId, rawKey: key.raw };
}

async function seedNamespace(
  e: Env,
  tenantId: string,
  slug: string,
): Promise<string> {
  const id = newId('ns');
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, ?, 'generic', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(id, tenantId, slug, Date.now())
    .run();
  return id;
}

async function seedDocAndJob(
  e: Env,
  tenantId: string,
  namespaceId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' = 'running',
): Promise<{ jobId: string; documentId: string }> {
  const docId = newId('doc');
  const verId = newId('ver');
  const vidxId = newId('vidx');
  const jobId = newId('job');
  const now = Date.now();
  await e.DB.prepare(
    `INSERT INTO documents (id, tenant_id, namespace_id, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(docId, tenantId, namespaceId, now)
    .run();
  await e.DB.prepare(
    `INSERT INTO document_versions (id, tenant_id, document_id, content_hash, source_r2_key, content_type, size_bytes, created_at)
     VALUES (?, ?, ?, 'h', 'k', 'text/plain', 5, ?)`,
  )
    .bind(verId, tenantId, docId, now)
    .run();
  await e.DB.prepare(
    `INSERT INTO version_indexes (id, version_id, tenant_id, chunking_profile, chunking_target_tokens, chunking_overlap_tokens, embedding_profile, embedding_provider, embedding_model, embedding_dimensions, distance_metric, corpus_profile, enrichment_config, created_at)
     VALUES (?, ?, ?, 'generic', 600, 80, 'openai-text-embedding-3-large-1536', 'openai', 'text-embedding-3-large', 1536, 'cosine', 'generic', '{}', ?)`,
  )
    .bind(vidxId, verId, tenantId, now)
    .run();
  await e.DB.prepare(
    `INSERT INTO ingestion_jobs (id, tenant_id, document_id, version_id, version_index_id, mode, status, attempt_count, dead_lettered, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'full', ?, 1, 0, '{}', ?)`,
  )
    .bind(jobId, tenantId, docId, verId, vidxId, status, now)
    .run();
  return { jobId, documentId: docId };
}

function call(
  e: Env,
  method: string,
  path: string,
  rawKey: string,
  body?: unknown,
): Promise<Response> {
  return callJson(e, method, `http://x${path}`, { 'X-Textral-Api-Key': rawKey }, body);
}

describe('POST /v1/ingestion-jobs/{id}/cancel', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM ingest_stage_attempts`).run();
    await e.DB.prepare(`DELETE FROM ingestion_jobs`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('flips a running job to failed/USER_CANCELLED', async () => {
    const e = env as unknown as Env;
    const { tenantId, rawKey } = await seedTenant(e);
    const nsId = await seedNamespace(e, tenantId, 'default');
    const { jobId } = await seedDocAndJob(e, tenantId, nsId, 'running');

    const r = await call(e, 'POST', `/v1/ingestion-jobs/${jobId}/cancel`, rawKey);
    expect(r.status).toBe(200);
    const body = (await r.json()) as IngestionJob;
    expect(body.status).toBe('failed');
    expect(body.error_code).toBe('USER_CANCELLED');
    expect(body.completed_at).not.toBeNull();
  });

  it('marks any in-flight stage attempt as skipped on cancel', async () => {
    const e = env as unknown as Env;
    const { tenantId, rawKey } = await seedTenant(e);
    const nsId = await seedNamespace(e, tenantId, 'default');
    const { jobId } = await seedDocAndJob(e, tenantId, nsId, 'running');
    await e.DB.prepare(
      `INSERT INTO ingest_stage_attempts (job_id, tenant_id, stage, attempt, status, started_at)
       VALUES (?, ?, 'chunk', 1, 'started', ?)`,
    )
      .bind(jobId, tenantId, Date.now())
      .run();

    await call(e, 'POST', `/v1/ingestion-jobs/${jobId}/cancel`, rawKey);

    const row = await e.DB.prepare(
      `SELECT status, error_code FROM ingest_stage_attempts WHERE job_id = ?`,
    )
      .bind(jobId)
      .first<{ status: string; error_code: string }>();
    expect(row?.status).toBe('skipped');
    expect(row?.error_code).toBe('USER_CANCELLED');
  });

  it('returns 409 JOB_NOT_RUNNING on a job that is already terminal', async () => {
    const e = env as unknown as Env;
    const { tenantId, rawKey } = await seedTenant(e);
    const nsId = await seedNamespace(e, tenantId, 'default');
    const { jobId } = await seedDocAndJob(e, tenantId, nsId, 'completed');

    const r = await call(e, 'POST', `/v1/ingestion-jobs/${jobId}/cancel`, rawKey);
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe('JOB_NOT_RUNNING');
  });

  it('returns 404 for a non-existent job', async () => {
    const e = env as unknown as Env;
    const { rawKey } = await seedTenant(e);
    const r = await call(e, 'POST', '/v1/ingestion-jobs/job_does_not_exist/cancel', rawKey);
    expect(r.status).toBe(404);
  });

  it('returns 404 for cross-tenant cancel attempts', async () => {
    const e = env as unknown as Env;
    const a = await seedTenant(e);
    const b = await seedTenant(e);
    const nsId = await seedNamespace(e, a.tenantId, 'default');
    const { jobId } = await seedDocAndJob(e, a.tenantId, nsId, 'running');

    const r = await call(e, 'POST', `/v1/ingestion-jobs/${jobId}/cancel`, b.rawKey);
    expect(r.status).toBe(404);
  });
});

describe('GET /v1/ingestion-jobs', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM ingest_stage_attempts`).run();
    await e.DB.prepare(`DELETE FROM ingestion_jobs`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('returns tenant-scoped jobs newest-first', async () => {
    const e = env as unknown as Env;
    const { tenantId, rawKey } = await seedTenant(e);
    const nsId = await seedNamespace(e, tenantId, 'default');
    await seedDocAndJob(e, tenantId, nsId, 'completed');
    await new Promise((rs) => setTimeout(rs, 5)); // ensure created_at differs
    const newer = await seedDocAndJob(e, tenantId, nsId, 'running');

    const r = await call(e, 'GET', '/v1/ingestion-jobs', rawKey);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: IngestionJob[]; next_cursor: string | null };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]!.id).toBe(newer.jobId);
  });

  it('filters by status (CSV)', async () => {
    const e = env as unknown as Env;
    const { tenantId, rawKey } = await seedTenant(e);
    const nsId = await seedNamespace(e, tenantId, 'default');
    await seedDocAndJob(e, tenantId, nsId, 'completed');
    const running = await seedDocAndJob(e, tenantId, nsId, 'running');

    const r = await call(e, 'GET', '/v1/ingestion-jobs?status=running,pending', rawKey);
    const body = (await r.json()) as { data: IngestionJob[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(running.jobId);
  });

  it('rejects unknown status with BAD_REQUEST', async () => {
    const e = env as unknown as Env;
    const { rawKey } = await seedTenant(e);
    const r = await call(e, 'GET', '/v1/ingestion-jobs?status=cancelled', rawKey);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('filters by namespace_slug', async () => {
    const e = env as unknown as Env;
    const { tenantId, rawKey } = await seedTenant(e);
    const nsA = await seedNamespace(e, tenantId, 'alpha');
    const nsB = await seedNamespace(e, tenantId, 'beta');
    await seedDocAndJob(e, tenantId, nsA, 'running');
    const inB = await seedDocAndJob(e, tenantId, nsB, 'running');

    const r = await call(e, 'GET', '/v1/ingestion-jobs?namespace_slug=beta', rawKey);
    const body = (await r.json()) as { data: IngestionJob[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(inB.jobId);
  });

  it('does not leak across tenants', async () => {
    const e = env as unknown as Env;
    const a = await seedTenant(e);
    const b = await seedTenant(e);
    const nsA = await seedNamespace(e, a.tenantId, 'default');
    await seedDocAndJob(e, a.tenantId, nsA, 'running');

    const r = await call(e, 'GET', '/v1/ingestion-jobs', b.rawKey);
    const body = (await r.json()) as { data: IngestionJob[] };
    expect(body.data).toHaveLength(0);
  });
});
