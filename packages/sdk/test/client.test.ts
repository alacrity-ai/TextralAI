import { describe, it, expect, vi } from 'vitest';
import { TextralClient, TextralApiError } from '../src/index.js';

function mockFetchOk(body: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;
}

function mockFetchErr(status: number, body: unknown): typeof globalThis.fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;
}

describe('TextralClient', () => {
  it('attaches X-Textral-Api-Key on every call', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const c = new TextralClient({ baseUrl: 'http://x', apiKey: 'tx_test_abc', fetch });
    await c.namespaces.list();
    const call = (fetch as unknown as { mock: { calls: Parameters<typeof globalThis.fetch>[] } }).mock.calls[0]!;
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-textral-api-key']).toBe('tx_test_abc');
    expect(headers.accept).toBe('application/json');
  });

  it('serializes JSON bodies on POST', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'ns_x', slug: 'leases' }), { status: 201 }),
    ) as unknown as typeof globalThis.fetch;
    const c = new TextralClient({ baseUrl: 'http://x', apiKey: 'k', fetch });
    await c.namespaces.create({ slug: 'leases' });
    const init = (fetch as unknown as { mock: { calls: Parameters<typeof globalThis.fetch>[] } }).mock
      .calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ slug: 'leases' }));
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('throws TextralApiError on the standard error envelope', async () => {
    const c = new TextralClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch: mockFetchErr(404, {
        error: { code: 'NAMESPACE_NOT_FOUND', message: 'Namespace not found: x' },
      }),
    });
    await expect(c.namespaces.get('nope')).rejects.toMatchObject({
      status: 404,
      code: 'NAMESPACE_NOT_FOUND',
    });
  });

  it('falls back to UNKNOWN on non-envelope error bodies', async () => {
    const fetch = vi.fn(async () =>
      new Response('Internal Server Error', { status: 500 }),
    ) as unknown as typeof globalThis.fetch;
    const c = new TextralClient({ baseUrl: 'http://x', apiKey: 'k', fetch });
    try {
      await c.namespaces.list();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TextralApiError);
      expect((e as TextralApiError).code).toBe('UNKNOWN');
      expect((e as TextralApiError).status).toBe(500);
    }
  });

  it('returns undefined on 204 No Content', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;
    const c = new TextralClient({ baseUrl: 'http://x', apiKey: 'k', fetch });
    const r = await c.ingestionJobs.retry('job_x');
    expect(r).toBeUndefined();
  });

  it('serializes query params via the qs helper, omitting undefined', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [], next_cursor: null }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const c = new TextralClient({ baseUrl: 'http://x', apiKey: 'k', fetch });
    await c.queryEvents.list({ limit: 50, namespace_slug: 'leases' });
    const url = (fetch as unknown as { mock: { calls: Parameters<typeof globalThis.fetch>[] } }).mock
      .calls[0]![0] as string;
    expect(url).toBe('http://x/v1/query-events?limit=50&namespace_slug=leases');
  });

  it('keeps absolute upload URLs absolute', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch;
    const c = new TextralClient({ baseUrl: 'http://x', apiKey: 'k', fetch });
    await c.documents.putUploadBytes('http://other:9000/path', new Uint8Array([1, 2]), 'text/plain');
    const url = (fetch as unknown as { mock: { calls: Parameters<typeof globalThis.fetch>[] } }).mock
      .calls[0]![0] as string;
    expect(url).toBe('http://other:9000/path');
  });
});
// Silence unused import; kept for future fixtures.
void mockFetchOk;
