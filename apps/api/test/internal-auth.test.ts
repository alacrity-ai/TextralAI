// Internal back-channel auth — HMAC + 5-min window + replay protection.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { callJson, callWorker } from './helpers/fetch.js';
import { signInternal } from './helpers/internal-sign.js';
import type { Env } from '../src/types.js';

async function seedJob(e: Env): Promise<{ jobId: string; tenantId: string }> {
  const tenantId = `ten_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'Internal Test', Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, 'default', 'generic', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(newId('ns'), tenantId, Date.now())
    .run();
  const docId = newId('doc');
  await e.DB.prepare(
    `INSERT INTO documents (id, tenant_id, namespace_id, created_at)
     SELECT ?, ?, id, ? FROM namespaces WHERE tenant_id = ? AND slug = 'default'`,
  )
    .bind(docId, tenantId, Date.now(), tenantId)
    .run();
  const verId = newId('ver');
  await e.DB.prepare(
    `INSERT INTO document_versions (id, document_id, tenant_id, content_hash, source_r2_key,
                                     content_type, size_bytes, created_at)
     VALUES (?, ?, ?, 'fake-hash', 'fake-key', 'text/plain', 12, ?)`,
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
     VALUES (?, ?, ?, ?, ?, 'full', 'pending', 0, 0, '{}', ?)`,
  )
    .bind(jobId, tenantId, docId, verId, vidxId, Date.now())
    .run();
  return { jobId, tenantId };
}

describe('internal HMAC auth', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM ingest_stage_attempts`).run();
    await e.DB.prepare(`DELETE FROM chunks`).run();
    await e.DB.prepare(`DELETE FROM ingestion_jobs`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM upload_intents`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('rejects requests with no signature', async () => {
    const e = env as unknown as Env;
    const res = await callJson(
      e,
      'POST',
      'http://x/internal/jobs/job_x/transition',
      {},
      {
        status: 'completed',
      },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_AUTH_REQUIRED');
  });

  it('rejects requests with timestamp outside 5-min window', async () => {
    const e = env as unknown as Env;
    const secret = e.INTERNAL_HMAC_SECRET as unknown as string;
    const path = '/internal/jobs/job_x/transition';
    const body = JSON.stringify({ status: 'completed' });
    const stale = Date.now() - 10 * 60 * 1000;
    const sig = await signInternal(secret, 'POST', path, body, stale);
    const res = await callWorker(
      e,
      new Request(`http://x${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...sig },
        body,
      }),
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('INTERNAL_TIMESTAMP_OUT_OF_WINDOW');
  });

  it('rejects requests with wrong signature', async () => {
    const e = env as unknown as Env;
    const path = '/internal/jobs/job_x/transition';
    const body = JSON.stringify({ status: 'completed' });
    const ts = String(Date.now());
    const res = await callWorker(
      e,
      new Request(`http://x${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-textral-internal-timestamp': ts,
          'x-textral-internal-signature': '00'.repeat(32),
        },
        body,
      }),
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('INTERNAL_SIGNATURE_INVALID');
  });

  it('accepts a properly signed transition request', async () => {
    const e = env as unknown as Env;
    const { jobId } = await seedJob(e);
    const secret = e.INTERNAL_HMAC_SECRET as unknown as string;
    const path = `/internal/jobs/${jobId}/transition`;
    const body = JSON.stringify({ status: 'running', current_stage: 'fetch' });
    const sig = await signInternal(secret, 'POST', path, body);
    const res = await callWorker(
      e,
      new Request(`http://x${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...sig },
        body,
      }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects chunks/batch with mismatched tenant_id', async () => {
    const e = env as unknown as Env;
    const { jobId, tenantId } = await seedJob(e);
    const secret = e.INTERNAL_HMAC_SECRET as unknown as string;
    const path = `/internal/chunks/batch`;
    const body = JSON.stringify({
      job_id: jobId,
      chunks: [
        {
          id: 'chk_test_0001',
          tenant_id: 'ten_someone_else', // mismatch
          namespace_id: 'ns_x',
          document_id: 'doc_x',
          version_id: 'ver_x',
          version_index_id: 'vidx_x',
          artifact_type: 'passage',
          section_path: '/',
          ord: 0,
          text: 'hi',
          embedding_profile: 'openai-text-embedding-3-large-1536',
          chunking_profile: 'generic',
          embedding_status: 'embedded',
        },
      ],
    });
    const sig = await signInternal(secret, 'POST', path, body);
    const res = await callWorker(
      e,
      new Request(`http://x${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...sig },
        body,
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('INTERNAL_OWNERSHIP_MISMATCH');
    void tenantId;
  });

  it('accepts chunks/batch with matching ownership and writes rows', async () => {
    const e = env as unknown as Env;
    const { jobId, tenantId } = await seedJob(e);
    const job = await e.DB.prepare(`SELECT * FROM ingestion_jobs WHERE id = ?`)
      .bind(jobId)
      .first<{
        document_id: string;
        version_id: string;
        version_index_id: string;
        tenant_id: string;
      }>();
    expect(job).toBeTruthy();
    const ns = await e.DB.prepare(`SELECT id FROM namespaces WHERE tenant_id = ? LIMIT 1`)
      .bind(tenantId)
      .first<{ id: string }>();
    const secret = e.INTERNAL_HMAC_SECRET as unknown as string;
    const path = `/internal/chunks/batch`;
    const body = JSON.stringify({
      job_id: jobId,
      chunks: [
        {
          id: `chk_${job!.version_id}_00001`,
          tenant_id: job!.tenant_id,
          namespace_id: ns!.id,
          document_id: job!.document_id,
          version_id: job!.version_id,
          version_index_id: job!.version_index_id,
          artifact_type: 'passage',
          section_path: '/',
          ord: 1,
          text: 'first chunk',
          embedding_profile: 'openai-text-embedding-3-large-1536',
          chunking_profile: 'generic',
          embedding_status: 'embedded',
          embedding_input_hash: 'a'.repeat(64),
          embedding_dimensions: 1536,
        },
      ],
    });
    const sig = await signInternal(secret, 'POST', path, body);
    const res = await callWorker(
      e,
      new Request(`http://x${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...sig },
        body,
      }),
    );
    expect(res.status).toBe(200);
    const row = await e.DB.prepare(`SELECT id, embedding_status FROM chunks WHERE document_id = ?`)
      .bind(job!.document_id)
      .first<{ id: string; embedding_status: string }>();
    expect(row?.embedding_status).toBe('embedded');
  });
});
