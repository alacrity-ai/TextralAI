// Cron handler — sweep expired bulk jobs.
//
// Runs daily. Selects bulk_jobs whose `expires_at < now()` and whose
// state is still 'accepted' or 'uploading' (un-finalized). Deletes
// the tmp R2 prefix and marks the job 'expired'. Completed jobs
// (state in 'complete' / 'partial' / 'failed' / 'cancelled') are
// retained for 90 days for audit; a separate sweep handles those.

import type { Env } from '../types.js';
import {
  listBulkJobFiles,
  listExpiredUnfinalizedBulkJobs,
  updateBulkJobState,
  type BulkJobRow,
} from '../db/bulk-ingest.js';
import { bulkUploadKey } from '../ingestion/bulk-keys.js';

export interface ExpireBulkJobsResult {
  scanned: number;
  expired: number;
  errors: number;
}

export async function expireUnfinalizedBulkJobs(
  env: Env,
  now = Date.now(),
): Promise<ExpireBulkJobsResult> {
  const out: ExpireBulkJobsResult = { scanned: 0, expired: 0, errors: 0 };
  const rows = await listExpiredUnfinalizedBulkJobs(env.db, now, 100);
  out.scanned = rows.length;
  for (const job of rows) {
    try {
      await expireOneBulkJob(env, job);
      out.expired++;
    } catch {
      out.errors++;
    }
  }
  return out;
}

async function expireOneBulkJob(env: Env, job: BulkJobRow): Promise<void> {
  // Iterate per-file rows and delete each tmp R2 key. Best-effort —
  // R2 lifecycle TTL backstops anything we miss.
  try {
    const files = await listBulkJobFiles(env.db, job.bulk_job_id);
    for (const f of files) {
      try {
        await env.blobs.delete(bulkUploadKey(job.bulk_job_id, f.ordinal));
      } catch {
        // continue
      }
    }
  } catch {
    // continue
  }
  await updateBulkJobState(env.db, job.bulk_job_id, 'expired', {
    completed_at: Date.now(),
  });
}
