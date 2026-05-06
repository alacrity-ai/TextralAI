import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderHttpClient, composeAbort } from '../src/providers/lib/http-client.js';
import type { ProviderError, ProviderOptions, ProviderResult } from '../src/providers/types.js';

// A minimal concrete subclass for exercising the base class behavior.
class TestClient extends ProviderHttpClient {
  public override readonly name = 'test_provider';
  protected directBaseUrl(_model: string): string {
    return 'https://example.test/v1';
  }

  /** Drive `withRetries` directly — equivalent to what concrete providers do. */
  public run(
    args: {
      model: string;
      timeoutMs: number;
      opts: ProviderOptions;
      successValue?: unknown;
      successWarning?: ProviderError;
    },
    classify: (status: number) => ProviderError,
  ): Promise<ProviderResult<unknown>> {
    return this.withRetries({
      model: args.model,
      timeoutMs: args.timeoutMs,
      opts: args.opts,
      call: () => this.post(args.model, 'echo', { hi: 1 }, args.opts, args.timeoutMs),
      parseSuccess: (_res, _attempt) => {
        if (args.successWarning) {
          return { ok: true, value: args.successValue, warning: args.successWarning };
        }
        return { ok: true, value: args.successValue };
      },
      classifyError: (res, attempt) => ({
        ...classify(res.status),
        retry_count: attempt,
      }),
    });
  }
}

describe('composeAbort', () => {
  it('aborts when caller signal is already aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('caller_aborted'));
    const { signal, cancel } = composeAbort(ctrl.signal, 5000);
    expect(signal.aborted).toBe(true);
    cancel();
  });

  it('aborts when caller signal fires mid-flight', async () => {
    const ctrl = new AbortController();
    const { signal, cancel } = composeAbort(ctrl.signal, 5000);
    expect(signal.aborted).toBe(false);
    ctrl.abort(new Error('caller_aborted'));
    expect(signal.aborted).toBe(true);
    cancel();
  });

  it('aborts on timeout when caller signal stays open', async () => {
    const { signal, cancel } = composeAbort(undefined, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(signal.aborted).toBe(true);
    expect(String((signal.reason as Error).message)).toBe('timeout');
    cancel();
  });
});

describe('ProviderHttpClient.post', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts to direct URL when no gateway given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const c = new TestClient();
    await c.run({ model: 'm1', timeoutMs: 5000, opts: { api_key: 'k' }, successValue: 1 }, () => ({
      type: 'unknown',
      provider: 'test_provider',
      model: 'm1',
      retry_count: 0,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toBe('https://example.test/v1/echo');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer k');
    expect(headers.get('cf-aig-metadata')).toBeNull();
  });

  it('posts to gateway URL when gateway is given, with cf-aig-metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const c = new TestClient();
    await c.run(
      {
        model: 'm1',
        timeoutMs: 5000,
        opts: {
          api_key: 'k',
          gateway: {
            base_url: 'https://gateway.ai.cloudflare.com/v1/A/G',
            metadata_header_prefix: 'cf-aig-' as const,
            provider: 'openai',
          },
          request_metadata: { tenant_id: 'ten_1', namespace_id: 'ns_1' },
        },
        successValue: 1,
      },
      () => ({
        type: 'unknown',
        provider: 'test_provider',
        model: 'm1',
        retry_count: 0,
      }),
    );
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toBe('https://gateway.ai.cloudflare.com/v1/A/G/openai/echo');
    const headers = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('cf-aig-metadata')).toBe('{"tenant_id":"ten_1","namespace_id":"ns_1"}');
  });

  it('omits Authorization header when api_key is not set (binding tier)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const c = new TestClient();
    await c.run({ model: 'm', timeoutMs: 5000, opts: {}, successValue: 1 }, () => ({
      type: 'unknown',
      provider: 'test_provider',
      model: 'm',
      retry_count: 0,
    }));
    const headers = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('authorization')).toBeNull();
  });
});

