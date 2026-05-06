// Documents route — register, presign, finalize, ingest dispatch.
//
// Covers Phase 3.2 + 3.3 happy path + dedup. The R2 + D1 round-trip
// runs against the local Miniflare bindings.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey } from '../src/auth/api-key.js';
import { newId } from '@textral/contracts';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

async function seedTenantWithKey(e: Env): Promise<{ tenantId: string; rawKey: string }> {
  const tenantId = `ten_${newId('ten').slice(4)}`;
  const pepper = e.API_KEY_PEPPER as unknown as string;
  const key = await generateApiKey(pepper);
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'Doc Test', Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(key.id, tenantId, key.hash, key.prefix, '["*"]', Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, 'default', 'generic', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(newId('ns'), tenantId, Date.now())
    .run();
  await e.DB.prepare(
    `INSERT OR IGNORE INTO provider_keys (id, tenant_id, provider, label, secrets_store_secret_name, created_at)
     VALUES (?, ?, 'openai', 'prod', ?, ?)`,
  )
    .bind(newId('pkey'), tenantId, `pkey-${tenantId}-openai-prod`, Date.now())
    .run();
  return { tenantId, rawKey: key.raw };
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

describe('documents — register + presign + finalize', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM ingest_stage_attempts`).run();
    await e.DB.prepare(`DELETE FROM chunks`).run();
    await e.DB.prepare(`DELETE FROM ingestion_jobs`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM upload_intents`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM provider_keys`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('round-trip: register → presign → upload → finalize', async () => {
    const e = env as unknown as Env;
    const { rawKey } = await seedTenantWithKey(e);

    const reg = await call(e, 'POST', '/v1/namespaces/default/documents', rawKey, {
      title: 'smoke',
    });
    expect(reg.status).toBe(201);
    const doc = (await reg.json()) as { id: string };

    // Presign.
    const upload = await call(e, 'POST', `/v1/documents/${doc.id}/uploads`, rawKey, {
      content_type: 'text/plain',
      size_bytes: 12,
    });
    expect(upload.status).toBe(200);
    const presigned = (await upload.json()) as { upload_id: string; key: string };

    // Simulate the upload by writing directly to R2 with the matching
    // metadata (Miniflare R2 doesn't enforce presign URL semantics).
    await e.BLOBS.put(presigned.key, new TextEncoder().encode('hello world!'), {
      httpMetadata: { contentType: 'text/plain' },
    });

    // Finalize.
    const finalize = await call(
      e,
      'POST',
      `/v1/documents/${doc.id}/uploads/${presigned.upload_id}/finalize`,
      rawKey,
    );
    expect(finalize.status).toBe(201);
    const fb = (await finalize.json()) as {
      version_id: string;
      content_hash: string;
      deduplicated: boolean;
    };
    expect(fb.version_id).toMatch(/^ver_/);
    expect(fb.content_hash).toHaveLength(64);
    expect(fb.deduplicated).toBe(false);
  });

  it('finalize is idempotent — same bytes returns existing version_id', async () => {
    const e = env as unknown as Env;
    const { rawKey } = await seedTenantWithKey(e);
    const reg = await call(e, 'POST', '/v1/namespaces/default/documents', rawKey, {
      title: 't',
    });
    const doc = (await reg.json()) as { id: string };

    // Round 1.
    const u1 = await call(e, 'POST', `/v1/documents/${doc.id}/uploads`, rawKey, {
      content_type: 'text/plain',
      size_bytes: 5,
    });
    const p1 = (await u1.json()) as { upload_id: string; key: string };
    await e.BLOBS.put(p1.key, new TextEncoder().encode('hello'), {
      httpMetadata: { contentType: 'text/plain' },
    });
    const f1 = await call(
      e,
      'POST',
      `/v1/documents/${doc.id}/uploads/${p1.upload_id}/finalize`,
      rawKey,
    );
    const fb1 = (await f1.json()) as { version_id: string; deduplicated: boolean };
    expect(fb1.deduplicated).toBe(false);

    // Round 2 — different upload, same bytes.
    const u2 = await call(e, 'POST', `/v1/documents/${doc.id}/uploads`, rawKey, {
      content_type: 'text/plain',
      size_bytes: 5,
    });
    const p2 = (await u2.json()) as { upload_id: string; key: string };
    await e.BLOBS.put(p2.key, new TextEncoder().encode('hello'), {
      httpMetadata: { contentType: 'text/plain' },
    });
    const f2 = await call(
      e,
      'POST',
      `/v1/documents/${doc.id}/uploads/${p2.upload_id}/finalize`,
      rawKey,
    );
    const fb2 = (await f2.json()) as { version_id: string; deduplicated: boolean };
    expect(fb2.deduplicated).toBe(true);
    expect(fb2.version_id).toBe(fb1.version_id);
  });

  it('rejects size mismatch at finalize', async () => {
    const e = env as unknown as Env;
    const { rawKey } = await seedTenantWithKey(e);
    const reg = await call(e, 'POST', '/v1/namespaces/default/documents', rawKey, {});
    const doc = (await reg.json()) as { id: string };

    const u = await call(e, 'POST', `/v1/documents/${doc.id}/uploads`, rawKey, {
      content_type: 'text/plain',
      size_bytes: 100, // declared 100
    });
    const p = (await u.json()) as { upload_id: string; key: string };
    // But upload only 5 bytes.
    await e.BLOBS.put(p.key, new TextEncoder().encode('hello'), {
      httpMetadata: { contentType: 'text/plain' },
    });
    const f = await call(
      e,
      'POST',
      `/v1/documents/${doc.id}/uploads/${p.upload_id}/finalize`,
      rawKey,
    );
    expect(f.status).toBe(400);
    const fb = (await f.json()) as { error: { code: string } };
    expect(fb.error.code).toBe('UPLOAD_VALIDATION_FAILED');
  });

  it('cross-tenant: tenant B cannot finalize tenant A upload', async () => {
    const e = env as unknown as Env;
    const a = await seedTenantWithKey(e);
    const b = await seedTenantWithKey(e);
    const reg = await call(e, 'POST', '/v1/namespaces/default/documents', a.rawKey, {});
    const doc = (await reg.json()) as { id: string };
    const u = await call(e, 'POST', `/v1/documents/${doc.id}/uploads`, a.rawKey, {
      content_type: 'text/plain',
      size_bytes: 5,
    });
    const p = (await u.json()) as { upload_id: string; key: string };
    await e.BLOBS.put(p.key, new TextEncoder().encode('hello'));

    const f = await call(
      e,
      'POST',
      `/v1/documents/${doc.id}/uploads/${p.upload_id}/finalize`,
      b.rawKey,
    );
    expect(f.status).toBe(404);
  });
});

describe('documents — ingest dispatch', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM ingest_stage_attempts`).run();
    await e.DB.prepare(`DELETE FROM chunks`).run();
    await e.DB.prepare(`DELETE FROM ingestion_jobs`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM upload_intents`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM provider_keys`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  async function seedDocAndVersion(
    e: Env,
  ): Promise<{ rawKey: string; tenantId: string; documentId: string; versionId: string }> {
    const { tenantId, rawKey } = await seedTenantWithKey(e);
    const reg = await call(e, 'POST', '/v1/namespaces/default/documents', rawKey, {});
    const doc = (await reg.json()) as { id: string };
    const u = await call(e, 'POST', `/v1/documents/${doc.id}/uploads`, rawKey, {
      content_type: 'text/plain',
      size_bytes: 5,
    });
    const p = (await u.json()) as { upload_id: string; key: string };
    await e.BLOBS.put(p.key, new TextEncoder().encode('hello'), {
      httpMetadata: { contentType: 'text/plain' },
    });
    const f = await call(
      e,
      'POST',
      `/v1/documents/${doc.id}/uploads/${p.upload_id}/finalize`,
      rawKey,
    );
    const fb = (await f.json()) as { version_id: string };
    return { rawKey, tenantId, documentId: doc.id, versionId: fb.version_id };
  }

  it('dispatches a job, returns job_id, persists row with status=pending', async () => {
    const e = env as unknown as Env;
    const { rawKey, documentId, versionId, tenantId } = await seedDocAndVersion(e);

    const ing = await call(e, 'POST', `/v1/documents/${documentId}/ingest`, rawKey, {
      version_id: versionId,
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 1536,
        provider_key_ref: 'prod',
      },
    });
    expect(ing.status).toBe(202);
    const ib = (await ing.json()) as { job_id: string; version_index_id: string };
    expect(ib.job_id).toMatch(/^job_/);
    expect(ib.version_index_id).toMatch(/^vidx_/);

    const job = await e.DB.prepare(`SELECT status, config_json FROM ingestion_jobs WHERE id = ?`)
      .bind(ib.job_id)
      .first<{ status: string; config_json: string }>();
    expect(job?.status).toBe('pending');
    const config = JSON.parse(job!.config_json) as {
      embedding: { provider_key_id?: string; provider_key_ref?: string };
    };
    // provider_key_ref resolved to provider_key_id at dispatch time.
    expect(config.embedding.provider_key_id).toMatch(/^pkey_/);
    void tenantId;
  });

  it('returns 409 INGESTION_IN_PROGRESS on a second dispatch while first is pending', async () => {
    const e = env as unknown as Env;
    const { rawKey, documentId, versionId } = await seedDocAndVersion(e);
    await call(e, 'POST', `/v1/documents/${documentId}/ingest`, rawKey, {
      version_id: versionId,
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 1536,
        provider_key_ref: 'prod',
      },
    });
    const second = await call(e, 'POST', `/v1/documents/${documentId}/ingest`, rawKey, {
      version_id: versionId,
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 1536,
        provider_key_ref: 'prod',
      },
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INGESTION_IN_PROGRESS');
  });

  it('rejects when provider_key_ref does not exist', async () => {
    const e = env as unknown as Env;
    const { rawKey, documentId, versionId } = await seedDocAndVersion(e);
    const r = await call(e, 'POST', `/v1/documents/${documentId}/ingest`, rawKey, {
      version_id: versionId,
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 1536,
        provider_key_ref: 'nonexistent',
      },
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROVIDER_KEY_NOT_FOUND');
  });
});
