// API-key generation + HMAC hashing.
//
// Format:  tx_live_<26-char-ulid>_<32-char-secret>
//          tx_test_<26-char-ulid>_<32-char-secret>   (reserved)
//
// The 32-char tail is 24 random bytes encoded as base32 (no padding).
// We HMAC-SHA-256 the entire string against a server-side pepper to
// derive `key_hash`. Lookup is O(1) via D1's UNIQUE index on key_hash.
//
// Why HMAC + pepper, not argon2id (which the design doc mentioned)?
// API keys are 32+ char random strings; their entropy is far above what
// any KDF can usefully add against. HMAC + pepper is the industry
// pattern (Stripe / GitHub PAT). Per-request lookup stays sub-millisecond.

import { ulid } from 'ulidx';

const ENCODER = new TextEncoder();
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface GeneratedKey {
  /** Stored as `api_keys.id`. ULID prefixed with `ak_`. */
  id: string;
  /** The full key string. Returned to the caller exactly once. */
  raw: string;
  /** First 12 chars of `raw`, safe to store/display. */
  prefix: string;
  /** Hex HMAC-SHA-256 of `raw` under the pepper. Stored in `key_hash`. */
  hash: string;
}

export async function generateApiKey(pepper: string): Promise<GeneratedKey> {
  const u = ulid();
  // 20 random bytes → exactly 32 base32 chars (160 bits of entropy).
  // 24 bytes would yield 39 chars due to base32's 5-bit grouping.
  const secret = randomBase32(20);
  const raw = `tx_live_${u}_${secret}`;
  return {
    id: `ak_${u}`,
    raw,
    prefix: raw.slice(0, 12),
    hash: await hmacKey(pepper, raw),
  };
}

export async function hmacKey(pepper: string, raw: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', keyMaterial, ENCODER.encode(raw));
  return toHex(new Uint8Array(sig));
}

function randomBase32(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return base32(buf);
}

function base32(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function toHex(buf: Uint8Array): string {
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}
