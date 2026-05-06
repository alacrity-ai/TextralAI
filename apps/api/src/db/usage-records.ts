// D1 helpers for the usage_records day-bucket rollup.
//
// One row per (tenant_id, period_start). Writers use the upsert pattern
// to avoid the read-modify-write race that would otherwise drop counts
// under concurrent requests.

import type { Db } from '../runtime/shared/interfaces.js';

export interface UsageBucket {
  tenant_id: string;
  period_start: number;
  queries: number;
  ingestion_jobs: number;
  input_tokens: number;
  output_tokens: number;
  embedding_tokens: number;
}

export type UsageDelta = Partial<Omit<UsageBucket, 'tenant_id' | 'period_start'>>;

export async function incrementUsage(
  db: Db,
  tenant_id: string,
  period_start: number,
  delta: UsageDelta,
): Promise<void> {
  const queries = delta.queries ?? 0;
  const ingestion_jobs = delta.ingestion_jobs ?? 0;
  const input_tokens = delta.input_tokens ?? 0;
  const output_tokens = delta.output_tokens ?? 0;
  const embedding_tokens = delta.embedding_tokens ?? 0;
  // No-op if every delta is zero — saves a write.
  if (
    queries === 0 &&
    ingestion_jobs === 0 &&
    input_tokens === 0 &&
    output_tokens === 0 &&
    embedding_tokens === 0
  ) {
    return;
  }
  await db.exec(
    `INSERT INTO usage_records
         (tenant_id, period_start, queries, ingestion_jobs,
          input_tokens, output_tokens, embedding_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, period_start) DO UPDATE SET
         queries          = queries + excluded.queries,
         ingestion_jobs   = ingestion_jobs + excluded.ingestion_jobs,
         input_tokens     = input_tokens + excluded.input_tokens,
         output_tokens    = output_tokens + excluded.output_tokens,
         embedding_tokens = embedding_tokens + excluded.embedding_tokens`,
    [
      tenant_id,
      period_start,
      queries,
      ingestion_jobs,
      input_tokens,
      output_tokens,
      embedding_tokens,
    ],
  );
}

export async function getUsageBucket(
  db: Db,
  tenant_id: string,
  period_start: number,
): Promise<UsageBucket | null> {
  return await db.one<UsageBucket>(
    `SELECT * FROM usage_records WHERE tenant_id = ? AND period_start = ?`,
    [tenant_id, period_start],
  );
}

export async function listUsageBuckets(
  db: Db,
  tenant_id: string,
  range: { since: number; until: number },
): Promise<UsageBucket[]> {
  return await db.all<UsageBucket>(
    `SELECT * FROM usage_records
        WHERE tenant_id = ? AND period_start >= ? AND period_start < ?
        ORDER BY period_start ASC`,
    [tenant_id, range.since, range.until],
  );
}
