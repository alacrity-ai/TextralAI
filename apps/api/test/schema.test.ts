// Quick sanity check: every Phase-1 table exists after migrations
// have been applied by the vitest-pool-workers test harness.
//
// vitest-pool-workers picks up `migrations_dir` from wrangler.toml and
// applies every SQL file in order before tests run.

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/types.js';

const EXPECTED = ['tenants', 'api_keys', 'namespaces', 'provider_keys', 'usage_records'];

describe('D1 baseline schema', () => {
  it('contains every Phase-1 table', async () => {
    const e = env as unknown as Env;
    const rows = await e.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    ).all<{ name: string }>();
    const names = (rows.results ?? []).map((r) => r.name);
    for (const tbl of EXPECTED) {
      expect(names).toContain(tbl);
    }
  });

  it('chunks has Phase-5 lineage columns', async () => {
    const e = env as unknown as Env;
    const rows = await e.DB.prepare(`PRAGMA table_info(chunks)`).all<{ name: string }>();
    const cols = (rows.results ?? []).map((r) => r.name);
    expect(cols).toContain('parent_chunk_id');
    expect(cols).toContain('enrichment_pass_id');
  });

  it('Phase-5 chunks indexes exist', async () => {
    const e = env as unknown as Env;
    const rows = await e.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chunks'`,
    ).all<{ name: string }>();
    const names = (rows.results ?? []).map((r) => r.name);
    expect(names).toContain('idx_chunks_pass');
    expect(names).toContain('idx_chunks_parent');
  });

  it('rejects a duplicate (tenant_id, slug) namespace insert', async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
      .bind('ten_test_1', 'Test', Date.now())
      .run();
    await e.DB.prepare(
      `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind('ns_a', 'ten_test_1', 'leases', 'generic', 'openai-text-embedding-3-large', Date.now())
      .run();
    await expect(
      e.DB.prepare(
        `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          'ns_b',
          'ten_test_1',
          'leases',
          'generic',
          'openai-text-embedding-3-large',
          Date.now(),
        )
        .run(),
    ).rejects.toThrow();
  });
});
