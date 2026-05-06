// /v1/query-events list — pagination, filters, tenant isolation.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { generateApiKey } from '../src/auth/api-key.js';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

interface SeededTenant {
  tenantId: string;
  rawKey: string;
  namespaceId: string;
  namespaceSlug: string;
}

async function seedTenant(e: Env, slug: string): Promise<SeededTenant> {
  const tenantId = `ten_${newId('ten').slice(4)}`;
  const pepper = e.API_KEY_PEPPER as unknown as string;
  const key = await generateApiKey(pepper);
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, `Tenant ${slug}`, Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(key.id, tenantId, key.hash, key.prefix, '["*"]', Date.now())
    .run();
  const nsId = newId('ns');
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, ?, 'generic', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(nsId, tenantId, slug, Date.now())
    .run();
  return { tenantId, rawKey: key.raw, namespaceId: nsId, namespaceSlug: slug };
}

interface SeedEventOpts {
  tenantId: string;
  namespaceId: string;
  /** Absolute ms timestamp the row's created_at should hold. Order
   *  matters for pagination tests; pass strictly increasing values. */
  createdAt: number;
  status?: string;
  query?: string;
  degradationLevel?: string | null;
  droppedCitations?: number[] | null;
  latencyMs?: number | null;
  candidatesReturned?: number | null;
}

async function seedEvent(e: Env, opts: SeedEventOpts): Promise<string> {
  const id = newId('qev');
  const cfg = JSON.stringify({
    namespace: 'cookbook-qdrant',
    query: opts.query ?? 'who built this?',
  });
  // The schema marks request_config_hash NOT NULL; the audit writer
  // produces it via a SHA256 of request_config. For seed rows we
  // don't care what the hash is, only that it's stable and present.
  const cfgHash = `sha256-${id}`;
  await e.DB.prepare(
    `INSERT INTO query_events
       (id, tenant_id, namespace_id, status, query_text,
        request_config, request_config_hash,
        degradation_level, dropped_citations, latency_ms, candidates_returned,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.tenantId,
      opts.namespaceId,
      opts.status ?? 'completed',
      opts.query ?? 'who built this?',
      cfg,
      cfgHash,
      opts.degradationLevel ?? 'full',
      opts.droppedCitations ? JSON.stringify(opts.droppedCitations) : null,
      opts.latencyMs ?? 1234,
      opts.candidatesReturned ?? 5,
      opts.createdAt,
    )
    .run();
  return id;
}

function call(e: Env, rawKey: string, query: string = ''): Promise<Response> {
  return callJson(e, 'GET', `http://x/v1/query-events${query}`, {
    'X-Textral-Api-Key': rawKey,
  });
}

interface ListResponse {
  data: Array<{
    id: string;
    namespace_id: string;
    status: string;
    query_text: string;
    degradation_level: string | null;
    dropped_citations: number[] | null;
    request_config: Record<string, unknown>;
    created_at: number;
  }>;
  next_cursor: string | null;
}

