// Reranker integration. Stubs the Phase-2 RerankProvider to drive
// every code path: success, 5xx (transient), 429 (quota-actionable),
// missing key, empty input, no provider object.

import { describe, it, expect } from 'vitest';
import { maybeRerank } from '../src/retrieval/rerank.js';
import type { Resolved as ResolvedProvider } from '../src/providers/registry.js';
import type {
  ProviderResult,
  RerankRequest,
  RerankResponse,
  ProviderOptions,
  ProviderError,
} from '../src/providers/types.js';

function makeProvider(
  outcome: 'success' | 'fatal_error' | 'retryable_error',
  errorType?: ProviderError['type'],
  resultsOrder?: { index: number; score: number }[],
): ResolvedProvider {
  const rerank = {
    name: 'voyage' as const,
    rerank(_req: RerankRequest, _opts: ProviderOptions): Promise<ProviderResult<RerankResponse>> {
      const meta = {
        provider: 'voyage' as const,
        model: 'rerank-2',
        latency_ms: 1,
        retry_count: 0,
        via_gateway: false,
      };
      if (outcome === 'success') {
        return Promise.resolve({
          outcome: 'success',
          value: {
            results: resultsOrder ?? [
              { index: 0, score: 0.9 },
              { index: 1, score: 0.8 },
            ],
            model: 'rerank-2',
          },
          meta,
        });
      }
      const error: ProviderError = {
        type: errorType ?? 'server_error',
        provider: 'voyage' as const,
        model: 'rerank-2',
        retry_count: 0,
        safe_upstream_message: 'mocked',
      };
      return Promise.resolve({ outcome, error, meta });
    },
  };
  return { rerank, options: {} as ProviderOptions };
}

describe('maybeRerank', () => {
  const candidates = [
    { chunk_id: 'chk_a', text: 'alpha' },
    { chunk_id: 'chk_b', text: 'beta' },
    { chunk_id: 'chk_c', text: 'gamma' },
  ];

  it('disabled — emits Phase 4 backwards-compatible audit', async () => {
    const r = await maybeRerank({
      query: 'q',
      candidates,
      config: { enabled: false, top_n: 3 },
      resolved_provider: null,
    });
    expect(r.audit).toEqual({
      enabled: false,
      executed: false,
      provider: null,
      model: null,
      top_n: null,
    });
    expect(r.reordered).toEqual(['chk_a', 'chk_b', 'chk_c']);
  });

  it('success — provider order replaces candidate order', async () => {
    const r = await maybeRerank({
      query: 'q',
      candidates,
      config: { enabled: true, provider: 'voyage', model: 'rerank-2', top_n: 2 },
      resolved_provider: makeProvider('success', undefined, [
        { index: 2, score: 0.95 },
        { index: 0, score: 0.6 },
      ]),
    });
    expect(r.audit.executed).toBe(true);
    expect(r.audit.actionable).toBeUndefined();
    expect(r.reordered).toEqual(['chk_c', 'chk_a']);
  });

  it('5xx — falls back to RRF top-K with PROVIDER_UNAVAILABLE (not actionable)', async () => {
    const r = await maybeRerank({
      query: 'q',
      candidates,
      config: { enabled: true, provider: 'voyage', model: 'rerank-2', top_n: 2 },
      resolved_provider: makeProvider('retryable_error', 'server_error'),
    });
    expect(r.audit.executed).toBe(false);
    expect(r.audit.fallback_reason).toBe('PROVIDER_UNAVAILABLE');
    expect(r.audit.actionable).toBe(false);
    expect(r.reordered).toEqual(['chk_a', 'chk_b']);
  });

  it('quota — falls back with PROVIDER_QUOTA_EXHAUSTED + actionable=true', async () => {
    const r = await maybeRerank({
      query: 'q',
      candidates,
      config: { enabled: true, provider: 'voyage', model: 'rerank-2', top_n: 2 },
      resolved_provider: makeProvider('fatal_error', 'insufficient_quota'),
    });
    expect(r.audit.fallback_reason).toBe('PROVIDER_QUOTA_EXHAUSTED');
    expect(r.audit.actionable).toBe(true);
  });

  it('timeout — falls back with PROVIDER_TIMEOUT + actionable=false', async () => {
    const r = await maybeRerank({
      query: 'q',
      candidates,
      config: { enabled: true, provider: 'voyage', model: 'rerank-2', top_n: 2 },
      resolved_provider: makeProvider('retryable_error', 'timeout'),
    });
    expect(r.audit.fallback_reason).toBe('PROVIDER_TIMEOUT');
    expect(r.audit.actionable).toBe(false);
  });

  it('no provider key — PROVIDER_KEY_NOT_FOUND + actionable=true', async () => {
    const r = await maybeRerank({
      query: 'q',
      candidates,
      config: { enabled: true, provider: 'voyage', model: 'rerank-2', top_n: 2 },
      resolved_provider: null,
    });
    expect(r.audit.fallback_reason).toBe('PROVIDER_KEY_NOT_FOUND');
    expect(r.audit.actionable).toBe(true);
    expect(r.reordered).toEqual(['chk_a', 'chk_b']);
  });

  it('empty input — EMPTY_INPUT, not actionable', async () => {
    const r = await maybeRerank({
      query: 'q',
      candidates: [],
      config: { enabled: true, provider: 'voyage', model: 'rerank-2', top_n: 5 },
      resolved_provider: makeProvider('success'),
    });
    expect(r.audit.executed).toBe(false);
    expect(r.audit.fallback_reason).toBe('EMPTY_INPUT');
    expect(r.audit.actionable).toBe(false);
    expect(r.reordered).toEqual([]);
  });
});
