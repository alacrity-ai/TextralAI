// Auth middleware end-to-end via /v1/me. Exercises the full path:
// header → HMAC → D1 lookup → tenant_id population.

import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';
import { generateApiKey } from '../src/auth/api-key.js';
import type { Env } from '../src/types.js';

async function seedTenantWithKey(e: Env, tenantId: string) {
  const pepper = e.API_KEY_PEPPER as unknown as string; // see vitest.config.ts
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

describe('auth middleware', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('rejects requests with no X-Textral-Api-Key', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('http://x/v1/me'), env as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_API_KEY');
  });

  it('rejects requests with a malformed key', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('http://x/v1/me', { headers: { 'X-Textral-Api-Key': 'tx_bogus' } }),
      env as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it('resolves a valid key to its tenant', async () => {
    const e = env as unknown as Env;
    const key = await seedTenantWithKey(e, 'ten_alice');

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('http://x/v1/me', { headers: { 'X-Textral-Api-Key': key.raw } }),
      e,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenant: { id: string };
      api_key_id: string;
      runtime: 'cf' | 'node';
    };
    expect(body.tenant.id).toBe('ten_alice');
    expect(body.api_key_id).toBe(key.id);
    // CF test runtime always reports 'cf' from c.env.runtime; the
    // node-runtime self-host bindings populate 'node' equivalently.
    expect(body.runtime).toBe('cf');
  });

  it('rejects a revoked key', async () => {
    const e = env as unknown as Env;
    const key = await seedTenantWithKey(e, 'ten_bob');
    await e.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`)
      .bind(Date.now(), key.id)
      .run();

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('http://x/v1/me', { headers: { 'X-Textral-Api-Key': key.raw } }),
      e,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    // Note: the KV cache could mask this within the 60s TTL window. Since
    // each test starts with a fresh runtime, no prior cache entry exists.
    expect(res.status).toBe(401);
  });

  it('attaches a request id to every response', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('http://x/healthz'), env as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.headers.get('x-request-id')).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
