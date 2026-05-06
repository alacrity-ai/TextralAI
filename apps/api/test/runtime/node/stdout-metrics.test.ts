// StdoutMetricsSink writes one JSON line per data point. Operators
// forward stdout to whatever observability backend they prefer
// (Loki, Datadog, ELK, ClickHouse). The shape must be parseable as
// strict JSON and carry `kind: 'metric'` plus the indexes/doubles/blobs
// the caller passed in.

import { describe, it, expect, vi } from 'vitest';
import { StdoutMetricsSink } from '../../../src/runtime/node/stdout-metrics.js';

describe('StdoutMetricsSink', () => {
  it('emits one JSON line per write', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sink = new StdoutMetricsSink();
    sink.write({
      indexes: ['provider:openai', 'model:gpt-4'],
      doubles: [1.5, 200],
      blobs: ['rid_123'],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      kind: 'metric',
      indexes: ['provider:openai', 'model:gpt-4'],
      doubles: [1.5, 200],
      blobs: ['rid_123'],
    });
    spy.mockRestore();
  });

  it('does not throw on empty arrays', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sink = new StdoutMetricsSink();
    sink.write({ indexes: [], doubles: [], blobs: [] });
    const line = spy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(line)).toEqual({
      kind: 'metric',
      indexes: [],
      doubles: [],
      blobs: [],
    });
    spy.mockRestore();
  });
});
