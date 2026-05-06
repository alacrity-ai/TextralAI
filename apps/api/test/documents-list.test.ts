// /v1/namespaces/{slug}/documents (list) + /v1/documents/{id}/chunks (list).

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
  namespaceSlug: string;
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
  return { tenantId, rawKey: key.raw, namespaceId: nsId, namespaceSlug: slug };
}

interface SeedDocOpts {
  tenantId: string;
  namespaceId: string;
  createdAt: number;
  title?: string | null;
  doc_type?: string | null;
  current_version_id?: string | null;
  deleted?: boolean;
}

async function seedDoc(e: Env, opts: SeedDocOpts): Promise<string> {
  const id = newId('doc');
  await e.DB.prepare(
    `INSERT INTO documents
       (id, tenant_id, namespace_id, title, doc_type, metadata,
        current_version_id, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.tenantId,
      opts.namespaceId,
      opts.title ?? `Doc ${id.slice(0, 8)}`,
      opts.doc_type ?? 'passage',
      opts.current_version_id ?? null,
      opts.createdAt,
      opts.deleted ? Date.now() : null,
    )
    .run();
  return id;
}

interface SeedVersionAndIndexOpts {
  tenantId: string;
  documentId: string;
}

async function seedVersionAndIndex(
  e: Env,
  opts: SeedVersionAndIndexOpts,
): Promise<{ versionId: string; vidxId: string }> {
  const versionId = newId('ver');
  await e.DB.prepare(
    `INSERT INTO document_versions
       (id, document_id, tenant_id, content_hash, source_r2_key, content_type, size_bytes, created_at)
     VALUES (?, ?, ?, 'h', 'k', 'text/plain', 100, ?)`,
  )
    .bind(versionId, opts.documentId, opts.tenantId, Date.now())
    .run();
  await e.DB.prepare(`UPDATE documents SET current_version_id = ? WHERE id = ?`)
    .bind(versionId, opts.documentId)
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
    .bind(vidxId, versionId, opts.tenantId, Date.now())
    .run();
  return { versionId, vidxId };
}

interface SeedChunkOpts {
  tenant: SeededTenant;
  documentId: string;
  versionId: string;
  versionIndexId: string;
  ord: number;
  artifact_type?: string;
  text?: string;
  section_path?: string | null;
}

async function seedChunk(e: Env, opts: SeedChunkOpts): Promise<string> {
  const id = `chk_${opts.versionId}_${String(opts.ord).padStart(5, '0')}`;
  await e.DB.prepare(
    `INSERT INTO chunks
       (id, tenant_id, namespace_id, document_id, version_id, version_index_id,
        artifact_type, section_path, ord, text, metadata,
        embedding_profile, chunking_profile, embedding_status,
        embedding_dimensions, vector_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'embedded', ?, ?, ?)`,
  )
    .bind(
      id,
      opts.tenant.tenantId,
      opts.tenant.namespaceId,
      opts.documentId,
      opts.versionId,
      opts.versionIndexId,
      opts.artifact_type ?? 'passage',
      opts.section_path ?? null,
      opts.ord,
      opts.text ?? `Chunk text ${opts.ord}`,
      'openai-text-embedding-3-large-1536',
      'generic',
      1536,
      id,
      Date.now(),
    )
    .run();
  return id;
}

interface DocumentDto {
  id: string;
  namespace_id: string;
  title: string | null;
  doc_type: string | null;
  current_version_id: string | null;
  created_at: number;
}
interface ChunkDto {
  id: string;
  document_id: string;
  version_id: string;
  ord: number;
  artifact_type: string;
  text: string;
}

interface ListResponse<T> {
  data: T[];
  next_cursor: string | null;
}

async function listDocs(
  e: Env,
  rawKey: string,
  slug: string,
  query = '',
): Promise<{ status: number; body: ListResponse<DocumentDto> }> {
  const res = await callJson(e, 'GET', `http://x/v1/namespaces/${slug}/documents${query}`, {
    'X-Textral-Api-Key': rawKey,
  });
  return { status: res.status, body: (await res.json()) as ListResponse<DocumentDto> };
}

async function listChunks(
  e: Env,
  rawKey: string,
  docId: string,
  query = '',
): Promise<{ status: number; body: ListResponse<ChunkDto> }> {
  const res = await callJson(e, 'GET', `http://x/v1/documents/${docId}/chunks${query}`, {
    'X-Textral-Api-Key': rawKey,
  });
  return { status: res.status, body: (await res.json()) as ListResponse<ChunkDto> };
}

