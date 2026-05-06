// Fuzz: post 50 randomly-generated provider-key-shaped strings to the
// dev-only /__redaction_check route and assert no sink ever observed
// the original substring.

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

const PREFIXES = ['sk-proj-', 'sk-ant-', 'sk-', 'xai-', 'r8_', 'voy-'];

function randAlnum(n: number): string {
  const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return out;
}

function randomKey(): string {
  const prefix = PREFIXES[Math.floor(Math.random() * PREFIXES.length)]!;
  // Length 32–80 chars after the prefix
  return prefix + randAlnum(32 + Math.floor(Math.random() * 48));
}

function findFragment(haystack: unknown, needle: string): boolean {
  if (haystack === null || haystack === undefined) return false;
  if (typeof haystack === 'string') return haystack.includes(needle);
  if (Array.isArray(haystack)) return haystack.some((x) => findFragment(x, needle));
  if (typeof haystack === 'object') {
    return Object.values(haystack).some((v) => findFragment(v, needle));
  }
  return false;
}

describe('redaction fuzz harness via /__redaction_check', () => {
  it('no sink leaks any of 50 random provider-key shapes', async () => {
    for (let i = 0; i < 50; i++) {
      const key = randomKey();
      const res = await callJson(
        env as unknown as Env,
        'POST',
        'http://x/__redaction_check',
        {
          'X-Provider-Key-OpenAI': key,
          'X-Echo-Header': `inline ${key}`,
        },
        { provided_key: key, body_text: `hello ${key}` },
      );
      expect(res.status).toBe(200);
      const sinks = (await res.json()) as Record<string, unknown>;
      // The "redacted_*" outputs must NOT contain the original key.
      expect(findFragment(sinks, key)).toBe(false);
    }
  });

  it('the route 404s when ENABLE_DEBUG_ROUTES=false', async () => {
    const e = env as unknown as Env & { ENABLE_DEBUG_ROUTES: string };
    const original = e.ENABLE_DEBUG_ROUTES;
    e.ENABLE_DEBUG_ROUTES = 'false';
    try {
      const res = await callJson(
        env as unknown as Env,
        'POST',
        'http://x/__redaction_check',
        {},
        { hi: 1 },
      );
      expect(res.status).toBe(404);
    } finally {
      e.ENABLE_DEBUG_ROUTES = original;
    }
  });
});
