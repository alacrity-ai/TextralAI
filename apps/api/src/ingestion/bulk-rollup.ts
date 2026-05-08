// Aggregate-state rollup for a bulk job. Lazy reconciliation:
// pulled from `bulk_job_files` whenever an aggregate is needed
// (status GET, finalize loop, cron). Idempotent.

import type { Env } from '../types.js';
import {
  countBulkJobFilesByState,
  reconcileBulkJobFromIngestionJobs,
  updateBulkJobAggregates,
  updateBulkJobState,
  type BulkJobRow,
  type BulkJobState,
  type FileStateCounts,
} from '../db/bulk-ingest.js';

export interface RollupResult {
  state: BulkJobState;
  counts: FileStateCounts;
  /** Was the bulk job's state row updated? */
  state_changed: boolean;
}

/** Recompute aggregate counts and the bulk job's terminal state from
 *  per-file rows. Called whenever a status is requested or a per-file
 *  state transition lands. Idempotent. */
export async function rollupBulkJob(
  env: Env,
  bulkJob: BulkJobRow,
): Promise<RollupResult> {
  // 1. Pull terminal state from queue worker via ingestion_jobs.status.
  await reconcileBulkJobFromIngestionJobs(env.db, bulkJob.bulk_job_id);

  // 2. Recount.
  const counts = await countBulkJobFilesByState(env.db, bulkJob.bulk_job_id);

  // 3. Persist the denormalized aggregates so cheap progress polls
  //    don't require the GROUP BY scan.
  const filesUploaded =
    counts.uploaded + counts.finalized + counts.enqueued +
    counts.processing + counts.succeeded + counts.failed + counts.skipped;
  await updateBulkJobAggregates(env.db, bulkJob.bulk_job_id, {
    files_uploaded: filesUploaded,
    files_succeeded: counts.succeeded,
    files_failed: counts.failed,
    files_skipped: counts.skipped,
  });

  // 4. Derive terminal state.
  const total = bulkJob.total_files;
  const allTerminal =
    counts.succeeded + counts.failed + counts.skipped === total;

  let nextState: BulkJobState = bulkJob.state;
  let stateChanged = false;
  let completedAt: number | undefined;

  if (allTerminal && !isTerminalState(bulkJob.state)) {
    if (counts.failed === 0 && counts.skipped === 0 && counts.succeeded === total) {
      nextState = 'complete';
    } else if (counts.succeeded === 0 && counts.failed === total) {
      nextState = 'failed';
    } else {
      // Mixed outcome: some succeeded + some failed/skipped.
      nextState = 'partial';
    }
    stateChanged = true;
    completedAt = Date.now();
  } else if (
    !allTerminal &&
    bulkJob.state === 'finalizing' &&
    counts.enqueued + counts.processing > 0
  ) {
    // Once at least one file is enqueued, lift state to 'processing'.
    nextState = 'processing';
    stateChanged = true;
  }

  if (stateChanged) {
    const updateOpts: { completed_at?: number } = {};
    if (completedAt !== undefined) updateOpts.completed_at = completedAt;
    await updateBulkJobState(env.db, bulkJob.bulk_job_id, nextState, updateOpts);
  }

  return { state: nextState, counts, state_changed: stateChanged };
}

function isTerminalState(s: BulkJobState): boolean {
  return s === 'complete' || s === 'partial' || s === 'failed' || s === 'cancelled' || s === 'expired';
}
