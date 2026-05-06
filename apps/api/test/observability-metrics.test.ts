// Phase 6.3 — runtime-agnostic metric writes via `MetricsSink`.
//
// Earlier this test built `env.AE_METRICS` directly. Phase 2 Step
// G-1 routes through `bindings.metrics` (the runtime-shared
// `MetricsSink`), so the test now constructs a stub sink that
// captures writes. The "absent binding → no-op" path is satisfied
// by the runtime adapter substituting `NoopMetricsSink` when the
// underlying binding is missing.

import { describe, it, expect } from 'vitest';
import { writeMetric } from '../src/observability/metrics.js';
import { NoopMetricsSink } from '../src/runtime/cf/ae-metrics.js';
import type { Bindings, MetricsSink } from '../src/runtime/shared/interfaces.js';

function fakeEnv(withSink: boolean): {
  env: Bindings;
  writes: Array<{ blobs: string[]; doubles: number[]; indexes: string[] }>;
} {
  const writes: Array<{ blobs: string[]; doubles: number[]; indexes: string[] }> = [];
  const sink: MetricsSink = withSink
    ? {
        write: (point) => {
          writes.push({
            blobs: [...point.blobs],
            doubles: [...point.doubles],
            indexes: [...point.indexes],
          });
        },
      }
    : new NoopMetricsSink();
  // Only `metrics` is exercised; the rest of `Bindings` is left as
  // typed-but-unset via cast.
  return { env: { metrics: sink } as unknown as Bindings, writes };
}

describe('observability/metrics', () => {
  it('writes through to the metrics sink when present', () => {
    const { env, writes } = fakeEnv(true);
    writeMetric(env, 'query_executions', {
      blobs: ['ns_x', 'openai-text-embedding-3-large-1536', 'hybrid_rrf', 'full', 'success'],
      doubles: [123, 5, 2],
      indexes: ['ten_x'],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.blobs[0]).toBe('query_executions');
    expect(writes[0]!.blobs.slice(1)).toEqual([
      'ns_x',
      'openai-text-embedding-3-large-1536',
      'hybrid_rrf',
      'full',
      'success',
    ]);
    expect(writes[0]!.doubles).toEqual([123, 5, 2]);
    expect(writes[0]!.indexes).toEqual(['ten_x']);
  });

  it('is a no-op when the runtime adapter wires NoopMetricsSink', () => {
    const { env, writes } = fakeEnv(false);
    expect(() =>
      writeMetric(env, 'ingestion_stage_outcomes', {
        blobs: ['fetch', 'completed', ''],
        doubles: [42],
        indexes: ['ten_x'],
      }),
    ).not.toThrow();
    expect(writes).toHaveLength(0);
  });

  it('routes each dataset name into blob[0]', () => {
    const { env, writes } = fakeEnv(true);
    writeMetric(env, 'query_executions', { blobs: [], doubles: [], indexes: ['t'] });
    writeMetric(env, 'ingestion_stage_outcomes', { blobs: [], doubles: [], indexes: ['t'] });
    writeMetric(env, 'provider_calls', { blobs: [], doubles: [], indexes: ['t'] });
    expect(writes.map((w) => w.blobs[0])).toEqual([
      'query_executions',
      'ingestion_stage_outcomes',
      'provider_calls',
    ]);
  });
});
