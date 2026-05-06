import { describe, it, expect, vi, afterEach } from 'vitest';
import { anthropic } from '../src/providers/anthropic.js';

const FAKE_KEY = 'sk-ant-fakefakefakefakefakefakefakefake';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockOnce(
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

describe('AnthropicProvider.chat', () => {
  it('returns success on a plain text response', async () => {
    mockOnce({
      content: [{ type: 'text', text: 'hello' }],
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const r = await anthropic.chat(
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      expect(r.value.content).toBe('hello');
      expect(r.value.usage.input_tokens).toBe(5);
      expect(r.value.finish_reason).toBe('stop');
    }
  });

  it('returns success with parsed structured output via tool_use block', async () => {
    mockOnce({
      content: [{ type: 'tool_use', name: 'respond', input: { ok: true, n: 7 } }],
      model: 'claude-sonnet-4-6',
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    const r = await anthropic.chat(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'json me' }],
        response_format: {
          type: 'json_schema',
          name: 'respond',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      expect(r.value.parsed).toEqual({ ok: true, n: 7 });
      expect(r.value.content).toBe('');
      expect(r.value.finish_reason).toBe('tool_use');
    }
  });

  it('returns retryable_error type=schema_violation when json_schema requested but no tool_use returned', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'sorry no tool' }],
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 4 },
          }),
          { status: 200 },
        ),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const r = await anthropic.chat(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'json me' }],
        response_format: {
          type: 'json_schema',
          name: 'respond',
          schema: { type: 'object' },
        },
      },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('schema_violation');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);

  it('returns fatal_error on 401 authentication_error with no retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'bad x-api-key' },
        }),
        { status: 401 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const r = await anthropic.chat(
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: 'invalid' },
    );
    expect(r.outcome).toBe('fatal_error');
    if (r.outcome === 'fatal_error') {
      expect(r.error.type).toBe('invalid_api_key');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 rate_limit_error', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'slow down' },
          }),
          { status: 429 },
        ),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const r = await anthropic.chat(
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('rate_limit');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);

  it('retries on 529 overloaded_error', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'overloaded_error', message: 'overloaded' },
          }),
          { status: 529 },
        ),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const r = await anthropic.chat(
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: FAKE_KEY },
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('server_error');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);

  it('sends x-api-key + anthropic-version headers (no Authorization)', async () => {
    const fetchMock = mockOnce({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await anthropic.chat(
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      { api_key: FAKE_KEY },
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('x-api-key')).toBe(FAKE_KEY);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('authorization')).toBeNull();
  });
});
