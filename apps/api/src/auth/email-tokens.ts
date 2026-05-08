// Email verification token primitives.
//
// 32-byte tokens generated via WebCrypto, encoded as base64url for URL
// safety, hashed with SHA-256 for at-rest storage. The cleartext only
// ever exists in the URL Mailgun delivers; the DB only sees the hash.
//
// Pattern mirrors home-app/apps/api/src/db/repos/auth.ts (token issuance
// + verification helpers) but works on the WebCrypto API only — no
// `node:crypto` import — so it runs identically on CF Workers and
// Node 24's globalThis.crypto.

import type { Env } from '../types.js';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface GeneratedToken {
  /** Cleartext, URL-safe. Lives only in the email body. */
  raw: string;
  /** SHA-256(raw) hex. The only form persisted to the DB. */
  hash: string;
}

export async function generateToken(): Promise<GeneratedToken> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const raw = base64url(bytes);
  const hash = await hashToken(raw);
  return { raw, hash };
}

/** SHA-256(raw) hex. Used at register/redeem time to look up rows by
 *  the hash without ever storing cleartext. */
export async function hashToken(raw: string): Promise<string> {
  const enc = new TextEncoder().encode(raw);
  const sig = await crypto.subtle.digest('SHA-256', enc);
  return toHex(new Uint8Array(sig));
}

export function tokenTtlMs(): number {
  return TOKEN_TTL_MS;
}

/** Build the URL the email's CTA points to.
 *
 *  In prod (`ENV === 'prod'`) `TEXTRAL_PUBLIC_BASE` is required — if
 *  it's missing, the route should refuse to issue a token rather than
 *  send an unclickable email. The thrown error is surfaced as
 *  `TENANT_REGISTRATION_DISABLED` by the route layer.
 *
 *  In dev we fall back to a localhost sandbox URL so `wrangler dev` +
 *  `pnpm dev` (sandbox) work end-to-end without env wiring. */
export function buildRedeemUrl(env: Env, token: string): string {
  const base = env.TEXTRAL_PUBLIC_BASE;
  if (base) {
    return `${stripTrailingSlash(base)}/redeem/${token}`;
  }
  if (env.ENV === 'prod') {
    throw new Error('TEXTRAL_PUBLIC_BASE is required in prod');
  }
  return `http://localhost:5173/redeem/${token}`;
}

/** True iff `now > expires_at`. The route layer's lookup path uses
 *  this to translate a found-but-expired row to TOKEN_EXPIRED. */
export function isExpired(expires_at: number, now: number = Date.now()): boolean {
  return now > expires_at;
}

// ── Encoding helpers ───────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  // btoa is available on both Workers and Node 24's globalThis.
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
