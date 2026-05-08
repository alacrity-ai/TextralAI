// D1/Postgres query helpers for bulk_jobs and bulk_job_files.
// Every helper takes `tenant_id` as a non-optional first arg so it's
// structurally impossible to forget the tenant filter (mirrors
// db/documents.ts convention).

import type { Db } from '../runtime/shared/interfaces.js';
import type { BulkConfig, BulkOnExisting, BulkSource } from '@textral/contracts';

// ── Row shapes ──────────────────────────────────────────────────────────

export interface BulkJobRow {
  bulk_job_id: string;
  tenant_id: string;
  namespace_id: string;
  state: BulkJobState;
  config_json: string;
  on_existing: BulkOnExisting;
  client_request_id: string | null;
  total_files: number;
  files_uploaded: number;
  files_succeeded: number;
  files_failed: number;
  files_skipped: number;
  source: BulkSource;
  auto_finalize: number; // 0 | 1 (sqlite) — Postgres BOOLEAN comes through as 0/1 via the Db abstraction's normalization
  created_at: number;
  finalized_at: number | null;
  completed_at: number | null;
  expires_at: number;
}

export type BulkJobState =
  | 'accepted'
  | 'uploading'
  | 'finalizing'
  | 'processing'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type BulkFileState =
  | 'pending'
  | 'uploaded'
  | 'finalized'
  | 'enqueued'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export interface BulkJobFileRow {
  bulk_job_id: string;
  ordinal: number;
  filename: string;
  size_bytes: number;
  content_type: string;
  state: BulkFileState;
  upload_id: string | null;
  upload_url_expires_at: number | null;
  document_id: string | null;
  version_id: string | null;
  ingestion_job_id: string | null;
  error_code: string | null;
  error_detail: string | null;
  client_request_id: string | null;
}

// ── Inserts ─────────────────────────────────────────────────────────────

export async function insertBulkJob(
  db: Db,
  args: {
    bulk_job_id: string;
    tenant_id: string;
    namespace_id: string;
    config: BulkConfig;
    on_existing: BulkOnExisting;
    client_request_id: string | null;
    total_files: number;
    source: BulkSource;
    auto_finalize: boolean;
    expires_at: number;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO bulk_jobs (
        bulk_job_id, tenant_id, namespace_id, state, config_json,
        on_existing, client_request_id, total_files,
        files_uploaded, files_succeeded, files_failed, files_skipped,
        source, auto_finalize, created_at, expires_at
      ) VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?)`,
    [
      args.bulk_job_id,
      args.tenant_id,
      args.namespace_id,
      JSON.stringify(args.config),
      args.on_existing,
      args.client_request_id,
      args.total_files,
      args.source,
      args.auto_finalize ? 1 : 0,
      Date.now(),
      args.expires_at,
    ],
  );
}

export async function insertBulkJobFile(
  db: Db,
  args: {
    bulk_job_id: string;
    ordinal: number;
    filename: string;
    size_bytes: number;
    content_type: string;
    upload_id: string;
    upload_url_expires_at: number;
    client_request_id: string | null;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO bulk_job_files (
        bulk_job_id, ordinal, filename, size_bytes, content_type, state,
        upload_id, upload_url_expires_at, client_request_id
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [
      args.bulk_job_id,
      args.ordinal,
      args.filename,
      args.size_bytes,
      args.content_type,
      args.upload_id,
      args.upload_url_expires_at,
      args.client_request_id,
    ],
  );
}

// ── Reads ───────────────────────────────────────────────────────────────

export async function getBulkJob(
  db: Db,
  tenantId: string,
  bulkJobId: string,
): Promise<BulkJobRow | null> {
  return await db.one<BulkJobRow>(
    `SELECT * FROM bulk_jobs WHERE bulk_job_id = ? AND tenant_id = ?`,
    [bulkJobId, tenantId],
  );
}

export async function getBulkJobByClientRequestId(
  db: Db,
  tenantId: string,
  clientRequestId: string,
): Promise<BulkJobRow | null> {
  return await db.one<BulkJobRow>(
    `SELECT * FROM bulk_jobs
        WHERE tenant_id = ? AND client_request_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    [tenantId, clientRequestId],
  );
}

