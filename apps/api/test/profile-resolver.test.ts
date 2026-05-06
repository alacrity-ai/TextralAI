// Profile resolution: namespace → profile → request overrides → merged.
//
// The merge primitives are unit-tested in @textral/corpus-profiles.
// Here we focus on the wiring (D1 → resolver) and the surfaces a
// query route depends on.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { resolveCorpusProfile } from '../src/retrieval/profile-resolver.js';
import type { Env } from '../src/types.js';

async function seed(e: Env, corpusProfile: string): Promise<{ tenantId: string }> {
  const tenantId = `ten_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'Profile Test', Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId('ns'),
      tenantId,
      'default',
      corpusProfile,
      'openai-text-embedding-3-large-1536',
      Date.now(),
    )
    .run();
  return { tenantId };
}

describe('resolveCorpusProfile', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('returns the namespace profile by name', async () => {
    const e = env as unknown as Env;
    const { tenantId } = await seed(e, 'narrative');
    const r = await resolveCorpusProfile({
      env: e,
      tenant_id: tenantId,
      namespace_slug: 'default',
    });
    expect(r.profile.id).toBe('narrative');
    expect(r.profile.enrichment.enabled).toBe(true);
    expect(r.profile.retrieval_defaults.rerank.enabled).toBe(true);
  });

  it('applies request overrides (rerank.enabled=false)', async () => {
    const e = env as unknown as Env;
    const { tenantId } = await seed(e, 'narrative');
    const r = await resolveCorpusProfile({
      env: e,
      tenant_id: tenantId,
      namespace_slug: 'default',
      request_overrides: {
        retrieval_defaults: { rerank: { enabled: false } },
      },
    });
    expect(r.profile.retrieval_defaults.rerank.enabled).toBe(false);
    // The provider/model survive the override.
    expect(r.profile.retrieval_defaults.rerank.provider).toBe('voyage');
  });

  it('throws NAMESPACE_NOT_FOUND when slug is unknown', async () => {
    const e = env as unknown as Env;
    const { tenantId } = await seed(e, 'generic');
    await expect(
      resolveCorpusProfile({
        env: e,
        tenant_id: tenantId,
        namespace_slug: 'does-not-exist',
      }),
    ).rejects.toThrow(/Namespace not found/);
  });

  it('exposes the namespace_id and default_embedding_profile', async () => {
    const e = env as unknown as Env;
    const { tenantId } = await seed(e, 'legal');
    const r = await resolveCorpusProfile({
      env: e,
      tenant_id: tenantId,
      namespace_slug: 'default',
    });
    expect(r.namespace_id.startsWith('ns_')).toBe(true);
    expect(r.default_embedding_profile).toBe('openai-text-embedding-3-large-1536');
  });
});
