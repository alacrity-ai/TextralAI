// /v1/namespaces CRUD coverage including cross-tenant isolation.

import { describe, it, expect, beforeEach } from 'vitest';
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

describe('/v1/namespaces', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('full CRUD lifecycle', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_alice');

    let res = await call(e, 'POST', '/v1/namespaces', k.raw, {
      slug: 'leases',
      corpus_profile: 'legal',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { slug: string; corpus_profile: string };
    expect(created.slug).toBe('leases');
    expect(created.corpus_profile).toBe('legal');

    res = await call(e, 'GET', '/v1/namespaces', k.raw);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { data: Array<{ slug: string }> };
    expect(list.data).toHaveLength(1);

    res = await call(e, 'PATCH', '/v1/namespaces/leases', k.raw, {
      default_inference_model: 'gpt-4o',
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as { default_inference_model: string };
    expect(patched.default_inference_model).toBe('gpt-4o');

    res = await call(e, 'DELETE', '/v1/namespaces/leases', k.raw);
    expect(res.status).toBe(204);

    res = await call(e, 'GET', '/v1/namespaces/leases', k.raw);
    expect(res.status).toBe(404);
  });

  it('rejects unknown corpus_profile at creation', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_alice');
    const res = await call(e, 'POST', '/v1/namespaces', k.raw, {
      slug: 'oops',
      corpus_profile: 'not-a-real-profile',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { available?: string[] } };
    };
    expect(body.error.code).toBe('UNKNOWN_CORPUS_PROFILE');
    expect(body.error.details?.available).toContain('generic');
  });

  it('rejects unknown corpus_profile on PATCH', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_alice');
    await call(e, 'POST', '/v1/namespaces', k.raw, { slug: 'leases', corpus_profile: 'legal' });
    const res = await call(e, 'PATCH', '/v1/namespaces/leases', k.raw, {
      corpus_profile: 'bogus',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNKNOWN_CORPUS_PROFILE');
  });

  it('accepts every shipped corpus_profile id', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_alice');
    for (const profile of ['generic', 'narrative', 'legal', 'support', 'technical']) {
      const res = await call(e, 'POST', '/v1/namespaces', k.raw, {
        slug: `ns-${profile}`,
        corpus_profile: profile,
      });
      expect(res.status, `${profile}`).toBe(201);
    }
  });

  it('rejects duplicate slug for the same tenant', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_alice');
    await call(e, 'POST', '/v1/namespaces', k.raw, { slug: 'leases' });
    const res = await call(e, 'POST', '/v1/namespaces', k.raw, { slug: 'leases' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NAMESPACE_ALREADY_EXISTS');
  });

  it('rejects an invalid slug shape', async () => {
    const e = env as unknown as Env;
    const k = await makeTenant(e, 'ten_alice');
    const res = await call(e, 'POST', '/v1/namespaces', k.raw, { slug: 'NotALowerSlug!' });
    expect(res.status).toBe(400);
  });

  it('isolates namespaces between tenants — tenant B cannot see tenant A', async () => {
    const e = env as unknown as Env;
    const ka = await makeTenant(e, 'ten_alice');
    const kb = await makeTenant(e, 'ten_bob');

    await call(e, 'POST', '/v1/namespaces', ka.raw, { slug: 'private' });

    // Bob's list is empty:
    let res = await call(e, 'GET', '/v1/namespaces', kb.raw);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { data: unknown[] };
    expect(list.data).toHaveLength(0);

    // Bob trying to GET alice's namespace by slug returns 404 (not 403):
    res = await call(e, 'GET', '/v1/namespaces/private', kb.raw);
    expect(res.status).toBe(404);
  });
});