export async function listBulkJobFiles(
  db: Db,
  bulkJobId: string,
  opts: { state?: BulkFileState; limit?: number; offset?: number } = {},
): Promise<BulkJobFileRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const offset = opts.offset ?? 0;
  if (opts.state) {
    return await db.all<BulkJobFileRow>(
      `SELECT * FROM bulk_job_files
          WHERE bulk_job_id = ? AND state = ?
          ORDER BY ordinal ASC
          LIMIT ? OFFSET ?`,
      [bulkJobId, opts.state, limit, offset],
    );
  }
  return await db.all<BulkJobFileRow>(
    `SELECT * FROM bulk_job_files
        WHERE bulk_job_id = ?
        ORDER BY ordinal ASC
        LIMIT ? OFFSET ?`,
    [bulkJobId, limit, offset],
  );
}

export async function getBulkJobFile(
  db: Db,
  bulkJobId: string,
  ordinal: number,
): Promise<BulkJobFileRow | null> {
  return await db.one<BulkJobFileRow>(
    `SELECT * FROM bulk_job_files WHERE bulk_job_id = ? AND ordinal = ?`,
    [bulkJobId, ordinal],
  );
}

export async function getBulkJobFileByUploadId(
  db: Db,
  bulkJobId: string,
  uploadId: string,
): Promise<BulkJobFileRow | null> {
  return await db.one<BulkJobFileRow>(
    `SELECT * FROM bulk_job_files WHERE bulk_job_id = ? AND upload_id = ?`,
    [bulkJobId, uploadId],
  );
}

