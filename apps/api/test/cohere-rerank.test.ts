import { describe, it, expect, vi, afterEach } from 'vitest';
import { cohereRerank } from '../src/providers/cohere-rerank.js';

const FAKE_KEY = 'co-fakefakefakefakefakefakefake';

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

describe('CohereRerankProvider.rerank', () => {
  it('parses Cohere-shape `results` field and returns score-sorted output', async () => {
    mock({
      results: [
        { index: 1, relevance_score: 0.4 },
        { index: 0, relevance_score: 0.9 },
        { index: 2, relevance_score: 0.6 },
      ],
    });
    const r = await cohereRerank.rerank(
      {
        model: 'rerank-english-v3.0',
        query: 'q',
        documents: Array(5).fill('d'),
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      expect(r.value.results.map((x) => x.index)).toEqual([0, 2, 1]);
    }
  });

  it('rejects out-of-range indexes', async () => {
    mock({ results: [{ index: 50, relevance_score: 0.5 }] });
    const r = await cohereRerank.rerank(
      {
        model: 'rerank-english-v3.0',
        query: 'q',
        documents: ['a'],
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('retryable_error');
  }, 20_000);

  it('returns degraded_success when results < top_n', async () => {
    mock({
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.5 },
      ],
    });
    const r = await cohereRerank.rerank(
      {
        model: 'rerank-english-v3.0',
        query: 'q',
        documents: ['a', 'b', 'c', 'd'],
        top_n: 3,
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('degraded_success');
  });

  it('uses top_n in body, not top_k', async () => {
    const fetchMock = mock({
      results: [{ index: 0, relevance_score: 0.5 }],
    });
    await cohereRerank.rerank(
      {
        model: 'rerank-english-v3.0',
        query: 'q',
        documents: ['a'],
        top_n: 1,
      },
      { api_key: FAKE_KEY },
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.top_n).toBe(1);
    expect(body.top_k).toBeUndefined();
  });
});
