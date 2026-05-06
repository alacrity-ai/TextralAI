// /v1/api-keys CRUD + revocation behavior.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey } from '../src/auth/api-key.js';
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

describe('/v1/api-keys', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('creates a new API key, the new key works, list returns metadata only', async () => {
    const e = env as unknown as Env;
    const seedKey = await seed(e, 'ten_alice');

    const res = await call(e, 'POST', '/v1/api-keys', seedKey.raw, { scopes: ['query'] });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; raw: string; prefix: string };
    expect(created.raw).toMatch(/^tx_live_[0-9A-HJKMNP-TV-Z]{26}_[A-Z2-7]{32}$/);
    expect(created.prefix).toBe(created.raw.slice(0, 12));

    // The new key authenticates:
    const meRes = await call(e, 'GET', '/v1/me', created.raw);
    expect(meRes.status).toBe(200);

    // List shows two keys (seed + the one we just created), neither
    // includes a `raw` field.
    const listRes = await call(e, 'GET', '/v1/api-keys', seedKey.raw);
    const list = (await listRes.json()) as { data: Array<Record<string, unknown>> };
    expect(list.data).toHaveLength(2);
    for (const item of list.data) {
      expect(item).not.toHaveProperty('raw');
      expect(item).not.toHaveProperty('hash');
    }
  });

  it('revoking a key prevents future auth via that key', async () => {
    const e = env as unknown as Env;
    const seedKey = await seed(e, 'ten_alice');

    const createRes = await call(e, 'POST', '/v1/api-keys', seedKey.raw, {});
    const created = (await createRes.json()) as { id: string; raw: string };

    // Direct revocation via D1 to sidestep the 60s KV cache window.
    await e.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`)
      .bind(Date.now(), created.id)
      .run();

    const meRes = await call(e, 'GET', '/v1/me', created.raw);
    expect(meRes.status).toBe(401);
  });

  it('cross-tenant: tenant B cannot revoke tenant A’s key — 404 not 403', async () => {
    const e = env as unknown as Env;
    const ka = await seed(e, 'ten_alice');
    const kb = await seed(e, 'ten_bob');

    // Find Alice's seeded key id directly:
    const aliceKey = await e.DB.prepare(`SELECT id FROM api_keys WHERE tenant_id = ? LIMIT 1`)
      .bind('ten_alice')
      .first<{ id: string }>();
    expect(aliceKey).toBeTruthy();

    const res = await call(e, 'DELETE', `/v1/api-keys/${aliceKey!.id}`, kb.raw);
    expect(res.status).toBe(404);
    // Reference ka so it isn't flagged unused:
    expect(ka.raw).toBeTruthy();
  });
});
