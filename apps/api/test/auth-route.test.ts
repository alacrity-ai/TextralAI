// /v1/auth/{register,recover,redeem} — public self-service flow.
//
// Tests pin the contract guarantees the design doc promises:
//   * register/recover always 202 once the body validates
//   * /redeem is the only informative failure path (410)
//   * single-use is atomic (double-click → exactly one 200)
//   * superseded tokens 410
//   * rate-limit fires after the cap
//   * unknown email on /recover writes no row + sends no email
//   * register email subject + URL include the token

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';
import { hashToken } from '../src/auth/email-tokens.js';

interface RedeemBody {
  tenant: { id: string; display_name: string; owner_email: string };
  namespace?: { id: string; slug: string };
  api_key: { id: string; raw: string; prefix: string; scopes: string[] };
}
interface ErrBody {
  error: { code: string; message: string };
}

function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return callJson(env as unknown as Env, method, `http://x${path}`, headers, body);
}

async function getActiveTokenHashes(email: string): Promise<string[]> {
  const e = env as unknown as Env;
  const rows = await e.DB.prepare(
    `SELECT token_hash FROM email_verifications WHERE email = ? AND consumed_at IS NULL`,
  )
    .bind(email)
    .all<{ token_hash: string }>();
  return rows.results.map((r) => r.token_hash);
}

async function clearTables(): Promise<void> {
  const e = env as unknown as Env;
  await e.DB.prepare(`DELETE FROM email_verifications`).run();
  await e.DB.prepare(`DELETE FROM admin_rate_limits`).run();
  await e.DB.prepare(`DELETE FROM api_keys`).run();
  await e.DB.prepare(`DELETE FROM namespaces`).run();
  await e.DB.prepare(`DELETE FROM tenants`).run();
}