describe('GET /v1/namespaces/{slug}/documents', () => {
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

  it('returns an empty page when the namespace has no documents', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'd-empty');
    const { status, body } = await listDocs(e, t.rawKey, t.namespaceSlug);
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it('returns 404 for an unknown slug', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'd-404');
    const res = await callJson(e, 'GET', `http://x/v1/namespaces/no-such/documents`, {
      'X-Textral-Api-Key': t.rawKey,
    });
    expect(res.status).toBe(404);
  });

  it('returns documents newest-first and excludes soft-deleted rows', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'd-order');
    const t0 = 1_700_000_000_000;
    const a = await seedDoc(e, { tenantId: t.tenantId, namespaceId: t.namespaceId, createdAt: t0 + 1000 });
    const b = await seedDoc(e, { tenantId: t.tenantId, namespaceId: t.namespaceId, createdAt: t0 + 2000 });
    const _del = await seedDoc(e, {
      tenantId: t.tenantId,
      namespaceId: t.namespaceId,
      createdAt: t0 + 3000,
      deleted: true,
    });
    void _del;
    const c = await seedDoc(e, { tenantId: t.tenantId, namespaceId: t.namespaceId, createdAt: t0 + 4000 });

    const { status, body } = await listDocs(e, t.rawKey, t.namespaceSlug);
    expect(status).toBe(200);
    expect(body.data.map((d) => d.id)).toEqual([c, b, a]);
  });

  it('paginates via next_cursor', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'd-paging');
    const t0 = 1_700_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedDoc(e, {
          tenantId: t.tenantId,
          namespaceId: t.namespaceId,
          createdAt: t0 + i * 1000,
        }),
      );
    }
    const expected = [...ids].reverse();

    const p1 = (await listDocs(e, t.rawKey, t.namespaceSlug, '?limit=2')).body;
    expect(p1.data.map((d) => d.id)).toEqual(expected.slice(0, 2));
    expect(p1.next_cursor).toBeTruthy();

    const p2 = (await listDocs(e, t.rawKey, t.namespaceSlug, `?limit=2&cursor=${p1.next_cursor}`))
      .body;
    expect(p2.data.map((d) => d.id)).toEqual(expected.slice(2, 4));

    const p3 = (await listDocs(e, t.rawKey, t.namespaceSlug, `?limit=2&cursor=${p2.next_cursor}`))
      .body;
    expect(p3.data.map((d) => d.id)).toEqual(expected.slice(4));
    expect(p3.next_cursor).toBeNull();
  });

  it('cross-tenant isolation: tenant B receives 404 for tenant A namespace', async () => {
    const e = env as unknown as Env;
    const tA = await seedTenant(e, 'd-iso-a');
    const tB = await seedTenant(e, 'd-iso-b');
    await seedDoc(e, {
      tenantId: tA.tenantId,
      namespaceId: tA.namespaceId,
      createdAt: 1_700_000_001_000,
    });

    const aResp = await listDocs(e, tA.rawKey, tA.namespaceSlug);
    expect(aResp.body.data).toHaveLength(1);

    const bResp = await listDocs(e, tB.rawKey, tA.namespaceSlug);
    expect(bResp.status).toBe(404);
  });

  it('rejects unauthenticated access (401)', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', `http://x/v1/namespaces/anything/documents`);
    expect(res.status).toBe(401);
  });

  it('rejects limit > 200', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'd-limits');
    const res = await callJson(
      e,
      'GET',
      `http://x/v1/namespaces/${t.namespaceSlug}/documents?limit=201`,
      { 'X-Textral-Api-Key': t.rawKey },
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/documents/{id}/chunks', () => {
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

  it('returns an empty page when the document has no current version', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'c-noversion');
    const docId = await seedDoc(e, {
      tenantId: t.tenantId,
      namespaceId: t.namespaceId,
      createdAt: Date.now(),
    });
    const { status, body } = await listChunks(e, t.rawKey, docId);
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it('returns 404 when the document does not exist', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'c-missing');
    const { status } = await listChunks(e, t.rawKey, 'doc_does_not_exist');
    expect(status).toBe(404);
  });

  it('returns chunks ascending by ord, scoped to the current version', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'c-order');
    const docId = await seedDoc(e, {
      tenantId: t.tenantId,
      namespaceId: t.namespaceId,
      createdAt: Date.now(),
    });
    const { versionId, vidxId } = await seedVersionAndIndex(e, {
      tenantId: t.tenantId,
      documentId: docId,
    });

    // Seed in non-monotonic order to verify the ORDER BY ord asc.
    await seedChunk(e, { tenant: t, documentId: docId, versionId, versionIndexId: vidxId, ord: 2 });
    await seedChunk(e, { tenant: t, documentId: docId, versionId, versionIndexId: vidxId, ord: 0 });
    await seedChunk(e, { tenant: t, documentId: docId, versionId, versionIndexId: vidxId, ord: 1 });

    const { status, body } = await listChunks(e, t.rawKey, docId);
    expect(status).toBe(200);
    expect(body.data.map((c) => c.ord)).toEqual([0, 1, 2]);
  });

  it('paginates via next_cursor (ord-keyed)', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'c-paging');
    const docId = await seedDoc(e, {
      tenantId: t.tenantId,
      namespaceId: t.namespaceId,
      createdAt: Date.now(),
    });
    const { versionId, vidxId } = await seedVersionAndIndex(e, {
      tenantId: t.tenantId,
      documentId: docId,
    });
    for (let i = 0; i < 5; i++) {
      await seedChunk(e, { tenant: t, documentId: docId, versionId, versionIndexId: vidxId, ord: i });
    }

    const p1 = (await listChunks(e, t.rawKey, docId, '?limit=2')).body;
    expect(p1.data.map((c) => c.ord)).toEqual([0, 1]);
    expect(p1.next_cursor).toBeTruthy();

    const p2 = (await listChunks(e, t.rawKey, docId, `?limit=2&cursor=${p1.next_cursor}`)).body;
    expect(p2.data.map((c) => c.ord)).toEqual([2, 3]);

    const p3 = (await listChunks(e, t.rawKey, docId, `?limit=2&cursor=${p2.next_cursor}`)).body;
    expect(p3.data.map((c) => c.ord)).toEqual([4]);
    expect(p3.next_cursor).toBeNull();
  });

  it('filters by artifact_type', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'c-filter');
    const docId = await seedDoc(e, {
      tenantId: t.tenantId,
      namespaceId: t.namespaceId,
      createdAt: Date.now(),
    });
    const { versionId, vidxId } = await seedVersionAndIndex(e, {
      tenantId: t.tenantId,
      documentId: docId,
    });
    await seedChunk(e, {
      tenant: t,
      documentId: docId,
      versionId,
      versionIndexId: vidxId,
      ord: 0,
      artifact_type: 'passage',
    });
    await seedChunk(e, {
      tenant: t,
      documentId: docId,
      versionId,
      versionIndexId: vidxId,
      ord: 1,
      artifact_type: 'summary',
    });
    await seedChunk(e, {
      tenant: t,
      documentId: docId,
      versionId,
      versionIndexId: vidxId,
      ord: 2,
      artifact_type: 'passage',
    });

    const { body } = await listChunks(e, t.rawKey, docId, '?artifact_type=passage');
    expect(body.data.map((c) => c.ord)).toEqual([0, 2]);
    expect(body.data.every((c) => c.artifact_type === 'passage')).toBe(true);
  });

  it('cross-tenant isolation: tenant B receives 404', async () => {
    const e = env as unknown as Env;
    const tA = await seedTenant(e, 'c-iso-a');
    const tB = await seedTenant(e, 'c-iso-b');
    const docId = await seedDoc(e, {
      tenantId: tA.tenantId,
      namespaceId: tA.namespaceId,
      createdAt: Date.now(),
    });
    const { versionId, vidxId } = await seedVersionAndIndex(e, {
      tenantId: tA.tenantId,
      documentId: docId,
    });
    await seedChunk(e, { tenant: tA, documentId: docId, versionId, versionIndexId: vidxId, ord: 0 });

    const a = await listChunks(e, tA.rawKey, docId);
    expect(a.body.data).toHaveLength(1);

    const b = await listChunks(e, tB.rawKey, docId);
    expect(b.status).toBe(404);
  });

  it('rejects unauthenticated access (401)', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', `http://x/v1/documents/doc_anything/chunks`);
    expect(res.status).toBe(401);
  });
});
