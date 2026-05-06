// Phase 7 — eval route tests.
//
// Covers register-set / list / get-set / list-runs / get-run-detail.
// The actual run path is tested in eval-judges.test.ts (which mocks
// the chat upstream).

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { hmacKey } from '../src/auth/api-key.js';
import { readPepper } from '../src/auth/pepper.js';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

interface ApiKey {
  id: string;
  raw: string;
}

async function seedApiKey(e: Env, tenantId: string): Promise<ApiKey> {
  const id = newId('ak');
  const raw = `sk-textral-${Math.random().toString(36).slice(2)}`;
  const pepper = await readPepper(e);
  const hash = await hmacKey(pepper, raw);
  await e.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, tenantId, hash, raw.slice(0, 12), JSON.stringify(['*']), Date.now())
    .run();
  return { id, raw };
}

async function seedTenantWithNamespace(
  e: Env,
): Promise<{ tenantId: string; slug: string; nsId: string; apiKey: ApiKey }> {
  const tenantId = `ten_${Math.random().toString(36).slice(2, 10)}`;
  const slug = `ns-${Math.random().toString(36).slice(2, 8)}`;
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'Eval Test', Date.now())
    .run();
  const nsId = newId('ns');
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, ?, 'generic', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(nsId, tenantId, slug, Date.now())
    .run();
  const apiKey = await seedApiKey(e, tenantId);
  return { tenantId, slug, nsId, apiKey };
}

describe('Phase 7 — eval routes', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM eval_results`).run();
    await e.DB.prepare(`DELETE FROM eval_runs`).run();
    await e.DB.prepare(`DELETE FROM eval_questions`).run();
    await e.DB.prepare(`DELETE FROM eval_sets`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM api_keys`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('POST register set returns the new id + questions', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantWithNamespace(e);
    const res = await callJson(
      e,
      'POST',
      `http://x/v1/namespaces/${seed.slug}/eval-sets`,
      { 'x-textral-api-key': seed.apiKey.raw },
      {
        name: 'baseline-v1',
        questions: [
          { question: 'Where was Alexandria?' },
          { question: 'Who was Hypatia?' },
        ],
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      questions: Array<{ id: string; question: string }>;
    };
    expect(body.id).toMatch(/^evset_/);
    expect(body.name).toBe('baseline-v1');
    expect(body.questions).toHaveLength(2);
    expect(body.questions[0]!.id).toMatch(/^evq_/);
  });

  it('duplicate set name returns 409', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantWithNamespace(e);
    const body = {
      name: 'baseline',
      questions: [{ question: 'Q1?' }],
    };
    const r1 = await callJson(
      e,
      'POST',
      `http://x/v1/namespaces/${seed.slug}/eval-sets`,
      { 'x-textral-api-key': seed.apiKey.raw },
      body,
    );
    expect(r1.status).toBe(200);
    const r2 = await callJson(
      e,
      'POST',
      `http://x/v1/namespaces/${seed.slug}/eval-sets`,
      { 'x-textral-api-key': seed.apiKey.raw },
      body,
    );
    expect(r2.status).toBe(409);
  });

  it('GET set returns set + questions', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantWithNamespace(e);
    const create = await callJson(
      e,
      'POST',
      `http://x/v1/namespaces/${seed.slug}/eval-sets`,
      { 'x-textral-api-key': seed.apiKey.raw },
      { name: 'baseline', questions: [{ question: 'Q1?' }] },
    );
    const setId = ((await create.json()) as { id: string }).id;
    const get = await callJson(
      e,
      'GET',
      `http://x/v1/namespaces/${seed.slug}/eval-sets/${setId}`,
      { 'x-textral-api-key': seed.apiKey.raw },
    );
    expect(get.status).toBe(200);
    const detail = (await get.json()) as { questions: Array<{ question: string }> };
    expect(detail.questions[0]!.question).toBe('Q1?');
  });

  it('cross-tenant GET set returns 404', async () => {
    const e = env as unknown as Env;
    const a = await seedTenantWithNamespace(e);
    const b = await seedTenantWithNamespace(e);
    const create = await callJson(
      e,
      'POST',
      `http://x/v1/namespaces/${b.slug}/eval-sets`,
      { 'x-textral-api-key': b.apiKey.raw },
      { name: 'b-baseline', questions: [{ question: 'Q1?' }] },
    );
    const setId = ((await create.json()) as { id: string }).id;
    // Tenant A tries to read tenant B's set.
    const res = await callJson(
      e,
      'GET',
      `http://x/v1/namespaces/${b.slug}/eval-sets/${setId}`,
      { 'x-textral-api-key': a.apiKey.raw },
    );
    expect(res.status).toBe(404);
  });

  it('GET runs returns empty list before any runs', async () => {
    const e = env as unknown as Env;
    const seed = await seedTenantWithNamespace(e);
    const create = await callJson(
      e,
      'POST',
      `http://x/v1/namespaces/${seed.slug}/eval-sets`,
      { 'x-textral-api-key': seed.apiKey.raw },
      { name: 'baseline', questions: [{ question: 'Q1?' }] },
    );
    const setId = ((await create.json()) as { id: string }).id;
    const list = await callJson(
      e,
      'GET',
      `http://x/v1/namespaces/${seed.slug}/eval-sets/${setId}/runs`,
      { 'x-textral-api-key': seed.apiKey.raw },
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });
});
