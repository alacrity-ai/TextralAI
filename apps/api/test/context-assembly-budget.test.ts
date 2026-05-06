// Per-layer budget enforcement + spill + Option A oversize-admit.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { newId } from '@textral/contracts';
import { assembleContext } from '../src/retrieval/context-assembly.js';
import type { Env } from '../src/types.js';

async function seed(): Promise<{
  tenantId: string;
  ids: { passages: string[]; summaries: string[]; dossiers: string[] };
}> {
  const e = env as unknown as Env;
  const tenantId = `ten_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await e.DB.prepare(`INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, 'Budget Test', Date.now())
    .run();
  await e.DB.prepare(
    `INSERT INTO namespaces (id, tenant_id, slug, corpus_profile, default_embedding_profile, created_at)
     VALUES (?, ?, 'default', 'narrative', 'openai-text-embedding-3-large-1536', ?)`,
  )
    .bind(newId('ns'), tenantId, Date.now())
    .run();
  const nsRow = await e.DB.prepare(`SELECT id FROM namespaces WHERE tenant_id = ? LIMIT 1`)
    .bind(tenantId)
    .first<{ id: string }>();
  const docId = newId('doc');
  await e.DB.prepare(
    `INSERT INTO documents (id, tenant_id, namespace_id, current_version_id, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
  )
    .bind(docId, tenantId, nsRow!.id, Date.now())
    .run();
  const verId = newId('ver');
  await e.DB.prepare(
    `INSERT INTO document_versions
       (id, document_id, tenant_id, content_hash, source_r2_key, content_type, size_bytes, created_at)
     VALUES (?, ?, ?, 'h', 'k', 'text/plain', 100, ?)`,
  )
    .bind(verId, docId, tenantId, Date.now())
    .run();
  const vidxId = newId('vidx');
  await e.DB.prepare(
    `INSERT INTO version_indexes
       (id, version_id, tenant_id, chunking_profile, chunking_target_tokens,
        chunking_overlap_tokens, embedding_profile, embedding_provider, embedding_model,
        embedding_dimensions, distance_metric, corpus_profile, enrichment_config, status, created_at)
     VALUES (?, ?, ?, 'generic', 600, 80,
             'openai-text-embedding-3-large-1536', 'openai', 'text-embedding-3-large',
             1536, 'cosine', 'narrative', '{}', 'ready', ?)`,
  )
    .bind(vidxId, verId, tenantId, Date.now())
    .run();

  async function insertChunk(id: string, artifactType: string, body: string): Promise<string> {
    await e.DB.prepare(
      `INSERT INTO chunks
         (id, tenant_id, namespace_id, document_id, version_id, version_index_id,
          artifact_type, section_path, ord, text,
          embedding_profile, chunking_profile, embedding_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '/', 0, ?,
               'openai-text-embedding-3-large-1536', 'generic', 'embedded', ?)`,
    )
      .bind(
        id,
        tenantId,
        nsRow!.id,
        docId,
        verId,
        vidxId,
        artifactType,
        body,
        Date.now(),
      )
      .run();
    return id;
  }

  const passages: string[] = [];
  const summaries: string[] = [];
  const dossiers: string[] = [];
  // Short bodies — keep tokenized cost low so per-layer caps can be
  // sliced without overflowing on the first chunk. Real chunks are
  // larger; this test isolates budget logic from chunk-size mass.
  const longish = (label: string) =>
    Array.from({ length: 30 }, (_, i) => `${label}${i}`).join(' ');
  for (let i = 0; i < 5; i++) {
    passages.push(await insertChunk(`chk_p_${i}`, 'passage', longish(`p${i}`)));
  }
  for (let i = 0; i < 5; i++) {
    summaries.push(
      await insertChunk(`chk_s_${i}`, 'narrative.section_summary', longish(`s${i}`)),
    );
  }
  for (let i = 0; i < 5; i++) {
    dossiers.push(
      await insertChunk(`chk_d_${i}`, 'narrative.character_dossier', longish(`d${i}`)),
    );
  }
  return {
    tenantId,
    ids: { passages, summaries, dossiers },
  };
}

describe('assembleContext — per-layer budget', () => {
  beforeEach(async () => {
    const e = env as unknown as Env;
    await e.DB.prepare(`DELETE FROM chunks`).run();
    await e.DB.prepare(`DELETE FROM version_indexes`).run();
    await e.DB.prepare(`DELETE FROM document_versions`).run();
    await e.DB.prepare(`DELETE FROM documents`).run();
    await e.DB.prepare(`DELETE FROM namespaces`).run();
    await e.DB.prepare(`DELETE FROM tenants`).run();
  });

  it('respects per-layer caps', async () => {
    const e = env as unknown as Env;
    const { tenantId, ids } = await seed();
    const fused = [
      ...ids.passages.map((id) => ({ chunk_id: id, score: 1 })),
      ...ids.summaries.map((id) => ({ chunk_id: id, score: 1 })),
      ...ids.dossiers.map((id) => ({ chunk_id: id, score: 1 })),
    ];
    const r = await assembleContext(e, {
      fused,
      tenant_id: tenantId,
      max_context_tokens: 6000,
      layer_budgets: {
        passage: 0.5,
        'narrative.section_summary': 0.3,
        'narrative.character_dossier': 0.2,
      },
      layer_order: [
        'passage',
        'narrative.section_summary',
        'narrative.character_dossier',
      ],
    });
    const types = r.included.map((x) => x.artifact_type);
    expect(types).toContain('passage');
    expect(types).toContain('narrative.section_summary');
    expect(types).toContain('narrative.character_dossier');
    expect(r.total_tokens).toBeLessThanOrEqual(6000);
    // Passages get the largest chunk count (highest cap, biggest bucket).
    const passageCount = types.filter((t) => t === 'passage').length;
    const dossierCount = types.filter((t) => t === 'narrative.character_dossier').length;
    expect(passageCount).toBeGreaterThanOrEqual(dossierCount);
  });

  it('spills unused budget from an empty mid-layer to the next', async () => {
    const e = env as unknown as Env;
    const { tenantId, ids } = await seed();
    // No dossiers in fused → that layer is empty; its budget spills
    // forward to passage.
    const fused = [
      ...ids.summaries.map((id) => ({ chunk_id: id, score: 1 })),
      ...ids.passages.map((id) => ({ chunk_id: id, score: 1 })),
    ];
    const r = await assembleContext(e, {
      fused,
      tenant_id: tenantId,
      max_context_tokens: 6000,
      layer_budgets: {
        passage: 0.4,
        'narrative.character_dossier': 0.4,
        'narrative.section_summary': 0.2,
      },
      layer_order: [
        'narrative.character_dossier', // empty bucket — spills to next
        'narrative.section_summary',
        'passage',
      ],
    });
    const types = r.included.map((x) => x.artifact_type);
    expect(types).not.toContain('narrative.character_dossier');
    expect(types).toContain('narrative.section_summary');
    expect(types).toContain('passage');
  });

  it('drops chunks of artifact_types not in the layer_order set', async () => {
    const e = env as unknown as Env;
    const { tenantId, ids } = await seed();
    // Only declare passages → summaries + dossiers should be excluded.
    const fused = [
      ...ids.passages.map((id) => ({ chunk_id: id, score: 1 })),
      ...ids.summaries.map((id) => ({ chunk_id: id, score: 1 })),
    ];
    const r = await assembleContext(e, {
      fused,
      tenant_id: tenantId,
      max_context_tokens: 4000,
      layer_budgets: { passage: 1.0 },
      layer_order: ['passage'],
    });
    const types = r.included.map((x) => x.artifact_type);
    expect(new Set(types)).toEqual(new Set(['passage']));
  });

  it('default behavior (Phase 4 single-layer) remains intact', async () => {
    const e = env as unknown as Env;
    const { tenantId, ids } = await seed();
    const fused = ids.passages.map((id) => ({ chunk_id: id, score: 1 }));
    const r = await assembleContext(e, {
      fused,
      tenant_id: tenantId,
      max_context_tokens: 8000,
      // No layer_budgets / layer_order → default `passage: 1.0`.
    });
    expect(r.included.every((x) => x.artifact_type === 'passage')).toBe(true);
    expect(r.included.length).toBeGreaterThan(0);
    expect(r.oversize_admits).toBe(0);
    expect(r.oversize_skips).toBe(0);
  });
});