export async function listRecentBulkJobs(
  db: Db,
  tenantId: string,
  opts: {
    namespace_id?: string;
    state?: BulkJobState;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ items: BulkJobRow[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const cursorTs = opts.cursor ? Number(opts.cursor) : null;
  const where: string[] = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];
  if (opts.namespace_id) {
    where.push('namespace_id = ?');
    params.push(opts.namespace_id);
  }
  if (opts.state) {
    where.push('state = ?');
    params.push(opts.state);
  }
  if (cursorTs !== null) {
    where.push('created_at < ?');
    params.push(cursorTs);
  }
  params.push(limit + 1);
  const rows = await db.all<BulkJobRow>(
    `SELECT * FROM bulk_jobs
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ?`,
    params,
  );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const next_cursor = hasMore ? String(items[items.length - 1]!.created_at) : null;
  return { items, next_cursor };
}

export async function countActiveBulkJobs(
  db: Db,
  tenantId: string,
): Promise<number> {
  const r = await db.one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM bulk_jobs
        WHERE tenant_id = ?
          AND state IN ('accepted','uploading','finalizing','processing')`,
    [tenantId],
  );
  return r?.c ?? 0;
}

// ── Updates ─────────────────────────────────────────────────────────────

export async function updateBulkJobFileState(
  db: Db,
  args: {
    bulk_job_id: string;
    ordinal: number;
    state: BulkFileState;
    document_id?: string | null;
    version_id?: string | null;
    ingestion_job_id?: string | null;
    error_code?: string | null;
    error_detail?: string | null;
  },
): Promise<void> {
  // Build dynamic SET — only fields that are explicitly passed get set,
  // so a "mark uploaded" call doesn't accidentally null out doc_id.
  const sets: string[] = ['state = ?'];
  const params: unknown[] = [args.state];
  if (args.document_id !== undefined) {
    sets.push('document_id = ?');
    params.push(args.document_id);
  }
  if (args.version_id !== undefined) {
    sets.push('version_id = ?');
    params.push(args.version_id);
  }
  if (args.ingestion_job_id !== undefined) {
    sets.push('ingestion_job_id = ?');
    params.push(args.ingestion_job_id);
  }
  if (args.error_code !== undefined) {
    sets.push('error_code = ?');
    params.push(args.error_code);
  }
  if (args.error_detail !== undefined) {
    sets.push('error_detail = ?');
    params.push(args.error_detail);
  }
  params.push(args.bulk_job_id, args.ordinal);
  await db.exec(
    `UPDATE bulk_job_files SET ${sets.join(', ')}
        WHERE bulk_job_id = ? AND ordinal = ?`,
    params,
  );
}

export async function updateBulkJobState(
  db: Db,
  bulkJobId: string,
  state: BulkJobState,
  opts: { finalized_at?: number; completed_at?: number } = {},
): Promise<void> {
  const sets: string[] = ['state = ?'];
  const params: unknown[] = [state];
  if (opts.finalized_at !== undefined) {
    sets.push('finalized_at = ?');
    params.push(opts.finalized_at);
  }
  if (opts.completed_at !== undefined) {
    sets.push('completed_at = ?');
    params.push(opts.completed_at);
  }
  params.push(bulkJobId);
  await db.exec(
    `UPDATE bulk_jobs SET ${sets.join(', ')} WHERE bulk_job_id = ?`,
    params,
  );
}

export async function updateBulkJobAggregates(
  db: Db,
  bulkJobId: string,
  args: {
    files_uploaded: number;
    files_succeeded: number;
    files_failed: number;
    files_skipped: number;
  },
): Promise<void> {
  await db.exec(
    `UPDATE bulk_jobs
        SET files_uploaded = ?, files_succeeded = ?, files_failed = ?, files_skipped = ?
        WHERE bulk_job_id = ?`,
    [
      args.files_uploaded,
      args.files_succeeded,
      args.files_failed,
      args.files_skipped,
      bulkJobId,
    ],
  );
}

export interface FileStateCounts {
  pending: number;
  uploaded: number;
  finalized: number;
  enqueued: number;
  processing: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export async function countBulkJobFilesByState(
  db: Db,
  bulkJobId: string,
): Promise<FileStateCounts> {
  const rows = await db.all<{ state: BulkFileState; c: number }>(
    `SELECT state, COUNT(*) AS c FROM bulk_job_files
        WHERE bulk_job_id = ?
        GROUP BY state`,
    [bulkJobId],
  );
  const out: FileStateCounts = {
    pending: 0,
    uploaded: 0,
    finalized: 0,
    enqueued: 0,
    processing: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
  for (const r of rows) {
    out[r.state] = r.c;
  }
  return out;
}

export async function getFirstFailureForBulkJob(
  db: Db,
  bulkJobId: string,
): Promise<BulkJobFileRow | null> {
  return await db.one<BulkJobFileRow>(
    `SELECT * FROM bulk_job_files
        WHERE bulk_job_id = ? AND state = 'failed'
        ORDER BY ordinal ASC LIMIT 1`,
    [bulkJobId],
  );
}

// ── Delete (used by cancel + expire cron) ───────────────────────────────

export async function deleteBulkJob(db: Db, bulkJobId: string): Promise<void> {
  // bulk_job_files cascades via ON DELETE CASCADE.
  await db.exec(`DELETE FROM bulk_jobs WHERE bulk_job_id = ?`, [bulkJobId]);
}

export async function listExpiredUnfinalizedBulkJobs(
  db: Db,
  now: number,
  limit = 100,
): Promise<BulkJobRow[]> {
  return await db.all<BulkJobRow>(
    `SELECT * FROM bulk_jobs
        WHERE expires_at < ? AND state IN ('accepted','uploading')
        ORDER BY expires_at ASC LIMIT ?`,
    [now, limit],
  );
}

/** Reconcile per-file states from the underlying ingestion_jobs. The
 *  queue worker (Python container) updates ingestion_jobs.status when
 *  a job completes or fails; this helper propagates that terminal
 *  state into bulk_job_files lazily on read. Idempotent. */
export async function reconcileBulkJobFromIngestionJobs(
  db: Db,
  bulkJobId: string,
): Promise<void> {
  // Pull ingestion_jobs that belong to this bulk job and have a terminal
  // status. Update matching bulk_job_files rows whose state is still
  // 'enqueued' or 'processing'.
  const rows = await db.all<{
    id: string;
    status: string;
    error_code: string | null;
    error_message: string | null;
  }>(
    `SELECT id, status, error_code, error_message
        FROM ingestion_jobs
       WHERE bulk_job_id = ?
         AND status IN ('completed','failed')`,
    [bulkJobId],
  );
  for (const ij of rows) {
    if (ij.status === 'completed') {
      await db.exec(
        `UPDATE bulk_job_files
            SET state = 'succeeded'
          WHERE bulk_job_id = ? AND ingestion_job_id = ?
            AND state IN ('enqueued','processing')`,
        [bulkJobId, ij.id],
      );
    } else {
      await db.exec(
        `UPDATE bulk_job_files
            SET state = 'failed', error_code = ?, error_detail = ?
          WHERE bulk_job_id = ? AND ingestion_job_id = ?
            AND state IN ('enqueued','processing')`,
        [
          ij.error_code ?? 'BULK_FILE_INGEST_FAILED',
          ij.error_message,
          bulkJobId,
          ij.id,
        ],
      );
    }
  }
  // Also flip 'enqueued' → 'processing' if the ingestion_jobs row is
  // running; small visual nicety for the polling sandbox UI.
  await db.exec(
    `UPDATE bulk_job_files
        SET state = 'processing'
      WHERE bulk_job_id = ? AND state = 'enqueued'
        AND ingestion_job_id IN (
          SELECT id FROM ingestion_jobs
            WHERE bulk_job_id = ? AND status = 'running'
        )`,
    [bulkJobId, bulkJobId],
  );
}
