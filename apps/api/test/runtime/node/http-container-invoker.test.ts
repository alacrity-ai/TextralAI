// HttpContainerInvoker — mocked-fetch unit test.
//
// api → Container has NO HMAC layer (the Container's `/jobs/run`
// endpoint is reachable only on the internal docker network). The
// HMAC scheme covers the inverse direction (Container → Worker
// callbacks) and is exercised by `internal-auth.test.ts`.
//
// What we cover:
//   - URL construction (host + default port 8000 + /jobs/run)
//   - 2xx → status+outcome
//   - 5xx → status+error (truncated)
//   - 409/423 ack-on-terminal handling is in `runIngestMessage`,
//     not the invoker — verified by ingest-message tests.
//   - Network failure → `{ status: 0, error: <message> }`

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpContainerInvoker } from '../../../src/runtime/node/http-container-invoker.js';

const ORIG_FETCH = globalThis.fetch;

beforeEach(() => {
  // Re-stub on every test so spies don't leak.
  globalThis.fetch = vi.fn();
});
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe('HttpContainerInvoker', () => {
  it('POSTs to http://<host>:8000/jobs/run with the args body', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'full_success' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const invoker = new HttpContainerInvoker({ host: 'ingest' });
    const result = await invoker.invoke({ job_id: 'job_1', attempt: 0 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://ingest:8000/jobs/run');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      job_id: 'job_1',
      attempt: 0,
    });
    expect(result).toEqual({ status: 200, outcome: 'full_success' });
  });

  it('honors a custom port', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const invoker = new HttpContainerInvoker({ host: 'localhost', port: 9001 });
    await invoker.invoke({ job_id: 'job_2', attempt: 0 });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://localhost:9001/jobs/run');
  });

  it('returns status + truncated error on 5xx', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const longBody = 'x'.repeat(500);
    fetchSpy.mockResolvedValue(new Response(longBody, { status: 503 }));
    const invoker = new HttpContainerInvoker({ host: 'ingest' });
    const result = await invoker.invoke({ job_id: 'job_3', attempt: 1 });
    expect(result.status).toBe(503);
    expect(result.error?.length).toBe(200);
    expect(result.outcome).toBeUndefined();
  });

  it('surfaces network failures as status:0', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const invoker = new HttpContainerInvoker({ host: 'ingest' });
    const result = await invoker.invoke({ job_id: 'job_4', attempt: 0 });
    expect(result.status).toBe(0);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('omits outcome when 2xx body has none', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const invoker = new HttpContainerInvoker({ host: 'ingest' });
    const result = await invoker.invoke({ job_id: 'job_5', attempt: 0 });
    expect(result).toEqual({ status: 200 });
  });
});
