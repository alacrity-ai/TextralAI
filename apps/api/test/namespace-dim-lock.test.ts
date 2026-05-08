// Namespace `embedding_dimensions` invariant. Migration 0010 added an
// explicit, immutable `embedding_dimensions` column. Validation lives
// at three boundaries: namespace-create derives + locks the dim,
// namespace-create rejects a Vectorize/dim mismatch, ingest dispatch
// rejects dim != ns.embedding_dimensions.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey } from '../src/auth/api-key.js';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

/** Stub global fetch so Qdrant ensureBackingExists's reachability
 *  check (GET /collections/{name}) returns 200, short-circuiting
 *  the actual collection-create PUT. */
function stubQdrantReachable() {
  globalThis.fetch = vi.fn(
    async () => new Response('{"result":{}}', { status: 200 }),
  ) as unknown as typeof globalThis.fetch;
}

async function makeTenant(e: Env, tenantId: string): Promise<string> {
  const pepper = e.API_KEY_PEPPER as unknown as string;
  const key = await generateApiKey(pepper);
  await e.DB.prepare(
    `INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(tenantId, `Tenant ${tenantId}`, Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(key.id, tenantId, key.hash, key.prefix, '["*"]', Date.now())
    .run();
  return key.raw;
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

interface NamespaceShape {
  slug: string;
  embedding_dimensions: number;
  default_embedding_profile: string;
  vector_backend: string;
}

async function createNs(
  e: Env,
  rawKey: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const r = await call(e, 'POST', '/v1/namespaces', rawKey, body);
  return { status: r.status, json: await r.json() };
}

describe('namespace embedding_dimensions invariant', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
    (e as { QDRANT_URL?: string }).QDRANT_URL = 'http://qdrant:6333';
    stubQdrantReachable();
  });

  it('GET surfaces embedding_dimensions on every namespace shape', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_a');

    const r = await createNs(e, k, {
      slug: 'aa',
      vector_backend: 'qdrant',
      vector_index_name: 'aa-coll',
      default_embedding_profile: 'workers-bge-large-en-v1-5-1024',
    });
    expect(r.status).toBe(201);
    expect((r.json as NamespaceShape).embedding_dimensions).toBe(1024);

    const list = await call(e, 'GET', '/v1/namespaces', k);
    const body = (await list.json()) as { data: NamespaceShape[] };
    expect(body.data[0]!.embedding_dimensions).toBe(1024);
  });

  it('infers dim from default_embedding_profile when caller omits embedding_dimensions', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_b');

    // Vectorize default — bare model name resolves to 1536.
    const r1 = await createNs(e, k, {
      slug: 'oai',
      vector_backend: 'vectorize',
      default_embedding_profile: 'openai-text-embedding-3-large',
    });
    expect(r1.status).toBe(201);
    expect((r1.json as NamespaceShape).embedding_dimensions).toBe(1536);

    // Trailing -<digits> wins.
    const r2 = await createNs(e, k, {
      slug: 'qdr',
      vector_backend: 'qdrant',
      vector_index_name: 'qdr-coll',
      default_embedding_profile: 'voyage-voyage-3-1024',
    });
    expect(r2.status).toBe(201);
    expect((r2.json as NamespaceShape).embedding_dimensions).toBe(1024);
  });

  it('honors explicit embedding_dimensions when supplied', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_c');

    const r = await createNs(e, k, {
      slug: 'matryoshka',
      vector_backend: 'qdrant',
      vector_index_name: 'matryoshka-coll',
      default_embedding_profile: 'openai-text-embedding-3-large',
      embedding_dimensions: 768,
    });
    expect(r.status).toBe(201);
    expect((r.json as NamespaceShape).embedding_dimensions).toBe(768);
  });

  it('rejects Vectorize backend with non-1536 dim', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_d');

    const r = await createNs(e, k, {
      slug: 'wrong-dim',
      vector_backend: 'vectorize',
      default_embedding_profile: 'openai-text-embedding-3-large',
      embedding_dimensions: 768,
    });
    expect(r.status).toBe(400);
    const body = r.json as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('1536');
  });

  it('omits embedding_dimensions from the update shape (PATCH cannot change it)', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_e');

    const create = await createNs(e, k, {
      slug: 'locked',
      vector_backend: 'qdrant',
      vector_index_name: 'locked-coll',
      default_embedding_profile: 'workers-bge-large-en-v1-5-1024',
    });
    expect((create.json as NamespaceShape).embedding_dimensions).toBe(1024);

    // PATCH explicitly trying to set embedding_dimensions=512: the
    // update schema strips the field; the row stays at 1024.
    const patch = await call(e, 'PATCH', '/v1/namespaces/locked', k, {
      embedding_dimensions: 512,
    });
    expect(patch.status).toBe(200);

    const get = await call(e, 'GET', '/v1/namespaces/locked', k);
    const body = (await get.json()) as NamespaceShape;
    expect(body.embedding_dimensions).toBe(1024);
  });
});
