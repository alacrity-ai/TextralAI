// D1 query helpers for ingestion_jobs + ingest_stage_attempts.

import type { IngestionJob, StageAttempt } from '@textral/contracts';
import type { Db } from '../runtime/shared/interfaces.js';

export interface IngestionJobRow {
  id: string;
  tenant_id: string;
  document_id: string;
  version_id: string;
  version_index_id: string;
  mode: string;
  status: string;
  current_stage: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  locked_at: number | null;
  locked_by: string | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
  dead_lettered: number;
  config_json: string;
  created_at: number;
  completed_at: number | null;
}

export function rowToJob(r: IngestionJobRow): IngestionJob {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    document_id: r.document_id,
    version_id: r.version_id,
    version_index_id: r.version_index_id,
    mode: r.mode as IngestionJob['mode'],
    status: r.status as IngestionJob['status'],
    current_stage: r.current_stage,
    error_code: r.error_code,
    error_message: r.error_message,
    attempt_count: r.attempt_count,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

export async function getJobById(
  db: Db,
  tenantId: string,
  jobId: string,
): Promise<IngestionJobRow | null> {
  return await db.one<IngestionJobRow>(
    `SELECT * FROM ingestion_jobs WHERE id = ? AND tenant_id = ?`,
    [jobId, tenantId],
  );
}

export async function getJobByIdAny(
  db: Db,
  jobId: string,
): Promise<IngestionJobRow | null> {
  // Internal-route variant; ownership is enforced by the HMAC + the
  // caller verifying tenant_id externally.
  return await db.one<IngestionJobRow>(
    `SELECT * FROM ingestion_jobs WHERE id = ?`,
    [jobId],
  );
}

export async function listJobsForDocument(
  db: Db,
  tenantId: string,
  documentId: string,
): Promise<IngestionJobRow[]> {
  return await db.all<IngestionJobRow>(
    `SELECT * FROM ingestion_jobs WHERE tenant_id = ? AND document_id = ?
       ORDER BY created_at DESC`,
    [tenantId, documentId],
  );
}

export async function findActiveJobForVersionIndex(
  db: Db,
  versionIndexId: string,
): Promise<IngestionJobRow | null> {
  return await db.one<IngestionJobRow>(
    `SELECT * FROM ingestion_jobs
        WHERE version_index_id = ? AND status IN ('pending','running','retrying')
        LIMIT 1`,
    [versionIndexId],
  );
}

export interface StageAttemptRow {
  job_id: string;
  stage: string;
  attempt: number;
  tenant_id: string;
  status: string;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  metadata: string | null;
  error_code: string | null;
  error_message: string | null;
}

export function rowToStageAttempt(r: StageAttemptRow): StageAttempt {
  return {
    job_id: r.job_id,
    stage: r.stage,
    attempt: r.attempt,
    status: r.status as StageAttempt['status'],
    started_at: r.started_at,
    completed_at: r.completed_at,
    duration_ms: r.duration_ms,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    error_code: r.error_code,
    error_message: r.error_message,
  };
}

export async function listStageAttemptsForJob(
  db: Db,
  tenantId: string,
  jobId: string,
): Promise<StageAttemptRow[]> {
  return await db.all<StageAttemptRow>(
    `SELECT * FROM ingest_stage_attempts WHERE job_id = ? AND tenant_id = ?
        ORDER BY started_at ASC`,
    [jobId, tenantId],
  );
}

export async function insertIngestionJob(
  db: Db,
  args: {
    id: string;
    tenant_id: string;
    document_id: string;
    version_id: string;
    version_index_id: string;
    mode: string;
    config_json: string;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO ingestion_jobs
         (id, tenant_id, document_id, version_id, version_index_id, mode, status,
          attempt_count, dead_lettered, config_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)`,
    [
      args.id,
      args.tenant_id,
      args.document_id,
      args.version_id,
      args.version_index_id,
      args.mode,
      args.config_json,
      Date.now(),
    ],
  );
}

export async function listDeadLetteredJobs(
  db: Db,
  tenant_id: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ items: IngestionJobRow[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Cursor is the created_at of the last item from the previous page.
  // SQLite ROWID-style; we keep it simple — strict-greater-than.
  const cursorTs = opts.cursor ? Number(opts.cursor) : null;
  const rows = cursorTs !== null
    ? await db.all<IngestionJobRow>(
        `SELECT * FROM ingestion_jobs
            WHERE tenant_id = ? AND dead_lettered = 1 AND created_at < ?
            ORDER BY created_at DESC
            LIMIT ?`,
        [tenant_id, cursorTs, limit + 1],
      )
    : await db.all<IngestionJobRow>(
        `SELECT * FROM ingestion_jobs
            WHERE tenant_id = ? AND dead_lettered = 1
            ORDER BY created_at DESC
            LIMIT ?`,
        [tenant_id, limit + 1],
      );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const next_cursor = hasMore ? String(items[items.length - 1]!.created_at) : null;
  return { items, next_cursor };
}

export async function clearDeadLetterAndReset(
  db: Db,
  tenant_id: string,
  job_id: string,
): Promise<IngestionJobRow | null> {
  // Atomic CAS: only fires if the row is currently dead_lettered=1.
  // Returns null if the row didn't exist or wasn't actually DLQ'd.
  const updated = await db.exec(
    `UPDATE ingestion_jobs
          SET dead_lettered = 0,
              status = 'pending',
              attempt_count = 0,
              error_code = NULL,
              error_message = NULL,
              locked_at = NULL,
              locked_by = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL
        WHERE id = ? AND tenant_id = ? AND dead_lettered = 1`,
    [job_id, tenant_id],
  );
  if (updated.rowsAffected === 0) return null;
  return await getJobById(db, tenant_id, job_id);
}

/** For replay: latest successful attempt per stage. */
export async function latestCompletedStages(
  db: Db,
  jobId: string,
): Promise<Map<string, StageAttemptRow>> {
  const rows = await db.all<StageAttemptRow>(
    `SELECT * FROM ingest_stage_attempts WHERE job_id = ? AND status = 'completed'
        ORDER BY attempt DESC`,
    [jobId],
  );
  const map = new Map<string, StageAttemptRow>();
  for (const r of rows) {
    if (!map.has(r.stage)) map.set(r.stage, r); // first (highest attempt) wins
  }
  return map;
}