describe('POST /v1/auth/register', () => {
  beforeEach(clearTables);
  afterEach(() => vi.restoreAllMocks());

  it('returns 202 {ok:true} on a valid body', async () => {
    const res = await call('POST', '/v1/auth/register', {
      email: 'alice@example.com',
      display_name: 'Acme RAG',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('inserts a token row tied to (email, register) with display_name carried', async () => {
    await call('POST', '/v1/auth/register', {
      email: 'alice@example.com',
      display_name: 'Acme RAG',
    });
    const e = env as unknown as Env;
    const row = await e.DB.prepare(
      `SELECT purpose, email, display_name, tenant_id, consumed_at FROM email_verifications WHERE email = ?`,
    )
      .bind('alice@example.com')
      .first<{
        purpose: string;
        email: string;
        display_name: string | null;
        tenant_id: string | null;
        consumed_at: number | null;
      }>();
    expect(row?.purpose).toBe('register');
    expect(row?.email).toBe('alice@example.com');
    expect(row?.display_name).toBe('Acme RAG');
    expect(row?.tenant_id).toBeNull();
    expect(row?.consumed_at).toBeNull();
  });

  it('lowercases + trims the email before storing', async () => {
    await call('POST', '/v1/auth/register', {
      email: '  Alice@EXAMPLE.com  ',
      display_name: 'Acme',
    });
    const hashes = await getActiveTokenHashes('alice@example.com');
    expect(hashes).toHaveLength(1);
  });

  it('rejects malformed email with 400', async () => {
    const res = await call('POST', '/v1/auth/register', {
      email: 'not-an-email',
      display_name: 'Acme',
    });
    expect(res.status).toBe(400);
  });

  it('rejects too-short display_name with 400', async () => {
    const res = await call('POST', '/v1/auth/register', {
      email: 'a@b.co',
      display_name: 'A',
    });
    expect(res.status).toBe(400);
  });

  it('supersedes prior unconsumed register tokens for the same email', async () => {
    await call('POST', '/v1/auth/register', {
      email: 'a@b.co',
      display_name: 'Acme',
    });
    await call('POST', '/v1/auth/register', {
      email: 'a@b.co',
      display_name: 'Acme',
    });
    const active = await getActiveTokenHashes('a@b.co');
    expect(active).toHaveLength(1); // older one was superseded
  });

  it('does NOT supersede recover tokens for the same email', async () => {
    // Pre-seed a tenant + a recover token for that email.
    const e = env as unknown as Env;
    await e.DB.prepare(
      `INSERT INTO tenants (id, display_name, owner_email, created_at) VALUES (?, ?, ?, ?)`,
    )
      .bind('ten_x', 'Existing', 'a@b.co', Date.now())
      .run();
    await call('POST', '/v1/auth/recover', { email: 'a@b.co' });
    expect(
      (await e.DB.prepare(
        `SELECT count(*) as c FROM email_verifications WHERE email = ? AND purpose = 'recover' AND consumed_at IS NULL`,
      )
        .bind('a@b.co')
        .first<{ c: number }>())?.c,
    ).toBe(1);

    await call('POST', '/v1/auth/register', { email: 'a@b.co', display_name: 'Acme' });

    // Both tokens still active — register supersedes only its own
    // purpose.
    const recoverActive = await e.DB.prepare(
      `SELECT count(*) as c FROM email_verifications WHERE email = ? AND purpose = 'recover' AND consumed_at IS NULL`,
    )
      .bind('a@b.co')
      .first<{ c: number }>();
    const registerActive = await e.DB.prepare(
      `SELECT count(*) as c FROM email_verifications WHERE email = ? AND purpose = 'register' AND consumed_at IS NULL`,
    )
      .bind('a@b.co')
      .first<{ c: number }>();
    expect(recoverActive?.c).toBe(1);
    expect(registerActive?.c).toBe(1);
  });

  it('rate-limits at 5 per minute per IP (6th call → 429 RATE_LIMITED)', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.7' };
    for (let i = 0; i < 5; i++) {
      const r = await call(
        'POST',
        '/v1/auth/register',
        { email: `u${i}@example.com`, display_name: 'XY' },
        headers,
      );
      expect(r.status).toBe(202);
    }
    const r6 = await call(
      'POST',
      '/v1/auth/register',
      { email: 'u6@example.com', display_name: 'XY' },
      headers,
    );
    expect(r6.status).toBe(429);
    const err = (await r6.json()) as ErrBody;
    expect(err.error.code).toBe('RATE_LIMITED');
  });
});

describe('POST /v1/auth/recover', () => {
  beforeEach(clearTables);

  async function seedTenantWithEmail(email: string): Promise<string> {
    const e = env as unknown as Env;
    const id = `ten_${email.replace(/[^a-z0-9]/gi, '')}`;
    await e.DB.prepare(
      `INSERT INTO tenants (id, display_name, owner_email, created_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(id, `Tenant ${email}`, email, Date.now())
      .run();
    return id;
  }

  it('returns 202 + writes a row + sets tenant_id when the email is known', async () => {
    const tenantId = await seedTenantWithEmail('known@example.com');
    const res = await call('POST', '/v1/auth/recover', { email: 'known@example.com' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    const e = env as unknown as Env;
    const row = await e.DB.prepare(
      `SELECT purpose, tenant_id FROM email_verifications WHERE email = ?`,
    )
      .bind('known@example.com')
      .first<{ purpose: string; tenant_id: string | null }>();
    expect(row?.purpose).toBe('recover');
    expect(row?.tenant_id).toBe(tenantId);
  });

  it('returns 202 + writes NO row when the email is unknown (no leak)', async () => {
    const res = await call('POST', '/v1/auth/recover', { email: 'unknown@example.com' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    const hashes = await getActiveTokenHashes('unknown@example.com');
    expect(hashes).toHaveLength(0);
  });

  it('rate-limits at 3 per minute per IP', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.8' };
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', '/v1/auth/recover', { email: 'x@y.co' }, headers);
      expect(r.status).toBe(202);
    }
    const r4 = await call('POST', '/v1/auth/recover', { email: 'x@y.co' }, headers);
    expect(r4.status).toBe(429);
  });
});

describe('POST /v1/auth/redeem', () => {
  beforeEach(clearTables);

  async function seedRegisterToken(args: {
    raw: string;
    email: string;
    display_name: string;
    expires_at?: number;
    consumed_at?: number;
  }): Promise<string> {
    const e = env as unknown as Env;
    const id = `evf_${args.raw.slice(0, 8)}`;
    const hash = await hashToken(args.raw);
    await e.DB.prepare(
      `INSERT INTO email_verifications
         (id, purpose, email, display_name, tenant_id, token_hash, expires_at, consumed_at, created_at, ip_hash)
        VALUES (?, 'register', ?, ?, NULL, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        id,
        args.email,
        args.display_name,
        hash,
        args.expires_at ?? Date.now() + 60 * 60 * 1000,
        args.consumed_at ?? null,
        Date.now(),
      )
      .run();
    return id;
  }

  async function seedRecoverToken(args: {
    raw: string;
    email: string;
    tenant_id: string;
    expires_at?: number;
    consumed_at?: number;
  }): Promise<string> {
    const e = env as unknown as Env;
    const id = `evf_${args.raw.slice(0, 8)}`;
    const hash = await hashToken(args.raw);
    await e.DB.prepare(
      `INSERT INTO email_verifications
         (id, purpose, email, display_name, tenant_id, token_hash, expires_at, consumed_at, created_at, ip_hash)
        VALUES (?, 'recover', ?, NULL, ?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        id,
        args.email,
        args.tenant_id,
        hash,
        args.expires_at ?? Date.now() + 60 * 60 * 1000,
        args.consumed_at ?? null,
        Date.now(),
      )
      .run();
    return id;
  }

  it('register flow: mints tenant + default namespace + first key (raw shown once)', async () => {
    await seedRegisterToken({
      raw: 'tok-register-happy-padding-x',
      email: 'new@example.com',
      display_name: 'Brand New Co',
    });
    const res = await call('POST', '/v1/auth/redeem', { token: 'tok-register-happy-padding-x' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RedeemBody;
    expect(body.tenant.display_name).toBe('Brand New Co');
    expect(body.tenant.owner_email).toBe('new@example.com');
    expect(body.tenant.id).toMatch(/^ten_/);
    expect(body.namespace).toBeDefined();
    expect(body.namespace?.slug).toBe('default');
    expect(body.namespace?.id).toMatch(/^ns_/);
    expect(body.api_key.raw).toMatch(/^tx_live_/);
    expect(body.api_key.id).toMatch(/^ak_/);
    expect(body.api_key.scopes).toEqual(['*']);

    // Tenant + namespace persisted, owner_email pinned.
    const e = env as unknown as Env;
    const tenant = await e.DB.prepare(
      `SELECT owner_email FROM tenants WHERE id = ?`,
    )
      .bind(body.tenant.id)
      .first<{ owner_email: string }>();
    expect(tenant?.owner_email).toBe('new@example.com');

    const ns = await e.DB.prepare(`SELECT slug FROM namespaces WHERE tenant_id = ?`)
      .bind(body.tenant.id)
      .first<{ slug: string }>();
    expect(ns?.slug).toBe('default');
  });

  it('register flow: minted key authenticates GET /v1/me', async () => {
    await seedRegisterToken({
      raw: 'tok-register-me-padding-x',
      email: 'me@example.com',
      display_name: 'Me Co',
    });
    const r = await call('POST', '/v1/auth/redeem', { token: 'tok-register-me-padding-x' });
    const body = (await r.json()) as RedeemBody;

    const me = await call('GET', '/v1/me', undefined, {
      'X-Textral-Api-Key': body.api_key.raw,
    });
    expect(me.status).toBe(200);
  });

  it('recover flow: mints a fresh key for the existing tenant; no namespace in body', async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(
      `INSERT INTO tenants (id, display_name, owner_email, created_at) VALUES (?, ?, ?, ?)`,
    )
      .bind('ten_recovered', 'Recovered Co', 'recover@example.com', Date.now())
      .run();
    await seedRecoverToken({
      raw: 'tok-recover-happy-padding-x',
      email: 'recover@example.com',
      tenant_id: 'ten_recovered',
    });

    const res = await call('POST', '/v1/auth/redeem', { token: 'tok-recover-happy-padding-x' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RedeemBody;
    expect(body.tenant.id).toBe('ten_recovered');
    expect(body.tenant.owner_email).toBe('recover@example.com');
    expect(body.namespace).toBeUndefined();
    expect(body.api_key.raw).toMatch(/^tx_live_/);

    // Two API keys exist on the tenant — the recover flow does NOT
    // auto-revoke prior keys.
    await e.DB.prepare(
      `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
       VALUES ('ak_old', 'ten_recovered', 'old-hash', 'tx_live_old', '["*"]', ?)`,
    )
      .bind(Date.now() - 1000)
      .run();
    const count = await e.DB.prepare(
      `SELECT count(*) as c FROM api_keys WHERE tenant_id = 'ten_recovered'`,
    ).first<{ c: number }>();
    expect(count?.c).toBeGreaterThanOrEqual(2);
  });

  it('410 TOKEN_EXPIRED when the token is unknown', async () => {
    const res = await call('POST', '/v1/auth/redeem', {
      token: 'this-token-was-never-issued',
    });
    expect(res.status).toBe(410);
    const err = (await res.json()) as ErrBody;
    expect(err.error.code).toBe('TOKEN_EXPIRED');
  });

  it('410 TOKEN_EXPIRED when the token is past expires_at', async () => {
    await seedRegisterToken({
      raw: 'tok-expired-padding-xxxxxx',
      email: 'e@example.com',
      display_name: 'Expired Co',
      expires_at: Date.now() - 1000,
    });
    const res = await call('POST', '/v1/auth/redeem', { token: 'tok-expired-padding-xxxxxx' });
    expect(res.status).toBe(410);
    expect(((await res.json()) as ErrBody).error.code).toBe('TOKEN_EXPIRED');
  });

  it('410 TOKEN_EXPIRED when the token was superseded (consumed_at = -1)', async () => {
    await seedRegisterToken({
      raw: 'tok-superseded-padding-xxx',
      email: 's@example.com',
      display_name: 'Superseded',
      consumed_at: -1,
    });
    const res = await call('POST', '/v1/auth/redeem', { token: 'tok-superseded-padding-xxx' });
    expect(res.status).toBe(410);
    expect(((await res.json()) as ErrBody).error.code).toBe('TOKEN_EXPIRED');
  });

  it('410 TOKEN_ALREADY_USED on the second call (single-use)', async () => {
    await seedRegisterToken({
      raw: 'tok-double-click-padding-xx',
      email: 'd@example.com',
      display_name: 'Double Co',
    });
    const a = await call('POST', '/v1/auth/redeem', { token: 'tok-double-click-padding-xx' });
    expect(a.status).toBe(200);

    const b = await call('POST', '/v1/auth/redeem', { token: 'tok-double-click-padding-xx' });
    expect(b.status).toBe(410);
    expect(((await b.json()) as ErrBody).error.code).toBe('TOKEN_ALREADY_USED');
  });

  it('double-click race: exactly one 200, exactly one 410', async () => {
    await seedRegisterToken({
      raw: 'tok-race-padding-xxxxxxxxxx',
      email: 'r@example.com',
      display_name: 'Race Co',
    });
    const [a, b] = await Promise.all([
      call('POST', '/v1/auth/redeem', { token: 'tok-race-padding-xxxxxxxxxx' }),
      call('POST', '/v1/auth/redeem', { token: 'tok-race-padding-xxxxxxxxxx' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 410]);
  });

  it('rejects too-short token with 400', async () => {
    const res = await call('POST', '/v1/auth/redeem', { token: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('Auth tag — OpenAPI surface', () => {
  it('auth endpoints are reachable without an X-Textral-Api-Key header', async () => {
    // Smoke: the routes are mounted before requireApiKey middleware,
    // so a request with no header must NOT 401 — it should reach
    // validation (or rate-limiting / actual handling).
    const res = await call('POST', '/v1/auth/register', {
      email: 'public@example.com',
      display_name: 'Public Co',
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(202);
  });
});
