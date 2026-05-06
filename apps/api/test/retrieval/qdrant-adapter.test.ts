// Pin the wire-shape contract for the Qdrant REST adapter:
//   - upsert: chunk_id stored in payload; UUIDv5 used as point id
//   - query: filter shape uses Qdrant's must/match/any
//   - deleteByIds: each chunk_id mapped to UUIDv5
//   - ensureBackingExists: GET → 404 → PUT collection + payload indexes

import { describe, it, expect, vi, afterEach } from 'vitest';
import { QdrantAdapter } from '../../src/retrieval/adapters/qdrant.js';

afterEach(() => vi.restoreAllMocks());

const cfg = {
  url: 'http://qdrant:6333',
  collection: 'test-coll',
  dimensions: 1536,
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

describe('QdrantAdapter', () => {
  it('ensureBackingExists creates the collection on 404 and adds payload indexes', async () => {
    const fn = mockFetch({
      '/collections/test-coll': (init) => {
        if (init.method === 'GET') return new Response('not found', { status: 404 });
        if (init.method === 'PUT') return new Response('{"result":true}', { status: 200 });
        return new Response('?', { status: 500 });
      },
      '/collections/test-coll/index': () => new Response('{"result":true}', { status: 200 }),
    });
    const a = new QdrantAdapter(cfg);
    await a.ensureBackingExists();
    // GET (probe), PUT (create), 3× PUT (indexes for tenant_id, version_id, artifact_type).
    expect(fn.mock.calls).toHaveLength(5);
  });

  it('ensureBackingExists is a no-op when collection already exists', async () => {
    const fn = mockFetch({
      '/collections/test-coll': (init) => {
        if (init.method === 'GET') return new Response('{"result":{}}', { status: 200 });
        return new Response('?', { status: 500 });
      },
    });
    const a = new QdrantAdapter(cfg);
    await a.ensureBackingExists();
    expect(fn.mock.calls).toHaveLength(1);
  });

  it('upsert sends chunk_id in payload + UUIDv5 as point id', async () => {
    let captured: unknown;
    mockFetch({
      '/collections/test-coll/points?wait=true': (init) => {
        captured = JSON.parse(String(init.body));
        return new Response('{"result":{}}', { status: 200 });
      },
    });
    const a = new QdrantAdapter(cfg);
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
    const points = (
      captured as { points: Array<{ id: string; payload: { chunk_id: string; tenant_id: string } }> }
    ).points;
    expect(points).toHaveLength(1);
    expect(points[0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(points[0]!.payload.chunk_id).toBe('chk_ver_test_00000');
    expect(points[0]!.payload.tenant_id).toBe('ten_a');
  });

  it('query translates filter shape correctly', async () => {
    let captured: unknown;
    mockFetch({
      '/collections/test-coll/points/search': (init) => {
        captured = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            result: [{ id: 'x', score: 0.9, payload: { chunk_id: 'chk_a' } }],
          }),
          { status: 200 },
        );
      },
    });
    const a = new QdrantAdapter(cfg);
    const res = await a.query([0, 0, 0], {
      topK: 5,
      filter: {
        tenant_id: 't',
        namespace_id: 'n',
        version_id: { $in: ['v1', 'v2'] },
      },
    });
    expect(res).toEqual([{ chunk_id: 'chk_a', score: 0.9 }]);
    const body = captured as {
      filter: { must: Array<{ key: string; match: unknown }> };
    };
    expect(body.filter.must.find((m) => m.key === 'tenant_id')!.match).toEqual({
      value: 't',
    });
    expect(body.filter.must.find((m) => m.key === 'version_id')!.match).toEqual({
      any: ['v1', 'v2'],
    });
  });

  it('deleteByIds maps each chunk_id to UUIDv5', async () => {
    let captured: unknown;
    mockFetch({
      '/collections/test-coll/points/delete?wait=true': (init) => {
        captured = JSON.parse(String(init.body));
        return new Response('{"result":{}}', { status: 200 });
      },
    });
    const a = new QdrantAdapter(cfg);
    const r = await a.deleteByIds(['chk_a', 'chk_b']);
    expect(r.count).toBe(2);
    const points = (captured as { points: string[] }).points;
    expect(points).toHaveLength(2);
    expect(points[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(points[1]).toMatch(/^[0-9a-f-]{36}$/);
    // Same input → same UUIDv5.
    const a2 = new QdrantAdapter(cfg);
    await a2.deleteByIds(['chk_a']);
    expect((captured as { points: string[] }).points[0]).toBeTruthy();
  });

  it('upsert returns gracefully on empty input', async () => {
    const a = new QdrantAdapter(cfg);
    const r = await a.upsert([]);
    expect(r.mutation_id).toBeNull();
  });

  it('throws TextralError on upsert HTTP failure', async () => {
    mockFetch({
      '/collections/test-coll/points?wait=true': () =>
        new Response('boom', { status: 500 }),
    });
    const a = new QdrantAdapter(cfg);
    await expect(
      a.upsert([
        {
          id: 'chk_x',
          values: [0, 0],
          metadata: {
            tenant_id: 't',
            namespace_id: 'n',
            document_id: 'd',
            version_id: 'v',
            version_index_id: 'vi',
            artifact_type: 'passage',
          },
        },
      ]),
    ).rejects.toThrow(/Qdrant upsert failed/);
  });
});
