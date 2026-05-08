// /v1/infra-keys — register / list / revoke + at-most-one-active rule.
//
// The cooperating namespace-create test confirms that picking
// `vector_backend: 'pinecone'` requires a registered infra key (via
// `INFRA_KEY_NOT_FOUND`) and succeeds once one's in place.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey } from '../src/auth/api-key.js';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';
import type { InfraKey } from '@textral/contracts';

async function seed(e: Env, tenantId: string): Promise<string> {
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

describe('/v1/infra-keys', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM infra_keys`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
    delete (e as unknown as Record<string, unknown>)['__TEST_PROVIDER_KEY_STORE__'];
  });

  it('register → list → revoke round-trip', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_alice');

    const create = await call(e, 'POST', '/v1/infra-keys', k, {
      provider: 'pinecone',
      label: 'default',
      key: 'pcsk_synthetic_value',
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as InfraKey;
    expect(created.provider).toBe('pinecone');
    expect(created.label).toBe('default');
    expect(created.id).toMatch(/^ikey_/);
    expect(created.prefix).toMatch(/^ikey_/);
    // Raw key never echoed.
    expect(JSON.stringify(created)).not.toContain('pcsk_synthetic_value');

    const list = await call(e, 'GET', '/v1/infra-keys', k);
    const body = (await list.json()) as { data: InfraKey[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(created.id);

    const del = await call(e, 'DELETE', `/v1/infra-keys/${created.id}`, k);
    expect(del.status).toBe(204);

    const after = await call(e, 'GET', '/v1/infra-keys', k);
    const afterBody = (await after.json()) as { data: InfraKey[] };
    expect(afterBody.data).toHaveLength(0);
  });

  it('rejects a duplicate active key per (tenant, provider) with 409', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_dup');

    const a = await call(e, 'POST', '/v1/infra-keys', k, {
      provider: 'pinecone',
      label: 'first',
      key: 'pcsk_first',
    });
    expect(a.status).toBe(201);

    const b = await call(e, 'POST', '/v1/infra-keys', k, {
      provider: 'pinecone',
      label: 'second',
      key: 'pcsk_second',
    });
    expect(b.status).toBe(409);
    const err = (await b.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('INFRA_KEY_ALREADY_REGISTERED');
  });

  it('revoke + re-register is allowed', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_rotate');

    const first = await call(e, 'POST', '/v1/infra-keys', k, {
      provider: 'pinecone',
      label: 'old',
      key: 'pcsk_old',
    });
    const oldId = ((await first.json()) as InfraKey).id;
    await call(e, 'DELETE', `/v1/infra-keys/${oldId}`, k);

    const second = await call(e, 'POST', '/v1/infra-keys', k, {
      provider: 'pinecone',
      label: 'new',
      key: 'pcsk_new',
    });
    expect(second.status).toBe(201);
  });

  it('does not leak across tenants', async () => {
    const e = env as unknown as Env;
    const a = await seed(e, 'ten_a');
    const b = await seed(e, 'ten_b');

    await call(e, 'POST', '/v1/infra-keys', a, {
      provider: 'pinecone',
      label: 'default',
      key: 'pcsk_a',
    });

    const list = await call(e, 'GET', '/v1/infra-keys', b);
    const body = (await list.json()) as { data: InfraKey[] };
    expect(body.data).toHaveLength(0);
  });

  it('test endpoint probes Pinecone /indexes and updates last_validated_at', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_probe');
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ indexes: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const create = await call(e, 'POST', '/v1/infra-keys', k, {
      provider: 'pinecone',
      label: 'default',
      key: 'pcsk_probe',
    });
    const id = ((await create.json()) as InfraKey).id;

    const test = await call(e, 'POST', `/v1/infra-keys/${id}/test`, k);
    expect(test.status).toBe(200);
    const body = (await test.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const after = await call(e, 'GET', '/v1/infra-keys', k);
    const list = (await after.json()) as { data: InfraKey[] };
    expect(list.data[0]!.last_validated_at).not.toBeNull();
  });

  it('test endpoint surfaces 422 with error_code on Pinecone 401', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_bad');
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":"unauth"}', { status: 401 }),
    ) as unknown as typeof globalThis.fetch;

    const create = await call(e, 'POST', '/v1/infra-keys', k, {
      provider: 'pinecone',
      label: 'default',
      key: 'pcsk_bad',
    });
    const id = ((await create.json()) as InfraKey).id;

    const test = await call(e, 'POST', `/v1/infra-keys/${id}/test`, k);
    expect(test.status).toBe(422);
    const body = (await test.json()) as {
      ok: boolean;
      error_code: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe('invalid_api_key');
  });
});

describe('namespace create with vector_backend=pinecone', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM infra_keys`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
    delete (e as unknown as Record<string, unknown>)['__TEST_PROVIDER_KEY_STORE__'];
  });

  it('rejects with INFRA_KEY_NOT_FOUND when no Pinecone key is registered', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_no_key');

    const r = await call(e, 'POST', '/v1/namespaces', k, {
      slug: 'pine-no-key',
      vector_backend: 'pinecone',
      vector_index_name: 'https://my-index-xxxxx.svc.us-east-1-aws.pinecone.io',
      default_embedding_profile: 'openai-text-embedding-3-large',
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INFRA_KEY_NOT_FOUND');
  });

  it('succeeds once a Pinecone infra key is registered (with describe_index_stats stub)', async () => {
    const e = env as unknown as Env;
    const k = await seed(e, 'ten_with_key');

    // Stub describe_index_stats — Pinecone reachability check during
    // ensureBackingExists.
    globalThis.fetch = vi.fn(
      async () => new Response('{"namespaces":{}}', { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const reg = await call(e, 'POST', '/v1/infra-keys', k, {
      provider: 'pinecone',
      label: 'default',
      key: 'pcsk_synthetic',
    });
    expect(reg.status).toBe(201);

    const create = await call(e, 'POST', '/v1/namespaces', k, {
      slug: 'pine-ok',
      vector_backend: 'pinecone',
      vector_index_name: 'https://my-index-xxxxx.svc.us-east-1-aws.pinecone.io',
      default_embedding_profile: 'openai-text-embedding-3-large',
    });
    if (create.status !== 201) {
      console.log('namespace create unexpectedly failed:', create.status, await create.text());
    }
    expect(create.status).toBe(201);
  });
});
