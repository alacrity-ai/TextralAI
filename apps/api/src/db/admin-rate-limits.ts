// Per-minute admin rate limiter (Phase 6.8).
//
// Buckets: `(tenant_id, scope:minute_start)`. The bump-and-check
// upsert is atomic; if the resulting count exceeds the cap the
// handler returns 429 ADMIN_RATE_LIMITED.

import type { Db } from '../runtime/shared/interfaces.js';

const MINUTE_MS = 60_000;
const PRUNE_BEFORE_MS = 5 * 60_000;

export function minuteAlign(now: number = Date.now()): number {
  return Math.floor(now / MINUTE_MS) * MINUTE_MS;
}

export async function bumpAndCheck(
  db: Db,
  tenant_id: string,
  scope: string,
  limit_per_minute: number,
): Promise<{ allowed: boolean; current: number }> {
  const minute = minuteAlign();
  const bucket = `${scope}:${minute}`;

  // GC old rows first — keeps the table bounded without a scheduled cron.
  await db.exec(
    `DELETE FROM admin_rate_limits WHERE window_start < ?`,
    [minute - PRUNE_BEFORE_MS],
  );

  await db.exec(
    `INSERT INTO admin_rate_limits (tenant_id, bucket_key, window_start, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(tenant_id, bucket_key) DO UPDATE SET count = count + 1`,
    [tenant_id, bucket, minute],
  );

  const row = await db.one<{ count: number }>(
    `SELECT count FROM admin_rate_limits
        WHERE tenant_id = ? AND bucket_key = ?`,
    [tenant_id, bucket],
  );
  const current = row?.count ?? 1;
  return { allowed: current <= limit_per_minute, current };
}
