// Phase 6.7 — usage_records cost rollup.
//
// Pins the upsert behavior (multi-call accumulation, day-bucket
// alignment, idempotent zero-delta no-ops, distinct-day separation).

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  incrementUsage,
  getUsageBucket,
  listUsageBuckets,
} from '../src/db/usage-records.js';
import { dayBucket } from '../src/observability/usage.js';
import type { Env } from '../src/types.js';

const TENANT = 'ten_usage_test';
const DAY1 = 86_400_000 * 19_800; // arbitrary aligned day
const DAY2 = DAY1 + 86_400_000;

describe('usage_records', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM usage_records WHERE tenant_id = ?`).bind(TENANT).run();
  });

  it('inserts a fresh row when none exists', async () => {
    const e = env as unknown as Env;
    await incrementUsage(e.db, TENANT, DAY1, { queries: 1, input_tokens: 100, output_tokens: 50 });
    const row = await getUsageBucket(e.db, TENANT, DAY1);
    expect(row).not.toBeNull();
    expect(row!.queries).toBe(1);
    expect(row!.input_tokens).toBe(100);
    expect(row!.output_tokens).toBe(50);
    expect(row!.embedding_tokens).toBe(0);
    expect(row!.ingestion_jobs).toBe(0);
  });

  it('accumulates across multiple calls within the same day', async () => {
    const e = env as unknown as Env;
    await incrementUsage(e.db, TENANT, DAY1, { queries: 1, input_tokens: 100 });
    await incrementUsage(e.db, TENANT, DAY1, { queries: 1, input_tokens: 50, output_tokens: 25 });
    await incrementUsage(e.db, TENANT, DAY1, { ingestion_jobs: 1, embedding_tokens: 200 });

    const row = await getUsageBucket(e.db, TENANT, DAY1);
    expect(row!.queries).toBe(2);
    expect(row!.input_tokens).toBe(150);
    expect(row!.output_tokens).toBe(25);
    expect(row!.ingestion_jobs).toBe(1);
    expect(row!.embedding_tokens).toBe(200);
  });

  it('separates rows across days', async () => {
    const e = env as unknown as Env;
    await incrementUsage(e.db, TENANT, DAY1, { queries: 5 });
    await incrementUsage(e.db, TENANT, DAY2, { queries: 3 });

    const buckets = await listUsageBuckets(e.db, TENANT, {
      since: DAY1,
      until: DAY2 + 86_400_000,
    });
    expect(buckets).toHaveLength(2);
    expect(buckets[0]!.period_start).toBe(DAY1);
    expect(buckets[0]!.queries).toBe(5);
    expect(buckets[1]!.period_start).toBe(DAY2);
    expect(buckets[1]!.queries).toBe(3);
  });

  it('skips writes for all-zero deltas', async () => {
    const e = env as unknown as Env;
    await incrementUsage(e.db, TENANT, DAY1, {});
    await incrementUsage(e.db, TENANT, DAY1, { queries: 0 });
    const row = await getUsageBucket(e.db, TENANT, DAY1);
    expect(row).toBeNull();
  });

  it('dayBucket aligns to UTC midnight', () => {
    const ts = 1_715_000_000_000;
    expect(dayBucket(ts) % 86_400_000).toBe(0);
    expect(dayBucket(ts)).toBeLessThanOrEqual(ts);
    expect(dayBucket(ts) + 86_400_000).toBeGreaterThan(ts);
  });

  it('returns 0 buckets when range has no rows', async () => {
    const e = env as unknown as Env;
    const buckets = await listUsageBuckets(e.db, TENANT, {
      since: DAY1,
      until: DAY2 + 86_400_000,
    });
    expect(buckets).toHaveLength(0);
  });
});
