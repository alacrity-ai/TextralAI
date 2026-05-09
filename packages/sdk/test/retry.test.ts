// Retry policy unit tests.
//
// Covers the matrix in NODE_SDK_IMPLEMENTATION.md §5.5:
//   * 429 → success on retry
//   * 5xx exhaustion → TextralRetryExhausted
//   * non-retryable status → no retry
//   * Retry-After honored
//   * non-idempotent POSTs not retried
//   * idempotent POSTs (allowlist) retried
//   * AbortSignal mid-sleep cancels

import { describe, it, expect, vi } from 'vitest';
import {
  TextralClient,
  TextralApiError,
  TextralRetryExhausted,
  DEFAULT_RETRY,
  NO_RETRY,
} from '../src/index.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeMockFetch(
  responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let idx = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = responses[Math.min(idx, responses.length - 1)]!;
    idx++;
    const respInit: ResponseInit = { status: r.status };
    if (r.headers) respInit.headers = r.headers;
    return new Response(r.body ?? null, respInit);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('retry policy', () => {
  it('retries 429 then succeeds', async () => {
    const { fetch, calls } = makeMockFetch([
      { status: 429, body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }) },
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: { ...DEFAULT_RETRY, initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 },
    });
    const r = await c.namespaces.list();
    expect(r).toEqual({ data: [] });
    expect(calls).toHaveLength(2);
  });

  it('exhausts after maxAttempts and throws TextralRetryExhausted', async () => {
    const { fetch, calls } = makeMockFetch([
      { status: 503, body: JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } }) },
    ]);
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: { ...DEFAULT_RETRY, initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 },
    });
    await expect(c.namespaces.list()).rejects.toBeInstanceOf(TextralRetryExhausted);
    expect(calls).toHaveLength(3);
  });

  it('exposes the underlying error via cause', async () => {
    const { fetch } = makeMockFetch([
      { status: 503, body: JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } }) },
    ]);
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: { ...DEFAULT_RETRY, initialDelayMs: 1, maxAttempts: 2 },
    });
    try {
      await c.namespaces.list();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TextralRetryExhausted);
      expect((e as TextralRetryExhausted).attempts).toBe(2);
      expect((e as TextralRetryExhausted).cause).toBeInstanceOf(TextralApiError);
      expect(((e as TextralRetryExhausted).cause as TextralApiError).status).toBe(503);
    }
  });

  it('does NOT retry non-retryable status (e.g. 400)', async () => {
    const { fetch, calls } = makeMockFetch([
      { status: 400, body: JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'bad' } }) },
    ]);
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: { ...DEFAULT_RETRY, initialDelayMs: 1, maxAttempts: 3 },
    });
    await expect(c.namespaces.list()).rejects.toBeInstanceOf(TextralApiError);
    expect(calls).toHaveLength(1);
  });

  it('honors Retry-After header (seconds form)', async () => {
    const { fetch, calls } = makeMockFetch([
      {
        status: 429,
        body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow' } }),
        headers: { 'retry-after': '0' }, // 0s — honored, no real wait in tests
      },
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: {
        ...DEFAULT_RETRY,
        initialDelayMs: 5_000, // would dominate the wait without retry-after
        maxDelayMs: 5_000,
        maxAttempts: 3,
      },
    });
    const start = Date.now();
    await c.namespaces.list();
    const elapsed = Date.now() - start;
    // Retry-After: 0 should bypass the 5s exponential-backoff base.
    expect(elapsed).toBeLessThan(500);
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry POST /v1/query (not in idempotent allowlist)', async () => {
    const { fetch, calls } = makeMockFetch([
      { status: 503, body: JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } }) },
    ]);
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: { ...DEFAULT_RETRY, initialDelayMs: 1, maxAttempts: 3 },
    });
    await expect(
      c.query({
        namespace: 'x',
        query: 'q',
        embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536 },
        inference: { provider: 'openai', model: 'gpt-4o-mini' },
      }),
    ).rejects.toBeInstanceOf(TextralApiError);
    // 1 attempt — POST /v1/query not on the allowlist.
    expect(calls).toHaveLength(1);
  });

  it('retries POST /v1/ingest/bulk (in idempotent allowlist)', async () => {
    const { fetch, calls } = makeMockFetch([
      { status: 503, body: JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } }) },
      { status: 201, body: JSON.stringify({ bulk_job_id: 'bjk_x', state: 'accepted', total_files: 0, uploads: [], expires_at: 0 }) },
    ]);
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: { ...DEFAULT_RETRY, initialDelayMs: 1, maxAttempts: 3 },
    });
    const r = await c.bulkIngest.submit({
      namespace: 'x',
      config: {
        embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536 },
      } as never,
      files: [],
      on_existing: 'skip_if_unchanged',
      auto_finalize: true,
    } as never);
    expect((r as { bulk_job_id: string }).bulk_job_id).toBe('bjk_x');
    expect(calls).toHaveLength(2);
  });

  it('retries POST /v1/documents/{id}/uploads/{u}/finalize (allowlist with normalized path)', async () => {
    const { fetch, calls } = makeMockFetch([
      { status: 503, body: JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } }) },
      { status: 200, body: JSON.stringify({ version_id: 'ver_x', content_hash: 'h', source_r2_key: 'k', size_bytes: 1, content_type: 't', deduplicated: false }) },
    ]);
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: { ...DEFAULT_RETRY, initialDelayMs: 1, maxAttempts: 3 },
    });
    const r = await c.documents.finalize('doc_01HZQ123ABCDEFGHIJK0123456', 'upl_01HZQ123ABCDEFGHIJK0123456');
    expect(r.version_id).toBe('ver_x');
    expect(calls).toHaveLength(2);
  });

  it('NO_RETRY policy disables retry entirely', async () => {
    const { fetch, calls } = makeMockFetch([
      { status: 503, body: JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } }) },
    ]);
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: NO_RETRY,
    });
    await expect(c.namespaces.list()).rejects.toBeInstanceOf(TextralApiError);
    expect(calls).toHaveLength(1);
  });

  it('retry: false disables retry entirely', async () => {
    const { fetch, calls } = makeMockFetch([
      { status: 503, body: JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } }) },
    ]);
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: false,
    });
    await expect(c.namespaces.list()).rejects.toBeInstanceOf(TextralApiError);
    expect(calls).toHaveLength(1);
  });

  it('AbortSignal mid-backoff cancels the loop', async () => {
    const { fetch, calls } = makeMockFetch([
      { status: 503, body: JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } }) },
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: {
        ...DEFAULT_RETRY,
        initialDelayMs: 200,
        maxDelayMs: 200,
        maxAttempts: 3,
      },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50); // abort during the first sleep
    await expect(c.namespaces.list({ signal: ac.signal })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('onRetry hook fires on every retry attempt', async () => {
    const { fetch } = makeMockFetch([
      { status: 503, body: JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } }) },
      { status: 503, body: JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } }) },
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    const onRetry = vi.fn();
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch,
      retry: { ...DEFAULT_RETRY, initialDelayMs: 1, maxAttempts: 3, onRetry },
    });
    await c.namespaces.list();
    // Two retry events (between attempt 1→2 and attempt 2→3).
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]!.attempt).toBe(1);
    expect(onRetry.mock.calls[1]![0]!.attempt).toBe(2);
    expect(onRetry.mock.calls[0]![0]!.status).toBe(503);
  });
});