describe('GET /v1/query-events', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM query_events`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('returns an empty page when the tenant has no query_events', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'a-empty');

    const res = await call(e, t.rawKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.data).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it('returns events newest-first with descending created_at', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'a-order');
    const t0 = 1_700_000_000_000;
    const id1 = await seedEvent(e, { tenantId: t.tenantId, namespaceId: t.namespaceId, createdAt: t0 + 1000 });
    const id2 = await seedEvent(e, { tenantId: t.tenantId, namespaceId: t.namespaceId, createdAt: t0 + 2000 });
    const id3 = await seedEvent(e, { tenantId: t.tenantId, namespaceId: t.namespaceId, createdAt: t0 + 3000 });

    const res = await call(e, t.rawKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.data.map((r) => r.id)).toEqual([id3, id2, id1]);
    expect(body.next_cursor).toBeNull();
  });

  it('paginates via next_cursor', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'a-paging');
    const t0 = 1_700_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedEvent(e, {
          tenantId: t.tenantId,
          namespaceId: t.namespaceId,
          createdAt: t0 + i * 1000,
        }),
      );
    }
    // Newest-first: ids reversed.
    const expected = [...ids].reverse();

    const page1 = (await (await call(e, t.rawKey, '?limit=2')).json()) as ListResponse;
    expect(page1.data.map((r) => r.id)).toEqual(expected.slice(0, 2));
    expect(page1.next_cursor).toBeTruthy();

    const page2 = (await (
      await call(e, t.rawKey, `?limit=2&cursor=${page1.next_cursor}`)
    ).json()) as ListResponse;
    expect(page2.data.map((r) => r.id)).toEqual(expected.slice(2, 4));
    expect(page2.next_cursor).toBeTruthy();

    const page3 = (await (
      await call(e, t.rawKey, `?limit=2&cursor=${page2.next_cursor}`)
    ).json()) as ListResponse;
    expect(page3.data.map((r) => r.id)).toEqual(expected.slice(4));
    expect(page3.next_cursor).toBeNull();
  });

  it('rejects limit > 200 (and limit < 1)', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'a-limits');

    expect((await call(e, t.rawKey, '?limit=201')).status).toBe(400);
    expect((await call(e, t.rawKey, '?limit=0')).status).toBe(400);
    expect((await call(e, t.rawKey, '?limit=-5')).status).toBe(400);
  });

  it('filters by namespace_slug; unknown slug → empty page (no 404)', async () => {
    const e = env as unknown as Env;
    const tA = await seedTenant(e, 'ns-alpha');

    // Add a second namespace under the same tenant for a clear filter test.
    const otherNsId = newId('ns');
    await e.DB.prepare(
      `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
       VALUES (?, ?, 'ns-beta', 'generic', 'openai-text-embedding-3-large-1536', ?)`,
    )
      .bind(otherNsId, tA.tenantId, Date.now())
      .run();

    const t0 = 1_700_000_000_000;
    const a1 = await seedEvent(e, { tenantId: tA.tenantId, namespaceId: tA.namespaceId, createdAt: t0 + 1000 });
    const b1 = await seedEvent(e, { tenantId: tA.tenantId, namespaceId: otherNsId, createdAt: t0 + 2000 });
    void a1;
    void b1;

    const filterAlpha = (await (
      await call(e, tA.rawKey, '?namespace_slug=ns-alpha')
    ).json()) as ListResponse;
    expect(filterAlpha.data).toHaveLength(1);
    expect(filterAlpha.data[0]!.namespace_id).toBe(tA.namespaceId);

    const filterBeta = (await (
      await call(e, tA.rawKey, '?namespace_slug=ns-beta')
    ).json()) as ListResponse;
    expect(filterBeta.data).toHaveLength(1);
    expect(filterBeta.data[0]!.namespace_id).toBe(otherNsId);

    const unknown = (await (
      await call(e, tA.rawKey, '?namespace_slug=does-not-exist')
    ).json()) as ListResponse;
    expect(unknown.data).toEqual([]);
    expect(unknown.next_cursor).toBeNull();
  });

  it('filters by status', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'a-status');
    const t0 = 1_700_000_000_000;
    const ok = await seedEvent(e, {
      tenantId: t.tenantId,
      namespaceId: t.namespaceId,
      createdAt: t0 + 1000,
      status: 'completed',
    });
    const fail = await seedEvent(e, {
      tenantId: t.tenantId,
      namespaceId: t.namespaceId,
      createdAt: t0 + 2000,
      status: 'failed',
    });

    const onlyFailed = (await (await call(e, t.rawKey, '?status=failed')).json()) as ListResponse;
    expect(onlyFailed.data.map((r) => r.id)).toEqual([fail]);

    const onlyOk = (await (await call(e, t.rawKey, '?status=completed')).json()) as ListResponse;
    expect(onlyOk.data.map((r) => r.id)).toEqual([ok]);
  });

  it('rejects an unknown status value with 400', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'a-bad-status');
    const res = await call(e, t.rawKey, '?status=banana');
    expect(res.status).toBe(400);
  });

  it('cross-tenant isolation: tenant B never sees tenant A events', async () => {
    const e = env as unknown as Env;
    const tA = await seedTenant(e, 'iso-a');
    const tB = await seedTenant(e, 'iso-b');
    const t0 = 1_700_000_000_000;

    await seedEvent(e, { tenantId: tA.tenantId, namespaceId: tA.namespaceId, createdAt: t0 + 1000 });
    await seedEvent(e, { tenantId: tA.tenantId, namespaceId: tA.namespaceId, createdAt: t0 + 2000 });
    const b1 = await seedEvent(e, {
      tenantId: tB.tenantId,
      namespaceId: tB.namespaceId,
      createdAt: t0 + 3000,
    });

    const aResp = (await (await call(e, tA.rawKey)).json()) as ListResponse;
    expect(aResp.data).toHaveLength(2);
    expect(aResp.data.every((r) => r.namespace_id === tA.namespaceId)).toBe(true);

    const bResp = (await (await call(e, tB.rawKey)).json()) as ListResponse;
    expect(bResp.data).toHaveLength(1);
    expect(bResp.data[0]!.id).toBe(b1);
  });

  it('hydrates JSON columns: dropped_citations + request_config round-trip as parsed objects', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'a-hydrate');
    const t0 = 1_700_000_000_000;
    await seedEvent(e, {
      tenantId: t.tenantId,
      namespaceId: t.namespaceId,
      createdAt: t0 + 1000,
      droppedCitations: [3, 7, 11],
    });

    const res = await call(e, t.rawKey);
    const body = (await res.json()) as ListResponse;
    expect(body.data[0]!.dropped_citations).toEqual([3, 7, 11]);
    expect(body.data[0]!.request_config).toMatchObject({ namespace: 'cookbook-qdrant' });
  });

  it('rejects unauthenticated access (401)', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', 'http://x/v1/query-events');
    expect(res.status).toBe(401);
  });

  it('regression: GET /v1/query-events/{id} still returns the same DTO shape as before', async () => {
    const e = env as unknown as Env;
    const t = await seedTenant(e, 'regression');
    const t0 = 1_700_000_000_000;
    const id = await seedEvent(e, {
      tenantId: t.tenantId,
      namespaceId: t.namespaceId,
      createdAt: t0 + 1000,
      droppedCitations: [1, 2],
    });

    const res = await callJson(e, 'GET', `http://x/v1/query-events/${id}`, {
      'X-Textral-Api-Key': t.rawKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      tenant_id: string;
      namespace_id: string;
      status: string;
      query_text: string;
      request_config: Record<string, unknown>;
      degradation_level: string | null;
      dropped_citations: number[] | null;
    };
    expect(body.id).toBe(id);
    expect(body.tenant_id).toBe(t.tenantId);
    expect(body.namespace_id).toBe(t.namespaceId);
    expect(body.dropped_citations).toEqual([1, 2]);
    expect(body.request_config).toMatchObject({ namespace: 'cookbook-qdrant' });
  });
});
