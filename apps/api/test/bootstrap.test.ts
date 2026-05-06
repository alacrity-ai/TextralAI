// /v1/admin/bootstrap — token gate + idempotency.

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

const TOKEN = 'test-bootstrap-token';

beforeAll(() => {
  // Inject the bootstrap token via the test env. Vitest-pool-workers
  // exposes `env` as the bound runtime env; setting a property here
  // surfaces it through c.env in the worker.
  (env as unknown as Env).ADMIN_BOOTSTRAP_TOKEN = TOKEN;
});

function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return callJson(env as unknown as Env, method, `http://x${path}`, headers, body);
}

describe('/v1/admin/bootstrap', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('rejects without the bootstrap token', async () => {
    const res = await call(
      'POST',
      '/v1/admin/bootstrap',
      {},
      {
        tenant_display_name: 'A',
        namespace_slug: 'default',
      },
    );
    expect(res.status).toBe(401);
  });

  it('rejects with a wrong token', async () => {
    const res = await call(
      'POST',
      '/v1/admin/bootstrap',
      { 'X-Admin-Bootstrap-Token': 'nope' },
      { tenant_display_name: 'A', namespace_slug: 'default' },
    );
    expect(res.status).toBe(401);
  });

  it('creates tenant + namespace + api key on first run', async () => {
    const res = await call(
      'POST',
      '/v1/admin/bootstrap',
      { 'X-Admin-Bootstrap-Token': TOKEN },
      { tenant_display_name: 'Dev Tenant', namespace_slug: 'default' },
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      tenant: { id: string; display_name: string };
      namespace: { id: string; slug: string };
      api_key: { id: string; raw: string };
    };
    expect(out.tenant.display_name).toBe('Dev Tenant');
    expect(out.namespace.slug).toBe('default');
    expect(out.api_key.raw).toMatch(/^tx_live_/);
  });

  it('is idempotent on (display_name, slug); always issues a new api key', async () => {
    const first = await call(
      'POST',
      '/v1/admin/bootstrap',
      { 'X-Admin-Bootstrap-Token': TOKEN },
      { tenant_display_name: 'Dev Tenant', namespace_slug: 'default' },
    );
    const a = (await first.json()) as {
      tenant: { id: string };
      namespace: { id: string };
      api_key: { id: string; raw: string };
    };

    const second = await call(
      'POST',
      '/v1/admin/bootstrap',
      { 'X-Admin-Bootstrap-Token': TOKEN },
      { tenant_display_name: 'Dev Tenant', namespace_slug: 'default' },
    );
    const b = (await second.json()) as {
      tenant: { id: string };
      namespace: { id: string };
      api_key: { id: string; raw: string };
    };

    expect(b.tenant.id).toBe(a.tenant.id);
    expect(b.namespace.id).toBe(a.namespace.id);
    expect(b.api_key.id).not.toBe(a.api_key.id);
    expect(b.api_key.raw).not.toBe(a.api_key.raw);
  });
});
