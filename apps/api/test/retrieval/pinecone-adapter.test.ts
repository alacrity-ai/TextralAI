// Pin the wire-shape contract for the Pinecone REST adapter.
// Mirrors the Qdrant test: mock fetch, exercise upsert / query /
// delete / ensureBackingExists; pin URL templates + headers.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PineconeAdapter } from '../../src/retrieval/adapters/pinecone.js';

afterEach(() => vi.restoreAllMocks());

const cfg = {
  host: 'https://idx-xxx.svc.us-east-1.pinecone.io',
  apiKey: 'pcsk_test',
  dimensions: 1536,
  namespace: null,
};

const cfgWithNamespace = {
  ...cfg,
  namespace: 'lighthouse-tales',
};

function mockFetch(routes: Record<string, (init: RequestInit) => Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    for (const [path, handler] of Object.entries(routes)) {
      if (String(url).endsWith(path)) return handler(init);
    }
    return new Response('not stubbed: ' + String(url), { status: 500 });
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

describe('PineconeAdapter', () => {
  it('ensureBackingExists succeeds when index responds 200', async () => {
    mockFetch({
      '/describe_index_stats': () => new Response('{}', { status: 200 }),
    });
    const a = new PineconeAdapter(cfg);
    await a.ensureBackingExists();
  });

  it('ensureBackingExists maps 404 → BAD_REQUEST with operator hint', async () => {
    mockFetch({
      '/describe_index_stats': () => new Response('not found', { status: 404 }),
    });
    const a = new PineconeAdapter(cfg);
    await expect(a.ensureBackingExists()).rejects.toThrow(/Pinecone index at .* not found/);
  });

  it('upsert sends vectors[] with id + values + metadata', async () => {
    let captured: unknown;
    let capturedHeaders: Headers | undefined;
    mockFetch({
      '/vectors/upsert': (init) => {
        captured = JSON.parse(String(init.body));
        capturedHeaders = new Headers(init.headers as HeadersInit);
        return new Response('{}', { status: 200 });
      },
    });
    const a = new PineconeAdapter(cfg);
    await a.upsert([
      {
        id: 'chk_ver_test_00000',
        values: new Array(1536).fill(0),
        metadata: {
          tenant_id: 'ten_a',
          namespace_id: 'ns_b',
          document_id: 'doc_c',
          version_id: 'ver_d',
          version_index_id: 'vidx_e',
          artifact_type: 'passage',
        },
      },
    ]);
    const body = captured as {
      vectors: Array<{ id: string; values: number[]; metadata: Record<string, string> }>;
    };
    expect(body.vectors).toHaveLength(1);
    expect(body.vectors[0]!.id).toBe('chk_ver_test_00000');
    expect(body.vectors[0]!.metadata.tenant_id).toBe('ten_a');
    expect(capturedHeaders!.get('Api-Key')).toBe('pcsk_test');
    expect(capturedHeaders!.get('X-Pinecone-API-Version')).toBe('2025-04');
  });

  it('query translates filter to $eq / $in', async () => {
    let captured: unknown;
    mockFetch({
      '/query': (init) => {
        captured = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ matches: [{ id: 'chk_a', score: 0.7 }] }),
          { status: 200 },
        );
      },
    });
    const a = new PineconeAdapter(cfg);
    const r = await a.query([0, 0, 0], {
      topK: 5,
      filter: {
        tenant_id: 't',
        namespace_id: 'n',
        artifact_type: { $in: ['passage', 'narrative.character_dossier'] },
      },
    });
    expect(r).toEqual([{ chunk_id: 'chk_a', score: 0.7 }]);
    const body = captured as {
      filter: {
        tenant_id: { $eq: string };
        artifact_type: { $in: string[] };
      };
    };
    expect(body.filter.tenant_id).toEqual({ $eq: 't' });
    expect(body.filter.artifact_type).toEqual({
      $in: ['passage', 'narrative.character_dossier'],
    });
  });

  it('deleteByIds posts ids[] verbatim', async () => {
    let captured: unknown;
    mockFetch({
      '/vectors/delete': (init) => {
        captured = JSON.parse(String(init.body));
        return new Response('{}', { status: 200 });
      },
    });
    const a = new PineconeAdapter(cfg);
    const r = await a.deleteByIds(['chk_a', 'chk_b']);
    expect(r.count).toBe(2);
    expect(captured).toEqual({ ids: ['chk_a', 'chk_b'] });
  });

  it('upsert returns gracefully on empty input', async () => {
    const a = new PineconeAdapter(cfg);
    const r = await a.upsert([]);
    expect(r.mutation_id).toBeNull();
  });

  it('throws TextralError on query HTTP failure', async () => {
    mockFetch({
      '/query': () => new Response('boom', { status: 503 }),
    });
    const a = new PineconeAdapter(cfg);
    await expect(
      a.query([0, 0], { topK: 5, filter: { tenant_id: 't', namespace_id: 'n' } }),
    ).rejects.toThrow(/Pinecone query failed/);
  });

  // Fix Plan 08 — native Pinecone namespace plumbing.
  it('omits the namespace field when cfg.namespace is null', async () => {
    let captured: Record<string, unknown> | undefined;
    mockFetch({
      '/vectors/upsert': (init) => {
        captured = JSON.parse(String(init.body));
        return new Response('{}', { status: 200 });
      },
    });
    const a = new PineconeAdapter(cfg);
    await a.upsert([
      {
        id: 'chk_a',
        values: new Array(1536).fill(0),
        metadata: {
          tenant_id: 't',
          namespace_id: 'n',
          document_id: 'd',
          version_id: 'v',
          version_index_id: 'vi',
          artifact_type: 'passage',
        },
      },
    ]);
    expect(captured).toBeDefined();
    expect('namespace' in captured!).toBe(false);
  });

  it('passes the namespace field on every operation when cfg.namespace is set', async () => {
    const captures: Record<string, Record<string, unknown>> = {};
    mockFetch({
      '/vectors/upsert': (init) => {
        captures.upsert = JSON.parse(String(init.body));
        return new Response('{}', { status: 200 });
      },
      '/query': (init) => {
        captures.query = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ matches: [] }), { status: 200 });
      },
      '/vectors/delete': (init) => {
        captures.delete = JSON.parse(String(init.body));
        return new Response('{}', { status: 200 });
      },
    });
    const a = new PineconeAdapter(cfgWithNamespace);
    await a.upsert([
      {
        id: 'chk_a',
        values: new Array(1536).fill(0),
        metadata: {
          tenant_id: 't',
          namespace_id: 'n',
          document_id: 'd',
          version_id: 'v',
          version_index_id: 'vi',
          artifact_type: 'passage',
        },
      },
    ]);
    await a.query([0, 0, 0], { topK: 5, filter: { tenant_id: 't', namespace_id: 'n' } });
    await a.deleteByIds(['chk_a']);

    expect(captures.upsert!.namespace).toBe('lighthouse-tales');
    expect(captures.query!.namespace).toBe('lighthouse-tales');
    expect(captures.delete!.namespace).toBe('lighthouse-tales');
  });
});
