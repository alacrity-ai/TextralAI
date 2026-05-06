// /v1/mcp — embedded MCP transport. Phase 1 ships only on the Node
// runtime; the CF pool tests assert 401 without auth and 501 with
// the documented "stdio is your option here" message. End-to-end
// tools/list / tools/call coverage lives in the cookbook validator
// (tools/mcp-validator) which targets a running self-host stack.

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
    .bind('ten_mcp', 'MCP Test', Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(key.id, 'ten_mcp', key.hash, key.prefix, '["*"]', Date.now())
    .run();
  return key;
}

describe('/v1/mcp (CF runtime — Phase 1 returns 501)', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('401s when no API key is supplied', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'POST', 'http://x/v1/mcp', {}, {});
    expect(res.status).toBe(401);
  });

  it('returns 501 NOT_IMPLEMENTED on the Cloudflare runtime', async () => {
    const e = env as unknown as Env;
    const key = await seed(e);
    const res = await callJson(
      e,
      'POST',
      'http://x/v1/mcp',
      { 'X-Textral-Api-Key': key.raw },
      { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} },
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('NOT_IMPLEMENTED');
    expect(body.error?.message).toMatch(/Node-runtime-only/);
  });
});
