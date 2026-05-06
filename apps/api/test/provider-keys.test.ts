// /v1/provider-keys — register / list / delete + custody hygiene.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey } from '../src/auth/api-key.js';
import { resolveProviderKey } from '../src/auth/provider-keys.js';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

async function seed(e: Env, tenantId: string) {
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

describe('/v1/provider-keys', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM provider_keys`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
    // Reset the in-process Secrets Store stub.
    delete (e as unknown as Record<string, unknown>)['__TEST_PROVIDER_KEY_STORE__'];
  });

  it('register → list → delete round-trip', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_alice');

    const reg = await call(e, 'POST', '/v1/provider-keys', k.raw, {
      provider: 'openai',
      label: 'prod',
      key: 'sk-proj-fakefakefakefake1234567890abcd',
    });
    expect(reg.status).toBe(201);
    const meta = (await reg.json()) as { id: string; provider: string; label: string };
    expect(meta.provider).toBe('openai');
    expect(meta.label).toBe('prod');

    // List returns metadata only — no `key` or `hash` fields.
    const list = await call(e, 'GET', '/v1/provider-keys', k.raw);
    const body = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    for (const item of body.data) {
      expect(item).not.toHaveProperty('key');
      expect(item).not.toHaveProperty('hash');
      expect(item).not.toHaveProperty('secrets_store_secret_name');
    }

    // Resolver: returns the original raw key from Secrets Store.
    const resolved = await resolveProviderKey(e, 'ten_alice', 'openai', 'prod');
    expect(resolved.raw_key).toBe('sk-proj-fakefakefakefake1234567890abcd');

    // Delete.
    const del = await call(e, 'DELETE', `/v1/provider-keys/${meta.id}`, k.raw);
    expect(del.status).toBe(204);

    // Subsequent resolution must fail.
    await expect(resolveProviderKey(e, 'ten_alice', 'openai', 'prod')).rejects.toThrow();

    // List is empty.
    const list2 = await call(e, 'GET', '/v1/provider-keys', k.raw);
    const body2 = (await list2.json()) as { data: unknown[] };
    expect(body2.data).toHaveLength(0);
  });

  it('D1 row never contains the raw key column', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_alice');
    await call(e, 'POST', '/v1/provider-keys', k.raw, {
      provider: 'openai',
      label: 'prod',
      key: 'sk-proj-fake-row-inspection-12345678',
    });
    const row = await e.DB.prepare(`SELECT * FROM provider_keys WHERE tenant_id = ? AND label = ?`)
      .bind('ten_alice', 'prod')
      .first<Record<string, unknown>>();
    expect(row).toBeTruthy();
    // The raw key never appears as a column value.
    for (const v of Object.values(row!)) {
      expect(typeof v === 'string' ? v : '').not.toContain('sk-proj-fake-row-inspection');
    }
  });

  it('refuses duplicate (provider, label) for the same tenant', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_alice');
    await call(e, 'POST', '/v1/provider-keys', k.raw, {
      provider: 'openai',
      label: 'prod',
      key: 'sk-1234567890123456',
    });
    const dup = await call(e, 'POST', '/v1/provider-keys', k.raw, {
      provider: 'openai',
      label: 'prod',
      key: 'sk-9999999999999999',
    });
    expect(dup.status).toBe(409);
  });

  it('revoke + re-register under same (provider, label) succeeds', async () => {
    // Migration 0007 replaced a full-table UNIQUE with a partial
    // unique index `WHERE revoked_at IS NULL`. Without it, the second
    // POST below 500'd on the underlying constraint violation even
    // though the route's pre-check (which filters `revoked_at IS NULL`)
    // already cleared the way. This test pins the corrected
    // active-only-uniqueness shape.
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_alice');

    const create1 = await call(e, 'POST', '/v1/provider-keys', k.raw, {
      provider: 'openai',
      label: 'rotate-me',
      key: 'sk-aaaaaaaaaaaaaaaaaaaa',
    });
    expect(create1.status).toBe(201);
    const body1 = (await create1.json()) as { id: string };

    // Soft-delete the first key.
    const del = await call(
      e,
      'DELETE',
      `/v1/provider-keys/${body1.id}`,
      k.raw,
    );
    expect(del.status).toBe(204);

    // Re-registering the same (provider, label) should now succeed,
    // not 500. Returns 201 with a fresh id.
    const create2 = await call(e, 'POST', '/v1/provider-keys', k.raw, {
      provider: 'openai',
      label: 'rotate-me',
      key: 'sk-bbbbbbbbbbbbbbbbbbbb',
    });
    expect(create2.status).toBe(201);
    const body2 = (await create2.json()) as { id: string };
    expect(body2.id).not.toBe(body1.id);
  });

  it('cross-tenant isolation: tenant B cannot see tenant A keys', async () => {
    const e = env as unknown as Env;
    const ka = await seed(e, 'ten_alice');
    const kb = await seed(e, 'ten_bob');

    await call(e, 'POST', '/v1/provider-keys', ka.raw, {
      provider: 'openai',
      label: 'prod',
      key: 'sk-12345678abcdefgh',
    });

    const list = await call(e, 'GET', '/v1/provider-keys', kb.raw);
    const body = (await list.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });

  it('/test returns 404 when the row does not exist', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_alice');
    const test = await call(e, 'POST', `/v1/provider-keys/pkey_nope/test`, k.raw);
    expect(test.status).toBe(404);
    const body = (await test.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROVIDER_KEY_NOT_FOUND');
  });
});
