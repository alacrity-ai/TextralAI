// R2 key conventions for bulk uploads.
//
// Bulk uploads land in a tmp prefix keyed by bulk_job_id + ordinal.
// Finalize copies them to the canonical document version key (same
// as single-file). The cleanup cron sweeps unprocessed tmp keys.

export function bulkUploadKey(bulkJobId: string, ordinal: number): string {
  return `tmp/bulk/${bulkJobId}/${ordinal}`;
}

export function bulkUploadPrefix(bulkJobId: string): string {
  return `tmp/bulk/${bulkJobId}/`;
}
