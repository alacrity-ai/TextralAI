import { describe, it, expect, vi, afterEach } from 'vitest';
import { openaiDirect } from '../src/providers/openai-compat.js';

const FAKE_KEY = 'sk-proj-fakefakefakefakefakefakefakefake';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOnce(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValueOnce(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers,
    }),
  );
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

describe('OpenAICompatProvider construction', () => {
  it('returns dimensions for known models', () => {
    expect(openaiDirect.dimensions('text-embedding-3-large')).toBe(3072);
    expect(openaiDirect.dimensions('text-embedding-3-small')).toBe(1536);
  });

  it('throws on unknown embedding models', () => {
    expect(() => openaiDirect.dimensions('made-up')).toThrow();
  });
});

describe('OpenAICompatProvider.chat — fixture paths', () => {
  it('returns success on a valid 200 response', async () => {
    mockFetchOnce({
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    });

    const r = await openaiDirect.chat(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      expect(r.value.content).toBe('hello');
      expect(r.value.usage.input_tokens).toBe(4);
      expect(r.value.finish_reason).toBe('stop');
    }
  });

  it('returns success with parsed JSON when response_format is json_schema', async () => {
    mockFetchOnce({
      choices: [{ message: { content: '{"ok":true,"n":3}' }, finish_reason: 'stop' }],
      model: 'gpt-4o',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const r = await openaiDirect.chat(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'json me' }],
        response_format: {
          type: 'json_schema',
          schema: { type: 'object' },
          name: 'X',
          strict: true,
        },
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      expect(r.value.parsed).toEqual({ ok: true, n: 3 });
    }
  });

  it('returns fatal_error type=refusal when message.refusal is present', async () => {
    const fetchMock = mockFetchOnce({
      choices: [
        {
          message: { content: '', refusal: 'Cannot comply.' },
          finish_reason: 'content_filter',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    });
    const r = await openaiDirect.chat(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'verboten' }] },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('fatal_error');
    if (r.outcome === 'fatal_error') {
      expect(r.error.type).toBe('refusal');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retries on refusal
  });

  it('retries on schema_violation and yields retryable_error after 3 attempts', async () => {
    const bad = new Response(
      JSON.stringify({
        choices: [{ message: { content: 'not-json{' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200 },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(bad.clone())
      .mockResolvedValueOnce(bad.clone())
      .mockResolvedValueOnce(bad.clone());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const r = await openaiDirect.chat(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'json me' }],
        response_format: { type: 'json_object' },
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('schema_violation');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);

  it('returns degraded_success with malformed_response warning when usage is missing', async () => {
    mockFetchOnce({
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      // usage absent
      model: 'gpt-4o',
    });
    const r = await openaiDirect.chat(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('degraded_success');
    if (r.outcome === 'degraded_success') {
      expect(r.value.content).toBe('hello');
      expect(r.warning.type).toBe('malformed_response');
    }
  });

  it('returns fatal_error on 429 + insufficient_quota with NO retries — v1 regression', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'insufficient_quota',
            message: 'You exceeded your current quota.',
          },
        }),
        { status: 429 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const r = await openaiDirect.chat(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('fatal_error');
    if (r.outcome === 'fatal_error') {
      expect(r.error.type).toBe('insufficient_quota');
      expect(r.error.status).toBe(429);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.meta.latency_ms).toBeLessThan(500);
  });

  it('returns fatal_error on 401 invalid_api_key with no retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad' } }), {
        status: 401,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const r = await openaiDirect.chat(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: 'sk-invalid' },
    );
    expect(r.outcome).toBe('fatal_error');
    if (r.outcome === 'fatal_error') {
      expect(r.error.type).toBe('invalid_api_key');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries up to 3 times on transient 429 (no quota code)', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 }),
        ),
      );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const r = await openaiDirect.chat(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('rate_limit');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);

  it('retries up to 3 times on 503 server errors', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('{}', { status: 503 })));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const r = await openaiDirect.chat(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('server_error');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);
});

describe('OpenAICompatProvider.embed', () => {
  it('returns 100 vectors for 100 inputs', async () => {
    const vectors = Array.from({ length: 100 }, (_, i) => ({
      embedding: Array(8).fill(i / 100),
    }));
    mockFetchOnce({
      data: vectors,
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 100 },
    });
    const r = await openaiDirect.embed(
      {
        model: 'text-embedding-3-small',
        input: Array(100).fill('hi'),
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      expect(r.value.vectors).toHaveLength(100);
    }
  });

  it('partial-batch yields retryable_error after 3 attempts', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: Array.from({ length: 99 }, () => ({ embedding: [0, 0, 0] })),
            model: 'text-embedding-3-small',
          }),
          { status: 200 },
        ),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const r = await openaiDirect.embed(
      { model: 'text-embedding-3-small', input: Array(100).fill('hi') },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('partial_batch');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);

  it('insufficient_quota → fatal with zero retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'no $$' } }), {
        status: 429,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const r = await openaiDirect.embed(
      { model: 'text-embedding-3-small', input: ['ping'] },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('fatal_error');
    if (r.outcome === 'fatal_error') {
      expect(r.error.type).toBe('insufficient_quota');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAICompatProvider.stream', () => {
  it('emits token / usage / done events from a fixtured SSE stream', async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(events, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const out: unknown[] = [];
    for await (const ev of openaiDirect.stream(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: FAKE_KEY },
    )) {
      out.push(ev);
    }
    const tokens = out
      .filter(
        (e): e is { type: 'token'; delta: string } => (e as { type: string }).type === 'token',
      )
      .map((e) => e.delta);
    expect(tokens).toEqual(['He', 'llo', ' ', 'world', '!']);
    const usage = out.find(
      (e): e is { type: 'usage'; usage: { input_tokens: number; output_tokens: number } } =>
        (e as { type: string }).type === 'usage',
    );
    expect(usage?.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
    expect(out.at(-1)).toEqual({ type: 'done' });
  });

  it('emits a single error event on a 401 and ends', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad' } }), {
        status: 401,
      }),
    ) as unknown as typeof globalThis.fetch;

    const out: unknown[] = [];
    for await (const ev of openaiDirect.stream(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: 'sk-bad' },
    )) {
      out.push(ev);
    }
    expect(out).toHaveLength(1);
    const ev = out[0] as { type: string; error: { type: string } };
    expect(ev.type).toBe('error');
    expect(ev.error.type).toBe('invalid_api_key');
  });
});
