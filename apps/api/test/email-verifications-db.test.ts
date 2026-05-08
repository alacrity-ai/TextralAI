// db helpers for email_verifications: insert / find / consume / supersede.
// Phase A coverage. The route-layer tests in Phase B exercise the wired flow;
// these tests pin the atomic-consume and supersession primitives the routes
// rely on.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/types.js';
import {
  consumeIfUnconsumed,
  findByTokenHash,
  insertEmailVerification,
  supersedePriorActive,
} from '../src/db/email-verifications.js';

const HOUR_MS = 60 * 60 * 1000;

describe('db/email-verifications', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM email_verifications`).run();
  });

  it('insert + findByTokenHash round-trip', async () => {
    const e = env as unknown as Env;
    await insertEmailVerification(e.db, {
      id: 'ver_1',
      purpose: 'register',
      email: 'alice@example.com',
      display_name: 'Alice Co',
      token_hash: 'h_abc',
      expires_at: Date.now() + HOUR_MS,
    });

    const row = await findByTokenHash(e.db, 'h_abc');
    expect(row).not.toBeNull();
    expect(row!.id).toBe('ver_1');
    expect(row!.purpose).toBe('register');
    expect(row!.email).toBe('alice@example.com');
    expect(row!.display_name).toBe('Alice Co');
    expect(row!.tenant_id).toBeNull();
    expect(row!.consumed_at).toBeNull();
  });

  it('findByTokenHash returns null for unknown hash', async () => {
    const e = env as unknown as Env;
    const row = await findByTokenHash(e.db, 'does_not_exist');
    expect(row).toBeNull();
  });

  it('consumeIfUnconsumed flips false on the second call (single-use)', async () => {
    const e = env as unknown as Env;
    await insertEmailVerification(e.db, {
      id: 'ver_consume',
      purpose: 'register',
      email: 'b@example.com',
      token_hash: 'h_consume',
      expires_at: Date.now() + HOUR_MS,
    });

    const first = await consumeIfUnconsumed(e.db, 'ver_consume', Date.now());
    expect(first).toBe(true);

    const second = await consumeIfUnconsumed(e.db, 'ver_consume', Date.now());
    expect(second).toBe(false);

    const row = await findByTokenHash(e.db, 'h_consume');
    expect(row!.consumed_at).not.toBeNull();
    expect(row!.consumed_at).toBeGreaterThan(0); // a real timestamp, not -1
  });

  it('supersedePriorActive marks all prior unconsumed (email, purpose) rows', async () => {
    const e = env as unknown as Env;
    const exp = Date.now() + HOUR_MS;

    // Two pending register tokens for the same email.
    await insertEmailVerification(e.db, {
      id: 'v1',
      purpose: 'register',
      email: 'c@example.com',
      token_hash: 'h1',
      expires_at: exp,
    });
    await insertEmailVerification(e.db, {
      id: 'v2',
      purpose: 'register',
      email: 'c@example.com',
      token_hash: 'h2',
      expires_at: exp,
    });
    // A different purpose for the same email — must NOT be touched.
    await insertEmailVerification(e.db, {
      id: 'v3',
      purpose: 'recover',
      email: 'c@example.com',
      token_hash: 'h3',
      expires_at: exp,
    });
    // A register token for a different email — must NOT be touched.
    await insertEmailVerification(e.db, {
      id: 'v4',
      purpose: 'register',
      email: 'other@example.com',
      token_hash: 'h4',
      expires_at: exp,
    });

    await supersedePriorActive(e.db, 'c@example.com', 'register');

    const r1 = await findByTokenHash(e.db, 'h1');
    const r2 = await findByTokenHash(e.db, 'h2');
    const r3 = await findByTokenHash(e.db, 'h3');
    const r4 = await findByTokenHash(e.db, 'h4');
    expect(r1!.consumed_at).toBe(-1);
    expect(r2!.consumed_at).toBe(-1);
    expect(r3!.consumed_at).toBeNull();
    expect(r4!.consumed_at).toBeNull();
  });

  it('superseded tokens cannot be consumed (consumeIfUnconsumed → false)', async () => {
    const e = env as unknown as Env;
    await insertEmailVerification(e.db, {
      id: 'ver_super',
      purpose: 'recover',
      email: 'd@example.com',
      token_hash: 'h_super',
      expires_at: Date.now() + HOUR_MS,
    });
    await supersedePriorActive(e.db, 'd@example.com', 'recover');

    const ok = await consumeIfUnconsumed(e.db, 'ver_super', Date.now());
    expect(ok).toBe(false);
  });

  it('UNIQUE(token_hash) rejects collision-on-insert', async () => {
    const e = env as unknown as Env;
    await insertEmailVerification(e.db, {
      id: 'ver_uniq_a',
      purpose: 'register',
      email: 'e@example.com',
      token_hash: 'h_dup',
      expires_at: Date.now() + HOUR_MS,
    });

    await expect(
      insertEmailVerification(e.db, {
        id: 'ver_uniq_b',
        purpose: 'register',
        email: 'f@example.com',
        token_hash: 'h_dup',
        expires_at: Date.now() + HOUR_MS,
      }),
    ).rejects.toThrow();
  });
});
