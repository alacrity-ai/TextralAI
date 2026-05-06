// /v1/profiles — corpus profile registry endpoint backing the
// textral://profiles MCP resource.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey } from '../src/auth/api-key.js';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

async function seed(e: Env): Promise<{ raw: string }> {
  const pepper = e.API_KEY_PEPPER as unknown as string;
  const key = await generateApiKey(pepper);
  await e.DB.prepare(
    `INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind('ten_profiles', 'Profiles Test', Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(key.id, 'ten_profiles', key.hash, key.prefix, '["*"]', Date.now())
    .run();
  return key;
}

describe('/v1/profiles', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('401s without an API key', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', 'http://x/v1/profiles');
    expect(res.status).toBe(401);
  });

  it('returns the corpus profile registry', async () => {
    const e = env as unknown as Env;
    const key = await seed(e);
    const res = await callJson(e, 'GET', 'http://x/v1/profiles', {
      'X-Textral-Api-Key': key.raw,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; chunking: unknown; enrichment: unknown }>;
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    const ids = body.data.map((p) => p.id);
    expect(ids).toContain('generic');
    for (const profile of body.data) {
      expect(profile.chunking).toBeTruthy();
      expect(profile.enrichment).toBeTruthy();
    }
  });
});
