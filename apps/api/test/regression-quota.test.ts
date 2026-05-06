// v1 retry-loop regression test.
//
// In the original textral repo, an OpenAI 429 with
// `code: insufficient_quota` was incorrectly classified as a transient
// rate-limit and retried indefinitely. This test pins the corrected
// behavior: insufficient_quota is fatal, surfaced after exactly one
// fetch call, with no backoff sleep.
//
// If a future refactor accidentally re-adds the bug, this test fails
// loudly within milliseconds.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { openaiDirect } from '../src/providers/openai-compat.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('v1 retry-loop regression — insufficient_quota is fatal', () => {
  it('OpenAI chat: 429 + insufficient_quota → fatal_error, exactly one fetch, no backoff', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'insufficient_quota',
            message: 'You exceeded your current quota, please check your plan and billing details.',
          },
        }),
        { status: 429 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const t0 = Date.now();
    const r = await openaiDirect.chat(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: 'sk-proj-anykey1234567890fakefakefake' },
    );
    const elapsed = Date.now() - t0;

    expect(r.outcome).toBe('fatal_error');
    if (r.outcome === 'fatal_error') {
      expect(r.error.type).toBe('insufficient_quota');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(500); // no backoff sleep ran
  });

  it('OpenAI embed: same regression — embeddings path also short-circuits on quota', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'no $$' } }), {
        status: 429,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const r = await openaiDirect.embed(
      { model: 'text-embedding-3-small', input: ['ping'] },
      { api_key: 'sk-proj-anykey1234567890fakefakefake' },
    );
    expect(r.outcome).toBe('fatal_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('OpenAI chat: invalid_api_key (401) is fatal — no retries either', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'invalid_api_key',
            message: 'Incorrect API key provided',
          },
        }),
        { status: 401 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const r = await openaiDirect.chat(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: 'sk-bogus' },
    );
    expect(r.outcome).toBe('fatal_error');
    if (r.outcome === 'fatal_error') {
      expect(r.error.type).toBe('invalid_api_key');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
