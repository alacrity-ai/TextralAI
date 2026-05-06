// Job lease + lock CAS.
//
// Cloudflare Queues guarantee at-least-once delivery; one message can be
// redelivered. The lease ensures only one Container instance processes a
// job at a time, even under redelivery.

import type { Db } from '../runtime/shared/interfaces.js';

export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export interface ClaimResult {
  ok: boolean;
  reason?: 'already_claimed' | 'not_found' | 'terminal';
}

/** CAS-style claim. Returns ok=true iff exactly one row was updated. */
export async function claimJob(
  db: Db,
  jobId: string,
  lockedBy: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<ClaimResult> {
  // Precompute `now + leaseMs` in JS so the SQL stays
  // arithmetic-free. Postgres needs explicit type info on bare
  // `$N + $M` (parameter types default to "unknown" and the `+`
  // operator is ambiguous); SQLite infers from runtime values.
  // Computing here keeps the SQL identical across runtimes.
  const now = Date.now();
  const leaseExpiresAt = now + leaseMs;
  const result = await db.exec(
    `UPDATE ingestion_jobs
        SET status = 'running',
            locked_at = ?1,
            locked_by = ?2,
            lease_expires_at = ?3,
            heartbeat_at = ?1,
            attempt_count = attempt_count + 1
      WHERE id = ?4
        AND status IN ('pending', 'retrying')
        AND (lease_expires_at IS NULL OR lease_expires_at < ?1)`,
    [now, lockedBy, leaseExpiresAt, jobId],
  );
  if (result.rowsAffected === 1) return { ok: true };
  // Find out why we lost the race.
  const row = await db.one<{ status: string }>(
    `SELECT status FROM ingestion_jobs WHERE id = ?`,
    [jobId],
  );
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'completed' || row.status === 'failed') {
    return { ok: false, reason: 'terminal' };
  }
  return { ok: false, reason: 'already_claimed' };
}

export async function heartbeatJob(
  db: Db,
  jobId: string,
  lockedBy: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<boolean> {
  // Same arithmetic-in-JS pattern as `claimJob`.
  const now = Date.now();
  const leaseExpiresAt = now + leaseMs;
  const result = await db.exec(
    `UPDATE ingestion_jobs
        SET heartbeat_at = ?1,
            lease_expires_at = ?2
      WHERE id = ?3 AND locked_by = ?4 AND status = 'running'`,
    [now, leaseExpiresAt, jobId, lockedBy],
  );
  return result.rowsAffected === 1;
}

export async function transitionJob(
  db: Db,
  jobId: string,
  to: {
    status: 'pending' | 'running' | 'retrying' | 'completed' | 'failed';
    current_stage?: string | null;
    error_code?: string | null;
    error_message?: string | null;
  },
): Promise<void> {
  const completedAt = to.status === 'completed' || to.status === 'failed' ? Date.now() : null;
  await db.exec(
    `UPDATE ingestion_jobs
        SET status = ?1,
            current_stage = COALESCE(?2, current_stage),
            error_code = ?3,
            error_message = ?4,
            completed_at = COALESCE(completed_at, ?5),
            locked_at = CASE WHEN ?1 IN ('completed','failed') THEN NULL ELSE locked_at END,
            locked_by = CASE WHEN ?1 IN ('completed','failed') THEN NULL ELSE locked_by END,
            lease_expires_at = CASE WHEN ?1 IN ('completed','failed') THEN NULL ELSE lease_expires_at END
      WHERE id = ?6`,
    [
      to.status,
      to.current_stage ?? null,
      to.error_code ?? null,
      to.error_message ?? null,
      completedAt,
      jobId,
    ],
  );
}
