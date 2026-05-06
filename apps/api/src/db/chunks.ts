// D1 helpers for chunks (passages + enrichment artifacts).

import type { Db, DbStatement } from '../runtime/shared/interfaces.js';

export interface ChunkInsert {
  id: string;
  tenant_id: string;
  namespace_id: string;
  document_id: string;
  version_id: string;
  version_index_id: string;
  artifact_type: string;
  section_path: string | null;
  ord: number;
  text: string;
  metadata: Record<string, unknown> | null;
  embedding_profile: string;
  chunking_profile: string;
  embedding_status: 'pending' | 'embedded' | 'missing';
  embedding_input_hash: string | null;
  embedding_provider_request_id: string | null;
  embedding_dimensions: number | null;
  parent_chunk_id?: string | null;
  enrichment_pass_id?: string | null;
}

export interface ChunkRow {
  id: string;
  tenant_id: string;
  namespace_id: string;
  document_id: string;
  version_id: string;
  version_index_id: string;
  artifact_type: string;
  section_path: string | null;
  ord: number;
  text: string;
  metadata: string | null;
  embedding_profile: string;
  chunking_profile: string;
  embedding_status: string;
  embedding_input_hash: string | null;
  embedding_provider_request_id: string | null;
  embedding_dimensions: number | null;
  parent_chunk_id: string | null;
  enrichment_pass_id: string | null;
  vector_id: string | null;
  created_at: number;
}

export interface HydratedChunkRow {
  id: string;
  text: string;
  artifact_type: string;
  section_path: string | null;
  metadata: string | null;
}

/** Bulk upsert via the `Db.batch` primitive (D1: atomic batch;
 *  Node: single transaction).
 *
 *  Uses portable `INSERT ... ON CONFLICT (id) DO UPDATE SET ... =
 *  excluded.*` syntax — supported by SQLite ≥3.24 and Postgres ≥9.5.
 *  Replaces the earlier SQLite-only `INSERT OR REPLACE` so the same
 *  SQL runs cleanly on both runtimes. */
export async function insertChunksBatch(
  db: Db,
  rows: ChunkInsert[],
): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };
  const stmts: DbStatement[] = rows.map((ch) => ({
    sql: `INSERT INTO chunks
            (id, tenant_id, namespace_id, document_id, version_id, version_index_id,
             artifact_type, section_path, ord, text, metadata,
             embedding_profile, chunking_profile, embedding_status,
             embedding_input_hash, embedding_provider_request_id, embedding_dimensions,
             parent_chunk_id, enrichment_pass_id,
             vector_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            tenant_id = excluded.tenant_id,
            namespace_id = excluded.namespace_id,
            document_id = excluded.document_id,
            version_id = excluded.version_id,
            version_index_id = excluded.version_index_id,
            artifact_type = excluded.artifact_type,
            section_path = excluded.section_path,
            ord = excluded.ord,
            text = excluded.text,
            metadata = excluded.metadata,
            embedding_profile = excluded.embedding_profile,
            chunking_profile = excluded.chunking_profile,
            embedding_status = excluded.embedding_status,
            embedding_input_hash = excluded.embedding_input_hash,
            embedding_provider_request_id = excluded.embedding_provider_request_id,
            embedding_dimensions = excluded.embedding_dimensions,
            parent_chunk_id = excluded.parent_chunk_id,
            enrichment_pass_id = excluded.enrichment_pass_id,
            vector_id = excluded.vector_id,
            created_at = excluded.created_at`,
    params: [
      ch.id,
      ch.tenant_id,
      ch.namespace_id,
      ch.document_id,
      ch.version_id,
      ch.version_index_id,
      ch.artifact_type,
      ch.section_path,
      ch.ord,
      ch.text,
      ch.metadata ? JSON.stringify(ch.metadata) : null,
      ch.embedding_profile,
      ch.chunking_profile,
      ch.embedding_status,
      ch.embedding_input_hash ?? null,
      ch.embedding_provider_request_id ?? null,
      ch.embedding_dimensions ?? null,
      ch.parent_chunk_id ?? null,
      ch.enrichment_pass_id ?? null,
      ch.id, // vector_id == chunk_id
      Date.now(),
    ],
  }));
  await db.batch(stmts);
  return { inserted: rows.length };
}

/** Single chunk read, tenant-scoped. Used by the public
 *  `GET /v1/chunks/{id}` route powering the sandbox SourcePanel. */
