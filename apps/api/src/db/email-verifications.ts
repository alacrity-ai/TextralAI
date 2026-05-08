// D1 helpers for email_verifications.
//
// Single-use token rows backing /v1/auth/register, /v1/auth/recover,
// /v1/auth/redeem. The route layer hashes inbound tokens before
// looking them up here; the cleartext only ever exists in the email
// URL Mailgun delivers.

import type { Db } from '../runtime/shared/interfaces.js';

export type EmailVerificationPurpose = 'register' | 'recover';

export interface EmailVerificationRow {
  id: string;
  purpose: EmailVerificationPurpose;
  email: string;
  display_name: string | null;
  tenant_id: string | null;
  token_hash: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
  ip_hash: string | null;
}

export interface InsertEmailVerificationArgs {
  id: string;
  purpose: EmailVerificationPurpose;
  email: string;
  display_name?: string | null;
  tenant_id?: string | null;
  token_hash: string;
  expires_at: number;
  ip_hash?: string | null;
}

export async function insertEmailVerification(
  db: Db,
  args: InsertEmailVerificationArgs,
): Promise<void> {
  await db.exec(
    `INSERT INTO email_verifications
         (id, purpose, email, display_name, tenant_id, token_hash, expires_at, created_at, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.purpose,
      args.email,
      args.display_name ?? null,
      args.tenant_id ?? null,
      args.token_hash,
      args.expires_at,
      Date.now(),
      args.ip_hash ?? null,
    ],
  );
}

/** Hot-path lookup at redeem time. Returns the row regardless of
 *  expired/consumed state — the route layer checks both and translates
 *  to TOKEN_EXPIRED / TOKEN_ALREADY_USED. Keeps lookup separate from
 *  consumption so we can return distinct error codes. */
export async function findByTokenHash(
  db: Db,
  token_hash: string,
): Promise<EmailVerificationRow | null> {
  return await db.one<EmailVerificationRow>(
    `SELECT id, purpose, email, display_name, tenant_id, token_hash,
            expires_at, consumed_at, created_at, ip_hash
       FROM email_verifications
      WHERE token_hash = ?`,
    [token_hash],
  );
}

/** Atomic single-use enforcement.
 *
 *  Returns true when this call set `consumed_at`; false if another
 *  caller (or a prior call from the same caller) already consumed the
 *  row. Lets the route layer distinguish "token valid, you got it" from
 *  "token already used by someone else" without an extra read.
 *
 *  Uses `WHERE consumed_at IS NULL` as the predicate so concurrent
 *  redeems naturally serialize — D1's row-level write semantics make
 *  the loser's UPDATE affect 0 rows. */
export async function consumeIfUnconsumed(
  db: Db,
  id: string,
  now: number,
): Promise<boolean> {
  const res = await db.exec(
    `UPDATE email_verifications
        SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL`,
    [now, id],
  );
  return res.rowsAffected > 0;
}

/** Pre-mark every prior unconsumed token for (email, purpose) as
 *  consumed so old links 410 instead of competing with the new one.
 *  Called from /register and /recover before issuing a new token.
 *
 *  Uses a sentinel `consumed_at = -1` to distinguish "superseded" from
 *  "redeemed by user" in the audit trail (both show as non-null
 *  consumed_at to the lookup path, which is all that matters for
 *  invalidation). The route layer doesn't read consumed_at directly. */
export async function supersedePriorActive(
  db: Db,
  email: string,
  purpose: EmailVerificationPurpose,
): Promise<void> {
  await db.exec(
    `UPDATE email_verifications
        SET consumed_at = -1
      WHERE email = ? AND purpose = ? AND consumed_at IS NULL`,
    [email, purpose],
  );
}
