// /v1/chunks/{id} — single-chunk read.

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
  documentId: string;
  versionId: string;
  versionIndexId: string;
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

  // Document + version + version_index — chunks reference all three.
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
        embedding_dimensions, distance_metric, corpus_profile, enrichment_config, created_at)
     VALUES (?, ?, ?, 'generic', 600, 80, 'openai-text-embedding-3-large-1536',
             'openai', 'text-embedding-3-large', 1536, 'cosine', 'generic', '{}', ?)`,
  )
    .bind(vidxId, verId, tenantId, Date.now())
    .run();

  return {
    tenantId,
    rawKey: key.raw,
    namespaceId: nsId,
    documentId: docId,
    versionId: verId,
    versionIndexId: vidxId,
  };
}

interface SeedChunkOpts {
  tenant: SeededTenant;
  ord?: number;
  text?: string;
  section_path?: string | null;
  artifact_type?: string;
  metadata?: Record<string, unknown> | null;
}

async function seedChunk(e: Env, opts: SeedChunkOpts): Promise<string> {
  const id = `chk_${opts.tenant.versionId}_${String(opts.ord ?? 0).padStart(5, '0')}`;
  await e.DB.prepare(
    `INSERT INTO chunks
       (id, tenant_id, namespace_id, document_id, version_id, version_index_id,
        artifact_type, section_path, ord, text, metadata,
        embedding_profile, chunking_profile, embedding_status,
        embedding_dimensions, vector_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.tenant.tenantId,
      opts.tenant.namespaceId,
      opts.tenant.documentId,
      opts.tenant.versionId,
      opts.tenant.versionIndexId,
      opts.artifact_type ?? 'passage',
      opts.section_path ?? null,
      opts.ord ?? 0,
      opts.text ?? 'Eratosthenes computed Earth circumference at 250,000 stadia.',
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      'openai-text-embedding-3-large-1536',
      'generic',
      'embedded',
      1536,
      id,
      Date.now(),
    )
    .run();
  return id;
}

function call(e: Env, rawKey: string, id: string): Promise<Response> {
  return callJson(e, 'GET', `http://x/v1/chunks/${id}`, {
    'X-Textral-Api-Key': rawKey,
  });
}

interface ChunkResponse {
  id: string;
  tenant_id: string;
  namespace_id: string;
  document_id: string;
  version_id: string;
  version_index_id: string;
  artifact_type: string;
  section_path: string | null;
  ord: number;
  text: string;
  metadata: Record<string, unknown> | null;
  embedding_profile: string;
  chunking_profile: string;
  embedding_status: 'pending' | 'embedded' | 'missing';
  embedding_dimensions: number | null;
  parent_chunk_id: string | null;
  enrichment_pass_id: string | null;
  created_at: number;
}

describe('GET /v1/chunks/{id}', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM chunks`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('returns the chunk DTO with text + section path + embedding metadata', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'happy');
    const id = await seedChunk(e, {
      tenant: t,
      ord: 2,
      section_path: 'Book III · §2',
      text: 'The circumference of the Earth is approximately 250,000 stadia.',
    });

    const res = await call(e, t.rawKey, id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChunkResponse;
    expect(body.id).toBe(id);
    expect(body.tenant_id).toBe(t.tenantId);
    expect(body.namespace_id).toBe(t.namespaceId);
    expect(body.document_id).toBe(t.documentId);
    expect(body.version_id).toBe(t.versionId);
    expect(body.version_index_id).toBe(t.versionIndexId);
    expect(body.artifact_type).toBe('passage');
    expect(body.section_path).toBe('Book III · §2');
    expect(body.ord).toBe(2);
    expect(body.text).toBe(
      'The circumference of the Earth is approximately 250,000 stadia.',
    );
    expect(body.embedding_profile).toBe('openai-text-embedding-3-large-1536');
    expect(body.chunking_profile).toBe('generic');
    expect(body.embedding_status).toBe('embedded');
    expect(body.embedding_dimensions).toBe(1536);
  });

  it('hydrates metadata JSON column to an object', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'meta');
    const id = await seedChunk(e, {
      tenant: t,
      ord: 0,
      metadata: { authors: ['Eratosthenes'], lang: 'el', heading_depth: 2 },
    });
    const res = await call(e, t.rawKey, id);
    const body = (await res.json()) as ChunkResponse;
    expect(body.metadata).toEqual({
      authors: ['Eratosthenes'],
      lang: 'el',
      heading_depth: 2,
    });
  });

  it('returns null metadata when the column is null', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'no-meta');
    const id = await seedChunk(e, { tenant: t, ord: 0, metadata: null });
    const res = await call(e, t.rawKey, id);
    const body = (await res.json()) as ChunkResponse;
    expect(body.metadata).toBeNull();
  });

  it('returns 404 when the id does not exist', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'missing');
    const res = await call(e, t.rawKey, 'chk_does_not_exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('cross-tenant isolation: tenant B receives 404, never the chunk', async () => {
    const e = env as unknown as Env;
    const tA = await seedTenant(e, 'iso-a');
    const tB = await seedTenant(e, 'iso-b');
    const id = await seedChunk(e, { tenant: tA, ord: 0, text: 'A-only' });

    const aRes = await call(e, tA.rawKey, id);
    expect(aRes.status).toBe(200);

    const bRes = await call(e, tB.rawKey, id);
    expect(bRes.status).toBe(404);
    const body = (await bRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('rejects unauthenticated access (401)', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', 'http://x/v1/chunks/chk_anything');
    expect(res.status).toBe(401);
  });
});
