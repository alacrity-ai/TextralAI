// V3 Phase 1 — pin namespace-creation behavior for the new
// per-namespace vector_backend / vector_index_name fields.
// Mirrors namespaces.test.ts conventions (cloudflare:test env,
// generateApiKey, callJson). Covers:
//   1. Default-omitted backend lands as 'vectorize'
//   2. Vectorize + vector_index_name → 400 (binding is global)
//   3. Qdrant without vector_index_name → 400
//   4. Qdrant with QDRANT_URL unset on the deploy → 400
//   5. vector_backend + vector_index_name round-trip on GET
//
// Live-deploy smoke (Step 11 of PHASE_1_IMPLEMENTATION) covers the
// happy-path Qdrant create + ensureBackingExists; this file is the
// CI-side regression net for the validation matrix.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey } from '../src/auth/api-key.js';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

async function makeTenant(e: Env, tenantId: string) {
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
  return key;
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

describe('/v1/namespaces — vector backend selection', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
    // Reset any per-test QDRANT_URL injections.
    (e as { QDRANT_URL?: string }).QDRANT_URL = '';
  });

  afterEach(() => vi.restoreAllMocks());

  it('default-omitted vector_backend lands as "vectorize"', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_default');
    const res = await call(e, 'POST', '/v1/namespaces', k.raw, {
      slug: 'default-backend',
      corpus_profile: 'generic',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { vector_backend: string; vector_index_name: string | null };
    expect(body.vector_backend).toBe('vectorize');
    expect(body.vector_index_name).toBeNull();
  });

  it('rejects vectorize + vector_index_name (binding is global)', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_vec_with_index');
    const res = await call(e, 'POST', '/v1/namespaces', k.raw, {
      slug: 'vec-bad',
      corpus_profile: 'generic',
      vector_backend: 'vectorize',
      vector_index_name: 'should-not-be-here',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toMatch(/does not accept vector_index_name/i);
  });

  it('rejects qdrant without vector_index_name', async () => {
    const e = env as unknown as Env;
    (e as { QDRANT_URL?: string }).QDRANT_URL = 'http://qdrant:6333';
    const k = await makeTenant(e, 'ten_qd_noidx');
    const res = await call(e, 'POST', '/v1/namespaces', k.raw, {
      slug: 'qd-bad',
      corpus_profile: 'generic',
      vector_backend: 'qdrant',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toMatch(/requires vector_index_name/i);
  });

  it('rejects qdrant when QDRANT_URL is unset on the deploy', async () => {
    const e = env as unknown as Env;
    // QDRANT_URL is reset to "" in beforeEach.
    const k = await makeTenant(e, 'ten_qd_no_url');
    const res = await call(e, 'POST', '/v1/namespaces', k.raw, {
      slug: 'qd-no-url',
      corpus_profile: 'generic',
      vector_backend: 'qdrant',
      vector_index_name: 'my-collection',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toMatch(/QDRANT_URL is unset/i);
  });

  it('round-trips vector_backend + vector_index_name on GET', async () => {
    const e = env as unknown as Env;
    (e as { QDRANT_URL?: string }).QDRANT_URL = 'http://qdrant:6333';
    // Stub fetch so ensureBackingExists() doesn't actually reach out.
    // GET /collections/{name} → 200 short-circuits the create path.
    globalThis.fetch = vi.fn(async () => new Response('{"result":{}}', { status: 200 })) as
      unknown as typeof globalThis.fetch;

    const k = await makeTenant(e, 'ten_qd_roundtrip');
    const create = await call(e, 'POST', '/v1/namespaces', k.raw, {
      slug: 'qd-rt',
      corpus_profile: 'generic',
      vector_backend: 'qdrant',
      vector_index_name: 'my-collection',
    });
    expect(create.status).toBe(201);

    const get = await call(e, 'GET', '/v1/namespaces/qd-rt', k.raw);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { vector_backend: string; vector_index_name: string };
    expect(body.vector_backend).toBe('qdrant');
    expect(body.vector_index_name).toBe('my-collection');
  });

  // Self-host runtime gating for `vectorize` is in
  // `routes/namespaces.ts` (V3 Phase 2 Step 14): rejects with 400
  // when `c.env.runtime === 'node'`. The cf-pool test harness
  // unconditionally rebuilds Bindings with runtime='cf' on every
  // worker.fetch call, so we can't simulate Node mode in this lane.
  // Coverage lands in the Node-side integration suite (V3 Phase 2
  // Step 21).
});
