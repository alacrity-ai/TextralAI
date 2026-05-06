// D1 helpers for ingest_stage_attempts.
//
// Note: list-by-job + latestCompletedStages live in ./jobs.ts and
// stay there for backwards compatibility. This module owns the
// write side + the enrich-summary lookups.

import type { Db } from '../runtime/shared/interfaces.js';

export interface UpsertStageAttemptArgs {
  job_id: string;
  tenant_id: string;
  stage: string;
  attempt: number;
  status: 'started' | 'completed' | 'failed' | 'skipped';
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  metadata: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
}

export async function upsertStageAttempt(
  db: Db,
  args: UpsertStageAttemptArgs,
): Promise<void> {
  await db.exec(
    `INSERT INTO ingest_stage_attempts
         (job_id, stage, attempt, tenant_id, status, started_at, completed_at,
          duration_ms, metadata, error_code, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, stage, attempt) DO UPDATE SET
          status = excluded.status,
          completed_at = excluded.completed_at,
          duration_ms = excluded.duration_ms,
          metadata = excluded.metadata,
          error_code = excluded.error_code,
          error_message = excluded.error_message`,
    [
      args.job_id,
      args.stage,
      args.attempt,
      args.tenant_id,
      args.status,
      args.started_at,
      args.completed_at,
      args.duration_ms,
      args.metadata ? JSON.stringify(args.metadata) : null,
      args.error_code,
      args.error_message,
    ],
  );
}

export async function listEnrichAttemptsForJob(
  db: Db,
  job_id: string,
): Promise<Array<{ stage: string; status: string }>> {
  return await db.all<{ stage: string; status: string }>(
    `SELECT stage, status FROM ingest_stage_attempts
        WHERE job_id = ? AND stage LIKE 'enrich.%'`,
    [job_id],
  );
}
