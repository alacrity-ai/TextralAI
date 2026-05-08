// D1 query helpers for documents, document_versions, version_indexes,
// upload_intents. Every helper takes `tenant_id` as a non-optional first
// argument so it's structurally impossible to forget the tenant filter.

import type { Document } from '@textral/contracts';
import type { Db } from '../runtime/shared/interfaces.js';

export interface DocumentRow {
  id: string;
  tenant_id: string;
  namespace_id: string;
  title: string | null;
  doc_type: string | null;
  metadata: string | null;
  current_version_id: string | null;
  created_at: number;
  deleted_at: number | null;
}

export function rowToDocument(r: DocumentRow): Document {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    namespace_id: r.namespace_id,
    title: r.title,
    doc_type: r.doc_type,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    current_version_id: r.current_version_id,
    created_at: r.created_at,
  };
}

export async function getDocumentById(
  db: Db,
  tenantId: string,
  id: string,
): Promise<DocumentRow | null> {
  return await db.one<DocumentRow>(
    `SELECT * FROM documents WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    [id, tenantId],
  );
}

export interface ListDocumentsOpts {
  /** 1..200, default 50. */
  limit?: number;
  /** Opaque cursor: previous page's last item's `created_at`. */
  cursor?: string;
}

/** List documents in a namespace, newest-first. Excludes soft-deleted
 *  rows. Mirrors `listQueryEvents` cursor semantics. */
export async function listDocumentsForNamespace(
  db: Db,
  tenantId: string,
  namespaceId: string,
  opts: ListDocumentsOpts = {},
): Promise<{ items: DocumentRow[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const cursorTs = opts.cursor ? Number(opts.cursor) : null;
  const rows =
    cursorTs !== null
      ? await db.all<DocumentRow>(
          `SELECT * FROM documents
              WHERE tenant_id = ? AND namespace_id = ? AND deleted_at IS NULL
                AND created_at < ?
              ORDER BY created_at DESC, id DESC
              LIMIT ?`,
          [tenantId, namespaceId, cursorTs, limit + 1],
        )
      : await db.all<DocumentRow>(
          `SELECT * FROM documents
              WHERE tenant_id = ? AND namespace_id = ? AND deleted_at IS NULL
              ORDER BY created_at DESC, id DESC
              LIMIT ?`,
          [tenantId, namespaceId, limit + 1],
        );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const next_cursor = hasMore ? String(items[items.length - 1]!.created_at) : null;
  return { items, next_cursor };
}

export interface DocumentVersionRow {
  id: string;
  document_id: string;
  tenant_id: string;
  content_hash: string;
  source_r2_key: string;
  normalized_r2_key: string | null;
  content_type: string;
  size_bytes: number;
  created_at: number;
}

export async function getVersionByContentHash(
  db: Db,
  documentId: string,
  contentHash: string,
): Promise<DocumentVersionRow | null> {
  return await db.one<DocumentVersionRow>(
    `SELECT * FROM document_versions WHERE document_id = ? AND content_hash = ?`,
    [documentId, contentHash],
  );
}

export async function getVersionById(
  db: Db,
  tenantId: string,
  versionId: string,
): Promise<DocumentVersionRow | null> {
  return await db.one<DocumentVersionRow>(
    `SELECT * FROM document_versions WHERE id = ? AND tenant_id = ?`,
    [versionId, tenantId],
  );
}

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
  chunk_count: number | null;
  embedding_missing_count: number;
  created_at: number;
}

export async function findVersionIndex(
  db: Db,
  versionId: string,
  chunkingProfile: string,
  embeddingProfile: string,
): Promise<VersionIndexRow | null> {
  return await db.one<VersionIndexRow>(
    `SELECT * FROM version_indexes
        WHERE version_id = ? AND chunking_profile = ? AND embedding_profile = ?`,
    [versionId, chunkingProfile, embeddingProfile],
  );
}

export async function listVersionIndexesForVersion(
  db: Db,
  versionId: string,
): Promise<VersionIndexRow[]> {
  return await db.all<VersionIndexRow>(
    `SELECT * FROM version_indexes WHERE version_id = ? ORDER BY created_at`,
    [versionId],
  );
}

export interface UploadIntentRow {
  id: string;
  document_id: string;
  tenant_id: string;
  upload_r2_key: string;
  declared_size: number;
  declared_content_type: string;
  expires_at: number;
  created_at: number;
  consumed_at: number | null;
}

export async function getUploadIntent(
  db: Db,
  tenantId: string,
  uploadId: string,
): Promise<UploadIntentRow | null> {
  return await db.one<UploadIntentRow>(
    `SELECT * FROM upload_intents WHERE id = ? AND tenant_id = ?`,
    [uploadId, tenantId],
  );
}

/** Find an existing document in a namespace by title (filename). Used
 *  by the bulk-ingest finalize loop to dedupe-by-title when a caller
 *  re-runs a bulk against the same corpus — same filename + same
 *  content_hash → skip; same filename + different bytes → new version
 *  on the existing document (per `on_existing` policy). */
export async function findDocumentByTitleInNamespace(
  db: Db,
  tenantId: string,
  namespaceId: string,
  title: string,
): Promise<DocumentRow | null> {
  return await db.one<DocumentRow>(
    `SELECT * FROM documents
        WHERE tenant_id = ? AND namespace_id = ? AND title = ?
          AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    [tenantId, namespaceId, title],
  );
}