export async function getChunkById(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<ChunkRow | null> {
  return await db.one<ChunkRow>(
    `SELECT * FROM chunks WHERE id = ? AND tenant_id = ?`,
    [id, tenant_id],
  );
}

export interface ListChunksForDocumentOpts {
  /** 1..500, default 100. Higher cap than the docs/query lists because
   *  inspecting a document's chunk waterfall is the common case. */
  limit?: number;
  /** Opaque cursor: previous page's last item's `ord`. Within a
   *  document, `(version_id, ord)` is the natural order. */
  cursor?: string;
  /** Optional artifact filter (e.g. only `passage`s, skipping
   *  enrichment-derived chunks). */
  artifact_type?: string;
  /** Optional version restriction. Defaults to the document's
   *  current_version_id when undefined; pass `null` explicitly to
   *  fetch across versions (rare, mostly for archaeology). */
  version_id?: string | null;
}

/** List chunks for a document, ascending by `ord`. The route layer
 *  resolves the document's `current_version_id` and passes it through
 *  unless `version_id=…` is supplied. Tenant-scoped. */
export async function listChunksForDocument(
  db: Db,
  tenant_id: string,
  document_id: string,
  opts: ListChunksForDocumentOpts = {},
): Promise<{ items: ChunkRow[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const cursorOrd = opts.cursor ? Number(opts.cursor) : null;

  const where: string[] = ['tenant_id = ?', 'document_id = ?'];
  const params: unknown[] = [tenant_id, document_id];
  if (opts.version_id !== null && opts.version_id !== undefined) {
    where.push('version_id = ?');
    params.push(opts.version_id);
  }
  if (opts.artifact_type) {
    where.push('artifact_type = ?');
    params.push(opts.artifact_type);
  }
  if (cursorOrd !== null) {
    where.push('ord > ?');
    params.push(cursorOrd);
  }
  params.push(limit + 1);

  const sql = `SELECT * FROM chunks
                  WHERE ${where.join(' AND ')}
                  ORDER BY ord ASC, id ASC
                  LIMIT ?`;
  const rows = await db.all<ChunkRow>(sql, params);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const next_cursor = hasMore ? String(items[items.length - 1]!.ord) : null;
  return { items, next_cursor };
}

export async function hydrateChunksByIds(
  db: Db,
  tenant_id: string,
  ids: string[],
): Promise<HydratedChunkRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return await db.all<HydratedChunkRow>(
    `SELECT id, text, artifact_type, section_path, metadata
         FROM chunks
        WHERE tenant_id = ? AND id IN (${placeholders})`,
    [tenant_id, ...ids],
  );
}

// Phase 2 J-1: sparse (FTS) chunk search lives in the runtime
// adapter, not here. CF impl: `runtime/cf/fts5-sparse-search.ts`
// (SQLite FTS5 + bm25). Node impl: TBD in Step 17 (Postgres
// tsvector / ts_rank). Routes that need it call
// `c.env.sparseSearch.search(args)`.

export async function countMissingEmbeddings(
  db: Db,
  tenant_id: string,
  version_ids: string[],
): Promise<number> {
  if (version_ids.length === 0) return 0;
  const placeholders = version_ids.map(() => '?').join(',');
  const row = await db.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM chunks
        WHERE tenant_id = ? AND version_id IN (${placeholders})
          AND embedding_status = 'missing'`,
    [tenant_id, ...version_ids],
  );
  return row?.n ?? 0;
}

export async function countMissingEmbeddingsForVersionIndex(
  db: Db,
  version_index_id: string,
): Promise<number> {
  const row = await db.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM chunks
        WHERE version_index_id = ? AND embedding_status = 'missing'`,
    [version_index_id],
  );
  return row?.n ?? 0;
}

export async function listChunkIdsForVersionIndex(
  db: Db,
  version_index_id: string,
): Promise<string[]> {
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM chunks WHERE version_index_id = ?`,
    [version_index_id],
  );
  return rows.map((r) => r.id);
}

/** Bulk DELETE via the `Db.batch` primitive. */
export async function deleteChunksByIds(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const stmts: DbStatement[] = ids.map((id) => ({
    sql: `DELETE FROM chunks WHERE id = ?`,
    params: [id],
  }));
  await db.batch(stmts);
}

/** Used by /internal/vectorize/delete-by-filter to find chunks
 *  matching a (document, version, profile) filter so the caller can
 *  drop them from Vectorize and D1. */
export async function listEmbeddedChunkIdsForFilter(
  db: Db,
  args: {
    document_id: string;
    version_id: string;
    embedding_profile: string;
    chunking_profile: string;
  },
): Promise<string[]> {
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM chunks
        WHERE document_id = ? AND version_id = ?
          AND embedding_profile = ? AND chunking_profile = ?
          AND embedding_status = 'embedded'`,
    [
      args.document_id,
      args.version_id,
      args.embedding_profile,
      args.chunking_profile,
    ],
  );
  return rows.map((r) => r.id);
}
