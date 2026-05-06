import { describe, it, expect } from 'vitest';
import { generateApiKey, hmacKey } from '../src/auth/api-key.js';

describe('generateApiKey', () => {
  it('returns a tx_live_<26-ulid>_<32-base32> shaped key', async () => {
    const k = await generateApiKey('p');
    expect(k.raw).toMatch(/^tx_live_[0-9A-HJKMNP-TV-Z]{26}_[A-Z2-7]{32}$/);
    expect(k.id).toMatch(/^ak_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(k.prefix).toBe(k.raw.slice(0, 12));
    expect(k.hash).toHaveLength(64); // hex sha256
  });

  it('produces unique values on each call', async () => {
    const a = await generateApiKey('p');
    const b = await generateApiKey('p');
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('hmacKey', () => {
  it('is deterministic for a given (pepper, raw) pair', async () => {
    const a = await hmacKey('pepper', 'hello');
    const b = await hmacKey('pepper', 'hello');
    expect(a).toBe(b);
  });

  it('changes when the pepper changes', async () => {
    const a = await hmacKey('pepper-1', 'hello');
    const b = await hmacKey('pepper-2', 'hello');
    expect(a).not.toBe(b);
  });

  it('changes when the raw key changes', async () => {
    const a = await hmacKey('pepper', 'hello-1');
    const b = await hmacKey('pepper', 'hello-2');
    expect(a).not.toBe(b);
  });
});
