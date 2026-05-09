// TextralClient resource-by-resource tests.
//
// Goals (per NODE_SDK_IMPLEMENTATION.md §8):
//   * Per-resource happy path + one error case
//   * Constructor invariants (auth header, JSON serialization)
//   * Profile-mode lazy resolution

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TextralClient, TextralApiError } from '../src/index.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let idx = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = responses[Math.min(idx, responses.length - 1)]!;
    idx++;
    // 204/304/null-body status codes don't accept a body; pass
    // null in those cases so Response doesn't reject.
    const isNullBodyStatus = r.status === 204 || r.status === 304;
    const body =
      isNullBodyStatus
        ? null
        : typeof r.body === 'string'
          ? r.body
          : r.body !== undefined
            ? JSON.stringify(r.body)
            : null;
    const respInit: ResponseInit = { status: r.status };
    if (r.headers) respInit.headers = r.headers;
    return new Response(body, respInit);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const baseClientArgs = { baseUrl: 'http://x', apiKey: 'tx_test_abc' };

describe('TextralClient — constructor + transport invariants', () => {
  it('attaches X-Textral-Api-Key on every call', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { data: [] } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.namespaces.list();
    const init = calls[0]!.init;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-textral-api-key']).toBe('tx_test_abc');
    expect(headers.accept).toBe('application/json');
  });

  it('serializes JSON bodies on POST with content-type', async () => {
    const { fetch, calls } = makeFetch([{ status: 201, body: { id: 'ns_x', slug: 'leases' } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.namespaces.create({ slug: 'leases' });
    const init = calls[0]!.init;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ slug: 'leases' }));
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('returns undefined on 204 No Content', async () => {
    const { fetch } = makeFetch([{ status: 204 }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    const r = await c.ingestionJobs.retry('job_x');
    expect(r).toBeUndefined();
  });

  it('serializes query params via the qs helper, omitting undefined', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { data: [], next_cursor: null } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.queryEvents.list({ limit: 50, namespace_slug: 'leases' });
    expect(calls[0]!.url).toBe('http://x/v1/query-events?limit=50&namespace_slug=leases');
  });

  it('keeps absolute upload URLs absolute', async () => {
    const { fetch, calls } = makeFetch([{ status: 200 }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.documents.putUploadBytes('http://other:9000/path', new Uint8Array([1, 2]), 'text/plain');
    expect(calls[0]!.url).toBe('http://other:9000/path');
  });

  it('throws when neither baseUrl/apiKey nor profile is supplied', () => {
    expect(() => new TextralClient({})).toThrow(/either {baseUrl, apiKey} or {profile}/);
  });
});

describe('TextralClient — error envelope', () => {
  it('throws TextralApiError on the standard error envelope', async () => {
    const { fetch } = makeFetch([
      {
        status: 404,
        body: { error: { code: 'NAMESPACE_NOT_FOUND', message: 'not found', request_id: 'req_x' } },
      },
    ]);
    const c = new TextralClient({ ...baseClientArgs, fetch, retry: false });
    try {
      await c.namespaces.get('nope');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TextralApiError);
      const err = e as TextralApiError;
      expect(err.status).toBe(404);
      expect(err.code).toBe('NAMESPACE_NOT_FOUND');
      expect(err.requestId).toBe('req_x');
    }
  });

  it('falls back to UNKNOWN on non-envelope error bodies', async () => {
    const { fetch } = makeFetch([{ status: 500, body: 'Internal Server Error' }]);
    const c = new TextralClient({ ...baseClientArgs, fetch, retry: false });
    try {
      await c.namespaces.list();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TextralApiError);
      expect((e as TextralApiError).code).toBe('UNKNOWN');
      expect((e as TextralApiError).status).toBe(500);
    }
  });

  it('captures Retry-After on the error envelope', async () => {
    const { fetch } = makeFetch([
      {
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'slow' } },
        headers: { 'retry-after': '5' },
      },
    ]);
    const c = new TextralClient({ ...baseClientArgs, fetch, retry: false });
    try {
      await c.namespaces.list();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TextralApiError);
      expect((e as TextralApiError).retryAfter).toBe(5);
    }
  });
});

describe('TextralClient — namespaces resource', () => {
  it('list', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { data: [{ slug: 'a' }] } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    const r = await c.namespaces.list();
    expect(r.data).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://x/v1/namespaces');
  });

  it('get', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { slug: 'a' } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.namespaces.get('a');
    expect(calls[0]!.url).toBe('http://x/v1/namespaces/a');
  });

  it('listDocuments forwards cursor + limit (insertion order preserved)', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { data: [], next_cursor: null } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.namespaces.listDocuments('a', { cursor: 'c1', limit: 10 });
    expect(calls[0]!.url).toBe('http://x/v1/namespaces/a/documents?cursor=c1&limit=10');
  });
});

