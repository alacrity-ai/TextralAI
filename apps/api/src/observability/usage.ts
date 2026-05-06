// Cost-rollup write façade.
//
// The actual SQL lives in src/db/usage-records.ts. This module owns
// the day-bucket math + the per-event-shape deltas (a successful query
// vs a successful ingestion vs a chunk-batch embed run).
//
// Failure paths must NEVER call these helpers — the rollup is a record
// of *billable* work. A failed query/job didn't bill the tenant.

import type { Env } from '../types.js';
import { incrementUsage } from '../db/usage-records.js';

export function dayBucket(now: number = Date.now()): number {
  return Math.floor(now / 86_400_000) * 86_400_000;
}

export async function recordQueryUsage(
  env: Env,
  tenant_id: string,
  args: { input_tokens: number; output_tokens: number },
): Promise<void> {
  await incrementUsage(env.db, tenant_id, dayBucket(), {
    queries: 1,
    input_tokens: args.input_tokens,
    output_tokens: args.output_tokens,
  });
}

export async function recordIngestionUsage(
  env: Env,
  tenant_id: string,
  args: { embedding_tokens: number },
): Promise<void> {
  await incrementUsage(env.db, tenant_id, dayBucket(), {
    ingestion_jobs: 1,
    embedding_tokens: args.embedding_tokens,
  });
}

export async function recordEmbeddingTokens(
  env: Env,
  tenant_id: string,
  args: { embedding_tokens: number },
): Promise<void> {
  // Per-batch embedding accumulation (no job counter). Use this from
  // the chunk-batch handler; pair with `recordIngestionUsage` once at
  // job completion to bump `ingestion_jobs += 1`.
  await incrementUsage(env.db, tenant_id, dayBucket(), {
    embedding_tokens: args.embedding_tokens,
  });
}
