import { describe, it, expect } from 'vitest';
import {
  buildRedeemUrl,
  generateToken,
  hashToken,
  isExpired,
  tokenTtlMs,
} from '../src/auth/email-tokens.js';
import type { Env } from '../src/types.js';

describe('generateToken', () => {
  it('returns a base64url-shaped token + matching sha256 hash', async () => {
    const t = await generateToken();
    // base64url alphabet: A-Z a-z 0-9 - _ ; no padding
    expect(t.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars.
    expect(t.raw).toHaveLength(43);
    // sha256 hex
    expect(t.hash).toHaveLength(64);
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);

    // The hash is reproducible from raw.
    const rehash = await hashToken(t.raw);
    expect(rehash).toBe(t.hash);
  });

  it('produces unique values across many draws', async () => {
    // 1k draws is enough; full collision resistance is asserted by
    // the 256-bit entropy itself, not testable here.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const t = await generateToken();
      expect(seen.has(t.raw)).toBe(false);
      seen.add(t.raw);
    }
    expect(seen.size).toBe(1000);
  });
});

describe('hashToken', () => {
  it('is deterministic', async () => {
    const a = await hashToken('hello');
    const b = await hashToken('hello');
    expect(a).toBe(b);
  });

  it('changes when input changes', async () => {
    const a = await hashToken('hello');
    const b = await hashToken('world');
    expect(a).not.toBe(b);
  });
});

describe('tokenTtlMs', () => {
  it('is exactly one hour', () => {
    expect(tokenTtlMs()).toBe(60 * 60 * 1000);
  });
});

describe('buildRedeemUrl', () => {
  it('uses TEXTRAL_PUBLIC_BASE when set', () => {
    const env = { ENV: 'prod', TEXTRAL_PUBLIC_BASE: 'https://textral.example.com' } as Env;
    expect(buildRedeemUrl(env, 'tok123')).toBe('https://textral.example.com/redeem/tok123');
  });

  it('strips a trailing slash from the base', () => {
    const env = { ENV: 'prod', TEXTRAL_PUBLIC_BASE: 'https://textral.example.com/' } as Env;
    expect(buildRedeemUrl(env, 't')).toBe('https://textral.example.com/redeem/t');
  });

  it('throws in prod when TEXTRAL_PUBLIC_BASE is missing', () => {
    const env = { ENV: 'prod' } as Env;
    expect(() => buildRedeemUrl(env, 't')).toThrow(/TEXTRAL_PUBLIC_BASE/);
  });

  it('falls back to localhost in dev when TEXTRAL_PUBLIC_BASE is missing', () => {
    const env = { ENV: 'dev' } as Env;
    expect(buildRedeemUrl(env, 't')).toBe('http://localhost:5173/redeem/t');
  });
});

describe('isExpired', () => {
  it('is true when now > expires_at', () => {
    expect(isExpired(100, 200)).toBe(true);
  });
  it('is false when now <= expires_at', () => {
    expect(isExpired(200, 100)).toBe(false);
    expect(isExpired(200, 200)).toBe(false);
  });
});
