import { describe, it, expect, vi, afterEach } from 'vitest';
import { voyageRerank } from '../src/providers/voyage-rerank.js';

const FAKE_KEY = 'voy-fakefakefakefakefakefake1234';

afterEach(() => {
  vi.restoreAllMocks();
});

function mock(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      ),
    );
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

describe('VoyageRerankProvider.rerank', () => {
  it('returns top results in score-descending order', async () => {
    const data = Array.from({ length: 30 }, (_, i) => ({
      index: i,
      relevance_score: Math.random(),
    }));
    mock({ data });
    const r = await voyageRerank.rerank(
      {
        model: 'rerank-2',
        query: 'q',
        documents: Array(30).fill('d'),
        top_n: 12,
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      const scores = r.value.results.map((x) => x.score);
      const sorted = [...scores].sort((a, b) => b - a);
      expect(scores).toEqual(sorted);
    }
  });

  it('returns retryable_error on out-of-range index', async () => {
    mock({
      data: [
        { index: 99, relevance_score: 0.5 }, // input size = 30, 99 is OOB
      ],
    });
    const r = await voyageRerank.rerank(
      {
        model: 'rerank-2',
        query: 'q',
        documents: Array(30).fill('d'),
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('malformed_response');
    }
  }, 20_000);

  it('de-duplicates duplicate indexes', async () => {
    mock({
      data: [
        { index: 5, relevance_score: 0.9 },
        { index: 5, relevance_score: 0.1 }, // ignored
        { index: 2, relevance_score: 0.7 },
      ],
    });
    const r = await voyageRerank.rerank(
      {
        model: 'rerank-2',
        query: 'q',
        documents: Array(10).fill('d'),
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      expect(r.value.results.map((x) => x.index)).toEqual([5, 2]);
    }
  });

  it('returns degraded_success when fewer than top_n are valid', async () => {
    mock({
      data: [
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.8 },
        { index: 2, relevance_score: 0.7 },
      ],
    });
    const r = await voyageRerank.rerank(
      {
        model: 'rerank-2',
        query: 'q',
        documents: Array(10).fill('d'),
        top_n: 5,
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('degraded_success');
    if (r.outcome === 'degraded_success') {
      expect(r.value.results).toHaveLength(3);
      expect(r.warning.type).toBe('partial_batch');
    }
  });

  it('returns retryable_error on missing data array', async () => {
    mock({ wrong: 'shape' });
    const r = await voyageRerank.rerank(
      {
        model: 'rerank-2',
        query: 'q',
        documents: ['a', 'b'],
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('malformed_response');
    }
  }, 20_000);

  it('returns fatal_error on 401 invalid_api_key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad' } }), {
        status: 401,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const r = await voyageRerank.rerank(
      {
        model: 'rerank-2',
        query: 'q',
        documents: ['a', 'b'],
      },
      { api_key: 'bogus' },
    );
    expect(r.outcome).toBe('fatal_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