describe('ProviderHttpClient.withRetries', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('emits exactly one telemetry event on a successful call', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"ok":true}', { status: 200 }),
      ) as unknown as typeof globalThis.fetch;
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const c = new TestClient();
    const r = await c.run(
      { model: 'm', timeoutMs: 5000, opts: { api_key: 'k' }, successValue: 'hi' },
      () => ({ type: 'unknown', provider: 'test_provider', model: 'm', retry_count: 0 }),
    );
    expect(r.outcome).toBe('success');
    const calls = infoSpy.mock.calls.filter((c) => c[0] === 'provider_call');
    expect(calls).toHaveLength(1);
  });

  it('short-circuits on fatal error (no retries)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad' } }), {
        status: 401,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const c = new TestClient();
    const r = await c.run(
      { model: 'm', timeoutMs: 5000, opts: { api_key: 'k' }, successValue: 1 },
      () => ({
        type: 'invalid_api_key',
        provider: 'test_provider',
        model: 'm',
        status: 401,
        retry_count: 0,
      }),
    );
    expect(r.outcome).toBe('fatal_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls.filter((c) => c[0] === 'provider_call')).toHaveLength(1);
  });

  it('retries up to 3 times on retryable then yields retryable_error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const c = new TestClient();
    const r = await c.run(
      { model: 'm', timeoutMs: 5000, opts: { api_key: 'k' }, successValue: 1 },
      () => ({
        type: 'server_error',
        provider: 'test_provider',
        model: 'm',
        status: 503,
        retry_count: 0,
      }),
    );
    expect(r.outcome).toBe('retryable_error');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(infoSpy.mock.calls.filter((c) => c[0] === 'provider_call')).toHaveLength(1);
  }, 20_000);

  it('marks via_gateway=true on meta when gateway is configured', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"ok":true}', { status: 200 }),
      ) as unknown as typeof globalThis.fetch;
    const c = new TestClient();
    const r = await c.run(
      {
        model: 'm',
        timeoutMs: 5000,
        opts: {
          api_key: 'k',
          gateway: {
            base_url: 'https://gateway.ai.cloudflare.com/v1/A/G',
            metadata_header_prefix: 'cf-aig-' as const,
            provider: 'openai',
          },
        },
        successValue: 1,
      },
      () => ({ type: 'unknown', provider: 'test_provider', model: 'm', retry_count: 0 }),
    );
    expect(r.meta.via_gateway).toBe(true);
  });

  it('caller cancellation aborts the in-flight fetch', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      // Wait for the abort signal, then throw the way fetch does.
      await new Promise<never>((_resolve, reject) => {
        const sig = init.signal as AbortSignal;
        if (sig.aborted) reject(sig.reason);
        else sig.addEventListener('abort', () => reject(sig.reason), { once: true });
      });
      throw new Error('unreachable');
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const ctrl = new AbortController();
    const c = new TestClient();
    const promise = c.run(
      {
        model: 'm',
        timeoutMs: 60_000,
        opts: { api_key: 'k', signal: ctrl.signal },
        successValue: 1,
      },
      () => ({ type: 'unknown', provider: 'test_provider', model: 'm', retry_count: 0 }),
    );
    setTimeout(() => ctrl.abort(new Error('caller_aborted')), 10);
    const r = await promise;
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.safe_upstream_message).toBe('caller cancelled');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats per-call timeout as type=timeout (retryable)', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        const sig = init.signal as AbortSignal;
        sig.addEventListener('abort', () => reject(sig.reason), { once: true });
      });
      throw new Error('unreachable');
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const c = new TestClient();
    const r = await c.run(
      { model: 'm', timeoutMs: 20, opts: { api_key: 'k' }, successValue: 1 },
      () => ({ type: 'unknown', provider: 'test_provider', model: 'm', retry_count: 0 }),
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('timeout');
    }
  }, 20_000);
});
