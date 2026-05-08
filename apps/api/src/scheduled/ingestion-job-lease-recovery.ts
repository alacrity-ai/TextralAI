// Cron — recover ingestion_jobs whose lease expired without the
// Container ever writing terminal state.
//
// The failure mode this handles:
//   1. CF Worker dispatches an ingest message → Container claims
//      the job (status='running', lease_expires_at = now+5min).
//   2. Container dies mid-stage (OOM, runtime crash, host eviction)
//      without writing 'completed' / 'failed' to D1.
//   3. CF re-delivers the queue message — but if the original
//      Worker invocation got far enough to ack the message before
//      the Container died, there's no redelivery. Even when there
//      is, the new claim CAS sees status='running' and refuses.
//
// Without recovery, the row sits at status='running' forever; the
// (version_index, embedding_profile) is permanently locked from
// further claims; the document never finishes ingesting.
//
// This runner:
//   * Finds rows whose lease expired ≥ GRACE_MS ago.
//   * Increments attempt_count.
//   * Below MAX_AUTO_RETRIES: clears lease fields, sets
//     status='pending', re-publishes the queue message.
//   * At/above MAX_AUTO_RETRIES: marks dead_lettered=1 with code
//     INGEST_LEASE_RECOVERY_EXHAUSTED for operator triage.
//
// Cadence: every 5 minutes. With GRACE_MS = 5 min, worst-case
// time-to-recovery is ~10 minutes (5 min lease expiry + up to 5
// min wait for the next cron tick). Tighter cadence is fine — the
// scan filters on a partial-index-friendly WHERE, so the cost
// scales with stuck-row count, not total ingestion_jobs.

import type { Bindings } from '../runtime/shared/interfaces.js';

/** Grace period on top of the lease TTL. A still-alive container
 *  whose stage just took longer than the lease (rare but possible
 *  on cold starts) is given GRACE_MS to update the lease before we
 *  steal the job. */
const GRACE_MS = 5 * 60 * 1000;

/** After this many auto-recoveries, give up on the job and let an
 *  operator triage it from the DLQ. Bumping a job that's
 *  consistently dying is unlikely to help; saves us from infinite
 *  loops on a poison message. */
const MAX_AUTO_RETRIES = 3;

/** Bounded work per tick. Prevents one tenant's incident from
 *  blowing the cron's CPU budget. The next tick picks up the
 *  remainder. */
const SCAN_LIMIT = 200;

export interface LeaseRecoveryResult {
  scanned: number;
  requeued: number;
  dead_lettered: number;
  errors: number;
}

interface StuckJobRow {
  id: string;
  tenant_id: string;
  attempt_count: number;
}

export async function recoverStuckIngestionJobs(
  env: Bindings,
  now = Date.now(),
): Promise<LeaseRecoveryResult> {
  const out: LeaseRecoveryResult = {
    scanned: 0,
    requeued: 0,
    dead_lettered: 0,
    errors: 0,
  };
  const cutoff = now - GRACE_MS;

  const stuck = await env.db.all<StuckJobRow>(
    `SELECT id, tenant_id, attempt_count
        FROM ingestion_jobs
       WHERE status = 'running'
         AND dead_lettered = 0
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < ?
       ORDER BY lease_expires_at ASC
       LIMIT ?`,
    [cutoff, SCAN_LIMIT],
  );
  out.scanned = stuck.length;

  for (const job of stuck) {
    try {
      const nextAttempt = job.attempt_count + 1;
      if (nextAttempt > MAX_AUTO_RETRIES) {
        await deadLetterStuckJob(env, job.id, nextAttempt, now);
        out.dead_lettered++;
      } else {
        const requeued = await resetAndRequeue(
          env,
          job.id,
          job.tenant_id,
          nextAttempt,
          cutoff,
        );
        if (requeued) out.requeued++;
      }
    } catch {
      out.errors++;
      // Continue — one bad row shouldn't block the rest. The
      // dispatcher logs the aggregate result; a future tick
      // re-attempts this row with a fresh `cutoff`.
    }
  }
  return out;
}

/** Reset lease fields and republish the queue message. The CAS in
 *  the WHERE clause guards against racing with a still-alive
 *  Container that managed to update its lease between the SELECT
 *  and the UPDATE — in that case rowsAffected=0 and we don't
 *  requeue. */
async function resetAndRequeue(
  env: Bindings,
  jobId: string,
  tenantId: string,
  nextAttempt: number,
  cutoff: number,
): Promise<boolean> {
  const updated = await env.db.exec(
    `UPDATE ingestion_jobs
        SET status = 'pending',
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            attempt_count = ?
      WHERE id = ?
        AND status = 'running'
        AND dead_lettered = 0
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < ?`,
    [nextAttempt, jobId, cutoff],
  );
  if (updated.rowsAffected !== 1) return false;
  await env.queue.send({
    job_id: jobId,
    tenant_id: tenantId,
    attempt: nextAttempt,
  });
  return true;
}

async function deadLetterStuckJob(
  env: Bindings,
  jobId: string,
  attemptCount: number,
  now: number,
): Promise<void> {
  await env.db.exec(
    `UPDATE ingestion_jobs
        SET status = 'failed',
            dead_lettered = 1,
            error_code = 'INGEST_LEASE_RECOVERY_EXHAUSTED',
            error_message = ?,
            completed_at = ?,
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            attempt_count = ?
      WHERE id = ?
        AND status = 'running'
        AND dead_lettered = 0`,
    [
      `Lease expired ${MAX_AUTO_RETRIES} consecutive times without the Container writing terminal state. Manual triage required: see ingest_stage_attempts for the last completed stage and decide whether to clearDeadLetterAndReset (operator).`,
      now,
      attemptCount,
      jobId,
    ],
  );
}
