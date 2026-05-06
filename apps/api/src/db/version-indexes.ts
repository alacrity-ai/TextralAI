// D1 helpers for version_indexes.

import type { Db } from '../runtime/shared/interfaces.js';

export interface VersionIndexRow {
  id: string;
  version_id: string;
  tenant_id: string;
  chunking_profile: string;
  chunking_target_tokens: number;
  chunking_overlap_tokens: number;
  embedding_profile: string;
  embedding_provider: string;
  embedding_model: string;
  embedding_dimensions: number;
  distance_metric: string;
  corpus_profile: string;
  enrichment_config: string;
  enrichment_status: string;
  status: string;
  vector_backend: 'vectorize' | 'qdrant' | 'pinecone';
  vector_index_name: string | null;
  vector_namespace: string | null;
  created_at: number;
}

export async function getVersionIndexById(
  db: Db,
  id: string,
): Promise<VersionIndexRow | null> {
  return await db.one<VersionIndexRow>(
    `SELECT * FROM version_indexes WHERE id = ?`,
    [id],
  );
}

export interface InsertVersionIndexArgs {
  id: string;
  version_id: string;
  tenant_id: string;
  chunking_profile: string;
  chunking_target_tokens: number;
  chunking_overlap_tokens: number;
  embedding_profile: string;
  embedding_provider: string;
  embedding_model: string;
  embedding_dimensions: number;
  distance_metric: string;
  corpus_profile: string;
  enrichment_config: string;
  /** Denormalised from the namespace row at insert time. */
  vector_backend: 'vectorize' | 'qdrant' | 'pinecone';
  vector_index_name: string | null;
  vector_namespace: string | null;
}

export async function insertVersionIndex(
  db: Db,
  args: InsertVersionIndexArgs,
): Promise<void> {
  await db.exec(
    `INSERT INTO version_indexes
         (id, version_id, tenant_id, chunking_profile, chunking_target_tokens,
          chunking_overlap_tokens, embedding_profile, embedding_provider,
          embedding_model, embedding_dimensions, distance_metric, corpus_profile,
          enrichment_config, enrichment_status, status,
          vector_backend, vector_index_name, vector_namespace, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?)`,
    [
      args.id,
      args.version_id,
      args.tenant_id,
      args.chunking_profile,
      args.chunking_target_tokens,
      args.chunking_overlap_tokens,
      args.embedding_profile,
      args.embedding_provider,
      args.embedding_model,
      args.embedding_dimensions,
      args.distance_metric,
      args.corpus_profile,
      args.enrichment_config,
      args.vector_backend,
      args.vector_index_name,
      args.vector_namespace,
      Date.now(),
    ],
  );
}

export interface SelectIndexesForEnrichmentRunArgs {
  tenant_id: string;
  namespace_slug: string;
  profile_id?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface SelectedIndex {
  id: string;
  version_id: string;
  tenant_id: string;
  document_id: string;
  corpus_profile: string;
}

export async function selectIndexesForEnrichmentRun(
  db: Db,
  args: SelectIndexesForEnrichmentRunArgs,
): Promise<SelectedIndex[]> {
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 1000);
  const wheres = [
    'vi.tenant_id = ?',
    'n.tenant_id = ?',
    'n.slug = ?',
    "vi.status IN ('ready', 'partial')",
  ];
  const binds: (string | number)[] = [args.tenant_id, args.tenant_id, args.namespace_slug];
  if (args.profile_id !== undefined) {
    wheres.push('vi.corpus_profile = ?');
    binds.push(args.profile_id);
  }
  if (args.since !== undefined) {
    wheres.push('vi.created_at >= ?');
    binds.push(args.since);
  }
  if (args.until !== undefined) {
    wheres.push('vi.created_at <= ?');
    binds.push(args.until);
  }
  binds.push(limit);
  const sql = `SELECT vi.id           AS id,
              vi.version_id   AS version_id,
              vi.tenant_id    AS tenant_id,
              d.id            AS document_id,
              vi.corpus_profile AS corpus_profile
         FROM version_indexes vi
         JOIN document_versions dv ON dv.id = vi.version_id
         JOIN documents d ON d.id = dv.document_id
         JOIN namespaces n ON n.id = d.namespace_id
        WHERE ${wheres.join(' AND ')}
        ORDER BY vi.created_at DESC
        LIMIT ?`;
  return await db.all<SelectedIndex>(sql, binds);
}

export async function updateVersionIndexStatuses(
  db: Db,
  args: {
    id: string;
    tenant_id: string;
    status: 'pending' | 'ready' | 'partial' | 'failed';
    enrichment_status: 'none' | 'full' | 'partial' | 'failed';
  },
): Promise<void> {
  await db.exec(
    `UPDATE version_indexes
          SET status = ?, enrichment_status = ?
        WHERE id = ? AND tenant_id = ?`,
    [args.status, args.enrichment_status, args.id, args.tenant_id],
  );
}