describe('TextralClient — documents resource', () => {
  it('register POSTs to the namespace-scoped documents path', async () => {
    const { fetch, calls } = makeFetch([{ status: 201, body: { id: 'doc_x' } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.documents.register('a', { title: 'foo.md' });
    expect(calls[0]!.url).toBe('http://x/v1/namespaces/a/documents');
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('createUpload POSTs the declared content-type + size', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { upload_id: 'upl_x', url: 'u' } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.documents.createUpload('doc_x', { content_type: 'text/markdown', size_bytes: 42 });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ content_type: 'text/markdown', size_bytes: 42 });
  });

  it('finalize hits the {id}/uploads/{u}/finalize path', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { version_id: 'ver_x' } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.documents.finalize('doc_x', 'upl_y');
    expect(calls[0]!.url).toBe('http://x/v1/documents/doc_x/uploads/upl_y/finalize');
  });
});

describe('TextralClient — query resource', () => {
  it('query is a callable + .stream sub-method', () => {
    const c = new TextralClient({ ...baseClientArgs });
    expect(typeof c.query).toBe('function');
    expect(typeof c.query.stream).toBe('function');
  });

  it('queryEvents.iterate pages until next_cursor is null', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { data: [{ query_event_id: 'qev_1' }, { query_event_id: 'qev_2' }], next_cursor: 'c2' } },
      { status: 200, body: { data: [{ query_event_id: 'qev_3' }], next_cursor: null } },
    ]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    const ids: string[] = [];
    for await (const ev of c.queryEvents.iterate({ namespace_slug: 'a' })) {
      ids.push((ev as unknown as { query_event_id: string }).query_event_id);
    }
    expect(ids).toEqual(['qev_1', 'qev_2', 'qev_3']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('cursor=c2');
  });
});

describe('TextralClient — provider keys + infra keys', () => {
  it('providerKeys.list', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { data: [] } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.providerKeys.list();
    expect(calls[0]!.url).toBe('http://x/v1/provider-keys');
  });

  it('infraKeys.revoke uses DELETE', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { ok: true } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.infraKeys.revoke('ikey_x');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('http://x/v1/infra-keys/ikey_x');
  });
});

describe('TextralClient — bulk ingest', () => {
  it('submit POSTs the manifest', async () => {
    const { fetch, calls } = makeFetch([{ status: 201, body: { bulk_job_id: 'bjk_x' } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await c.bulkIngest.submit({ namespace: 'a' } as any);
    expect(calls[0]!.url).toBe('http://x/v1/ingest/bulk');
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('cancel uses DELETE', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { ok: true } }]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    await c.bulkIngest.cancel('bjk_x');
    expect(calls[0]!.init.method).toBe('DELETE');
  });

  it('uploadUrlFor builds a stable absolute URL', () => {
    const c = new TextralClient({ ...baseClientArgs });
    expect(c.bulkIngest.uploadUrlFor('bjk_x', 7)).toBe('http://x/v1/ingest/bulk/bjk_x/files/7/data');
  });

  it('iterateFiles converts page numbers via the next_cursor field', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { data: [{ ordinal: 0 }], next_cursor: '2' } },
      { status: 200, body: { data: [{ ordinal: 1 }], next_cursor: null } },
    ]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    const ords: number[] = [];
    for await (const f of c.bulkIngest.iterateFiles('bjk_x')) {
      ords.push((f as unknown as { ordinal: number }).ordinal);
    }
    expect(ords).toEqual([0, 1]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('page=2');
  });
});

describe('TextralClient — admin', () => {
  it('iterateFailingJobs maps `items` → paginate `data`', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { items: [{ id: 'job_1' }, { id: 'job_2' }], next_cursor: 'c2' } },
      { status: 200, body: { items: [{ id: 'job_3' }], next_cursor: null } },
    ]);
    const c = new TextralClient({ ...baseClientArgs, fetch });
    const ids: string[] = [];
    for await (const j of c.admin.iterateFailingJobs()) {
      ids.push((j as unknown as { id: string }).id);
    }
    expect(ids).toEqual(['job_1', 'job_2', 'job_3']);
    expect(calls).toHaveLength(2);
  });
});

describe('TextralClient — profile mode', () => {
  let tmp: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sdk-profile-test-'));
    savedConfigDir = process.env.TEXTRAL_CONFIG_DIR;
    process.env.TEXTRAL_CONFIG_DIR = tmp;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.TEXTRAL_CONFIG_DIR;
    else process.env.TEXTRAL_CONFIG_DIR = savedConfigDir;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('lazy-resolves on first request when constructed with {profile}', async () => {
    const path = join(tmp, 'profiles.toml');
    writeFileSync(
      path,
      `
default = "hosted-prod"

[profiles.hosted-prod]
base_url = "http://hosted"
api_key  = "tx_live_resolved"
      `,
      'utf8',
    );
    chmodSync(path, 0o600);

    const { fetch, calls } = makeFetch([{ status: 200, body: { data: [] } }]);
    const c = new TextralClient({ profile: 'hosted-prod', fetch });
    await c.namespaces.list();
    expect(calls[0]!.url).toBe('http://hosted/v1/namespaces');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-textral-api-key']).toBe('tx_live_resolved');
  });

  it('TextralClient.fromProfile resolves up front', async () => {
    const path = join(tmp, 'profiles.toml');
    writeFileSync(
      path,
      `
[profiles.local]
base_url = "http://local"
api_key  = "tx_live_local"
      `,
      'utf8',
    );
    chmodSync(path, 0o600);

    const { fetch, calls } = makeFetch([{ status: 200, body: { data: [] } }]);
    const c = await TextralClient.fromProfile('local', { fetch });
    await c.namespaces.list();
    expect(calls[0]!.url).toBe('http://local/v1/namespaces');
  });

  it('uploadUrlFor throws when called before the first resolve in lazy mode', () => {
    const c = new TextralClient({ profile: 'hosted-prod' });
    expect(() => c.bulkIngest.uploadUrlFor('bjk_x', 0)).toThrow(/credentials not resolved/);
  });
});

describe('TextralClient — AbortSignal threading', () => {
  it('cancels an in-flight call', async () => {
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal!.reason ?? new DOMException('Aborted', 'AbortError')),
        );
      })) as unknown as typeof globalThis.fetch;
    const c = new TextralClient({ ...baseClientArgs, fetch, retry: false });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await expect(c.namespaces.list({ signal: ac.signal })).rejects.toThrow();
  });
});

// kept for symmetry; unused in current matrix
void vi;
