// /v1/provider-keys/:id/test — the validation route lit up in Phase 2.8.
//
// Mocks `globalThis.fetch` to simulate upstream provider responses:
//   - 200 → ok=true, last_validated_at populated, last_error_code null.
//   - 401 → ok=false, error_code=PROVIDER_KEY_INVALID, last_error_code set.
//   - 429 + insufficient_quota → ok=false, code=PROVIDER_QUOTA_EXHAUSTED.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey } from '../src/auth/api-key.js';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

async function seed(e: Env, tenantId: string): Promise<{ raw: string; id: string }> {
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
  return { raw: key.raw, id: key.id };
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

async function registerOpenAIKey(
  e: Env,
  tenantApiKey: string,
  rawProviderKey: string,
): Promise<string> {
  const reg = await call(e, 'POST', '/v1/provider-keys', tenantApiKey, {
    provider: 'openai',
    label: 'prod',
    key: rawProviderKey,
  });
  expect(reg.status).toBe(201);
  const meta = (await reg.json()) as { id: string };
  return meta.id;
}

describe('POST /v1/provider-keys/:id/test', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM provider_keys`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
    delete (e as unknown as Record<string, unknown>)['__TEST_PROVIDER_KEY_STORE__'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok=true on a 200 embeddings response', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_alice');
    const id = await registerOpenAIKey(e, k.raw, 'sk-proj-validfakefakefakefakefakefakefake');

    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3] }],
            model: 'text-embedding-3-small',
            usage: { prompt_tokens: 1 },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await call(e, 'POST', `/v1/provider-keys/${id}/test`, k.raw);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const row = await e.DB.prepare(
      `SELECT last_validated_at, last_error_code FROM provider_keys WHERE id = ?`,
    )
      .bind(id)
      .first<{ last_validated_at: number; last_error_code: string | null }>();
    expect(row?.last_validated_at).toBeGreaterThan(0);
    expect(row?.last_error_code).toBeNull();
  });

  it('returns 422 with PROVIDER_KEY_INVALID on a 401', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_alice');
    const id = await registerOpenAIKey(e, k.raw, 'sk-proj-fakebadbadbadbadbadbadbadbadbad');

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad' } }), {
        status: 401,
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await call(e, 'POST', `/v1/provider-keys/${id}/test`, k.raw);
    expect(r.status).toBe(422);
    const body = (await r.json()) as { ok: boolean; error_code: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe('PROVIDER_KEY_INVALID');

    const row = await e.DB.prepare(
      `SELECT last_validated_at, last_error_code FROM provider_keys WHERE id = ?`,
    )
      .bind(id)
      .first<{ last_validated_at: number; last_error_code: string | null }>();
    expect(row?.last_error_code).toBe('PROVIDER_KEY_INVALID');
  });

  it('returns 422 with PROVIDER_QUOTA_EXHAUSTED on a 429+insufficient_quota', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_alice');
    const id = await registerOpenAIKey(e, k.raw, 'sk-proj-fakequotaquotaquotaquotaquotaquota');

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'insufficient_quota',
            message: 'You exceeded your current quota.',
          },
        }),
        { status: 429 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await call(e, 'POST', `/v1/provider-keys/${id}/test`, k.raw);
    expect(r.status).toBe(422);
    const body = (await r.json()) as { ok: boolean; error_code: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe('PROVIDER_QUOTA_EXHAUSTED');
  });

  it('cross-tenant isolation: tenant B cannot test tenant A’s key', async () => {
    const e = env as unknown as Env;
    const ka = await seed(e, 'ten_alice');
    const kb = await seed(e, 'ten_bob');
    const id = await registerOpenAIKey(e, ka.raw, 'sk-proj-fakeAAAAAAAAAAAAAAAAAAAAAAAA');

    const r = await call(e, 'POST', `/v1/provider-keys/${id}/test`, kb.raw);
    expect(r.status).toBe(404);
  });

  it('workers_ai key always returns ok=true (no key to validate)', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_alice');
    const reg = await call(e, 'POST', '/v1/provider-keys', k.raw, {
      provider: 'workers_ai',
      label: 'binding',
      key: 'workers-ai-no-key-needed-but-required-by-schema',
    });
    expect(reg.status).toBe(201);
    const { id } = (await reg.json()) as { id: string };

    const r = await call(e, 'POST', `/v1/provider-keys/${id}/test`, k.raw);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