export async function insertDocument(
  db: Db,
  tenant_id: string,
  args: {
    id: string;
    namespace_id: string;
    title: string | null;
    doc_type: string | null;
    metadata: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO documents
         (id, tenant_id, namespace_id, title, doc_type, metadata,
          current_version_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      args.id,
      tenant_id,
      args.namespace_id,
      args.title,
      args.doc_type,
      args.metadata ? JSON.stringify(args.metadata) : null,
      Date.now(),
    ],
  );
}

export async function insertDocumentVersion(
  db: Db,
  tenant_id: string,
  args: {
    id: string;
    document_id: string;
    content_hash: string;
    source_r2_key: string;
    content_type: string;
    size_bytes: number;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO document_versions
         (id, document_id, tenant_id, content_hash, source_r2_key,
          content_type, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.document_id,
      tenant_id,
      args.content_hash,
      args.source_r2_key,
      args.content_type,
      args.size_bytes,
      Date.now(),
    ],
  );
}

/** Resolve the set of version_ids that a query should target.
 *  - If `documentIds` is supplied, restrict to those documents'
 *    `current_version_id` (skipping any without one).
 *  - Otherwise: take the namespace's latest 100 documents that have
 *    a current_version_id set. */
export async function resolveCurrentVersionIds(
  db: Db,
  tenantId: string,
  namespaceId: string,
  documentIds?: string[],
): Promise<string[]> {
  if (documentIds && documentIds.length > 0) {
    const ph = documentIds.map(() => '?').join(',');
    const rows = await db.all<{ v: string }>(
      `SELECT current_version_id AS v FROM documents
          WHERE tenant_id = ? AND namespace_id = ? AND deleted_at IS NULL
            AND id IN (${ph}) AND current_version_id IS NOT NULL`,
      [tenantId, namespaceId, ...documentIds],
    );
    return rows.map((r) => r.v);
  }
  const rows = await db.all<{ v: string }>(
    `SELECT current_version_id AS v FROM documents
        WHERE tenant_id = ? AND namespace_id = ? AND deleted_at IS NULL
          AND current_version_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 100`,
    [tenantId, namespaceId],
  );
  return rows.map((r) => r.v);
}

export async function promoteCurrentVersionId(
  db: Db,
  tenantId: string,
  documentId: string,
  versionId: string,
): Promise<void> {
  await db.exec(
    `UPDATE documents SET current_version_id = ? WHERE id = ? AND tenant_id = ?`,
    [versionId, documentId, tenantId],
  );
}
