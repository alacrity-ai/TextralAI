// /v1/error-catalog — backs the textral://error-catalog MCP resource.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey } from '../src/auth/api-key.js';
import { callJson } from './helpers/fetch.js';
import { ERROR_CATALOG } from '../src/openapi/error-catalog.js';
import type { Env } from '../src/types.js';

async function seed(e: Env): Promise<{ raw: string }> {
  const pepper = e.API_KEY_PEPPER as unknown as string;
  const key = await generateApiKey(pepper);
  await e.DB.prepare(
    `INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind('ten_error_catalog', 'Error Catalog Test', Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(key.id, 'ten_error_catalog', key.hash, key.prefix, '["*"]', Date.now())
    .run();
  return key;
}

describe('/v1/error-catalog', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('401s without an API key', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', 'http://x/v1/error-catalog');
    expect(res.status).toBe(401);
  });

  it('returns every code in the catalog with http/when/recovery fields', async () => {
    const e = env as unknown as Env;
    const key = await seed(e);
    const res = await callJson(e, 'GET', 'http://x/v1/error-catalog', {
      'X-Textral-Api-Key': key.raw,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, { http: number; when: string; recovery: string }>;
    };
    const expectedCodes = Object.keys(ERROR_CATALOG);
    expect(expectedCodes.length).toBeGreaterThan(0);
    for (const code of expectedCodes) {
      expect(body.data[code], `missing ${code}`).toBeTruthy();
      expect(typeof body.data[code]!.http).toBe('number');
      expect(typeof body.data[code]!.when).toBe('string');
      expect(typeof body.data[code]!.recovery).toBe('string');
    }
  });
});
