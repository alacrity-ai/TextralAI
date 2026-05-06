// D1 helpers for query_events.
//
// Note: the audit *write* path (insertQueryEvent + updateQueryEvent)
// lives in src/audit/query-events.ts because it owns redaction +
// hashing logic on top of D1. This module is reads only.

import type { Db } from '../runtime/shared/interfaces.js';

export interface QueryEventRow {
  id: string;
  tenant_id: string;
  namespace_id: string;
  status: string;
  query_text: string;
  request_config: string;
  request_config_hash: string | null;
  embedding_profile_used: string | null;
  chunking_profile_used: string | null;
  retrieval_strategy: string | null;
  degradation_level: string | null;
  retrieval_status: string | null;
  citation_integrity: string | null;
  synthesis_status: string | null;
  candidates_returned: number | null;
  dense_candidates_returned: number | null;
  sparse_candidates_returned: number | null;
  embedding_missing_count: number | null;
  citations_returned: number | null;
  dropped_citations: string | null;
  latency_ms: number | null;
  answer_r2_key: string | null;
  mirror_error: string | null;
  error_code: string | null;
  error_message: string | null;
  inference_provider: string | null;
  inference_model_used: string | null;
  provider_key_id: string | null;
  embedding_input_tokens: number | null;
  synthesis_input_tokens: number | null;
  synthesis_output_tokens: number | null;
  context_tokens: number | null;
  created_at: number;
  completed_at: number | null;
}

export async function getQueryEventById(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<QueryEventRow | null> {
  return await db.one<QueryEventRow>(
    `SELECT * FROM query_events WHERE id = ? AND tenant_id = ?`,
    [id, tenant_id],
  );
}

export interface ListQueryEventsOpts {
  /** 1..200, default 50. Caps prevent operators from accidentally
   *  pulling the full audit history at once. */
  limit?: number;
  /** Opaque cursor: the `created_at` of the last item from the prior
   *  page. Strict-greater-than to avoid duplicate-row issues across
   *  identical timestamps (the (created_at, id) tiebreak below makes
   *  this stable). */
  cursor?: string;
  /** Optional namespace filter — operator-friendly slug, joined to
   *  the namespace table at the route layer (we only accept the
   *  resolved namespace_id here to keep the helper SQL-agnostic). */
  namespace_id?: string;
  /** Optional status filter — typically 'failed' for triage. */
  status?:
    | 'received'
    | 'retrieval_started'
    | 'retrieval_completed'
    | 'synthesis_started'
    | 'completed'
    | 'failed';
}

/** Tenant-scoped, descending by created_at. Cursor pagination mirrors
 *  the DLQ list (`db/jobs.ts:listDeadLetteredJobs`) — same semantics:
 *  the cursor is the previous page's last item's `created_at`, and we
 *  fetch limit+1 to detect whether there's another page. */
export async function listQueryEvents(
  db: Db,
  tenant_id: string,
  opts: ListQueryEventsOpts = {},
): Promise<{ items: QueryEventRow[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const cursorTs = opts.cursor ? Number(opts.cursor) : null;

  // Build the WHERE clause incrementally. Placeholders use `?N` so the
  // Node-runtime adapter can translate to `$N` (Postgres) in one place.
  const where: string[] = ['tenant_id = ?'];
  const params: unknown[] = [tenant_id];
  if (cursorTs !== null) {
    where.push('created_at < ?');
    params.push(cursorTs);
  }
  if (opts.namespace_id) {
    where.push('namespace_id = ?');
    params.push(opts.namespace_id);
  }
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  params.push(limit + 1);

  const sql =
    `SELECT * FROM query_events
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`;
  const rows = await db.all<QueryEventRow>(sql, params);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const next_cursor = hasMore ? String(items[items.length - 1]!.created_at) : null;
  return { items, next_cursor };
}
