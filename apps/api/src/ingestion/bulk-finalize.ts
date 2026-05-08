// Per-file finalize logic for a bulk job. Mirrors the single-file
// finalize path in routes/documents.ts (HEAD → hash → dedupe → copy
// → register → enqueue) but runs server-side, in a loop, without a
// REST round-trip per file.
//
// The dedupe seam is the key behavioral difference from single-file:
// single-file dedupes on (document_id, content_hash), where the caller
// has already chosen a document_id. Bulk dedupes on (namespace, title,
// content_hash) — title is the filename — because callers don't pre-
// register documents. See `on_existing` semantics below.
//
// Reuse-on-retry invariant (see BULK_QUALITY_PASS_FIXES.md §3):
// when an existing document_versions row matches (doc_id, content_hash)
// — whether from a previous successful ingest or an orphan from a
// failed attempt — we re-use that version_id. Re-inserting would
// collide with UNIQUE(document_id, content_hash). For non-skip
// policies we then pass force_rebuild=true so dispatchIngestion
// rebuilds the version_index instead of refusing with
// INDEX_ALREADY_BUILT.

import { TextralError, newId, type BulkConfig, type BulkOnExisting } from '@textral/contracts';
import type { Env } from '../types.js';
import {
  findDocumentByTitleInNamespace,
  getVersionByContentHash,
  insertDocument,
  insertDocumentVersion,
} from '../db/documents.js';
import { canonicalSourceKey, extFromContentType } from '../lib/r2-presign.js';
import { dispatchIngestion } from './dispatch.js';
import { updateBulkJobFileState, type BulkJobRow, type BulkJobFileRow } from '../db/bulk-ingest.js';
import { bulkUploadKey } from './bulk-keys.js';

export interface FinalizeOutcome {
  state: 'succeeded' | 'skipped' | 'enqueued' | 'failed';
  document_id?: string;
  version_id?: string;
  ingestion_job_id?: string;
  error_code?: string;
  error_detail?: string;
}

/** Finalize a single file. Idempotent — re-running on a row already
 *  past `pending` is a no-op. Errors are caught and surfaced as
 *  `failed` outcomes, never thrown — the caller iterates all files
 *  even when one fails. */
export async function finalizeBulkJobFile(
  env: Env,
  bulkJob: BulkJobRow,
  fileRow: BulkJobFileRow,
): Promise<FinalizeOutcome> {
  if (fileRow.state !== 'uploaded') {
    // Already processed (or never uploaded). Nothing to do.
    return { state: fileRow.state as FinalizeOutcome['state'] };
  }

  try {
    return await doFinalize(env, bulkJob, fileRow);
  } catch (err) {
    const code = err instanceof TextralError ? err.code : 'BULK_FILE_FINALIZE_FAILED';
    const detail = err instanceof Error ? err.message : String(err);
    await updateBulkJobFileState(env.db, {
      bulk_job_id: bulkJob.bulk_job_id,
      ordinal: fileRow.ordinal,
      state: 'failed',
      error_code: code,
      error_detail: detail,
    });
    return { state: 'failed', error_code: code, error_detail: detail };
  }
}

async function doFinalize(
  env: Env,
  bulkJob: BulkJobRow,
  fileRow: BulkJobFileRow,
): Promise<FinalizeOutcome> {
  const tenantId = bulkJob.tenant_id;
  const namespaceId = bulkJob.namespace_id;
  const tmpKey = bulkUploadKey(bulkJob.bulk_job_id, fileRow.ordinal);

  // 1. Verify R2 upload exists and matches declared size.
  const uploadObj = await env.blobs.head(tmpKey);
  if (!uploadObj) {
    throw new TextralError(
      'BULK_FILE_UPLOAD_EXPIRED',
      410,
      `Uploaded bytes for ordinal ${fileRow.ordinal} not found in R2`,
    );
  }
  if (uploadObj.size !== fileRow.size_bytes) {
    throw new TextralError(
      'BULK_FILE_HASH_MISMATCH',
      400,
      `Declared size ${fileRow.size_bytes} differs from R2 actual ${uploadObj.size}`,
      { declared: fileRow.size_bytes, actual: uploadObj.size },
    );
  }

  // 2. Stream + sha256.
  const uploadBody = await env.blobs.get(tmpKey);
  if (!uploadBody) {
    throw new TextralError('BULK_FILE_UPLOAD_EXPIRED', 410, 'Upload object disappeared');
  }
  const contentHash = await env.hash.sha256OfStream(uploadBody.body);

  const config: BulkConfig = JSON.parse(bulkJob.config_json) as BulkConfig;
  const ext = extFromContentType(fileRow.content_type);

  // 3. Resolve document by title; resolve version by content_hash.
  //    From this we determine: do we insert a new document? insert a
  //    new version? or reuse one (or both)?
  const existingDocument = await findDocumentByTitleInNamespace(
    env.db,
    tenantId,
    namespaceId,
    fileRow.filename,
  );

  let documentId: string;
  let isNewDocument: boolean;
  let versionId: string;
  let canonicalKey: string;
  let reuseVersion: boolean;

  if (existingDocument) {
    documentId = existingDocument.id;
    isNewDocument = false;
    const existingVersion = await getVersionByContentHash(
      env.db,
      documentId,
      contentHash,
    );
    if (existingVersion) {
      const policy: BulkOnExisting = bulkJob.on_existing;
      if (policy === 'skip_if_unchanged') {
        // Same filename, same content → skip. No new version, no
        // ingest enqueue. Clean tmp and mark skipped.
        await safeDelete(env, tmpKey);
        await updateBulkJobFileState(env.db, {
          bulk_job_id: bulkJob.bulk_job_id,
          ordinal: fileRow.ordinal,
          state: 'skipped',
          document_id: documentId,
          version_id: existingVersion.id,
        });
        return {
          state: 'skipped',
          document_id: documentId,
          version_id: existingVersion.id,
        };
      }
      // new_version | replace_current: re-use the existing version
      // row (the schema's UNIQUE(document_id, content_hash) means
      // "same bytes = same version" — there's no way to insert a
      // second row with identical content_hash). Re-running is
      // expressed as force_rebuild on dispatch, not as a duplicate
      // version row. The canonical R2 key stays the same; the
      // re-PUT below idempotently overwrites it (the bytes are
      // identical, so the result is identical).
      reuseVersion = true;
      versionId = existingVersion.id;
      canonicalKey = existingVersion.source_r2_key;
    } else {
      // Same title, different bytes → new version on the existing
      // document.
      reuseVersion = false;
      versionId = newId('ver');
      canonicalKey = canonicalSourceKey(
        tenantId,
        namespaceId,
        documentId,
        versionId,
        ext,
      );
    }
  } else {
    // New title → fresh document + version.
    documentId = newId('doc');
    isNewDocument = true;
    reuseVersion = false;
    versionId = newId('ver');
    canonicalKey = canonicalSourceKey(
      tenantId,
      namespaceId,
      documentId,
      versionId,
      ext,
    );
  }

  // 4. R2 copy tmp → canonical. Done BEFORE the DB writes so a
  //    failed copy leaves no half-state. Idempotent overwrite when
  //    reusing an existing version's source_r2_key.
  const re = await env.blobs.get(tmpKey);
  if (!re) {
    throw new TextralError(
      'BULK_FILE_UPLOAD_EXPIRED',
      410,
      'Upload object disappeared between HEAD and GET',
    );
  }
  await env.blobs.put(canonicalKey, re.body, { contentType: fileRow.content_type });

  // 5. DB writes — only after the canonical R2 object is durable.
  if (isNewDocument) {
    await insertDocument(env.db, tenantId, {
      id: documentId,
      namespace_id: namespaceId,
      title: fileRow.filename,
      doc_type: config.doc_type ?? null,
      metadata: null,
    });
  }
  if (!reuseVersion) {
    await insertDocumentVersion(env.db, tenantId, {
      id: versionId,
      document_id: documentId,
      content_hash: contentHash,
      source_r2_key: canonicalKey,
      content_type: fileRow.content_type,
      size_bytes: fileRow.size_bytes,
    });
  }

  await safeDelete(env, tmpKey);

  // 6. Enqueue ingestion job via the canonical dispatch path. The
  //    `force_rebuild` flag tells dispatchIngestion to re-run the
  //    pipeline against an existing version_index (when one exists)
  //    instead of refusing with INDEX_ALREADY_BUILT. We pass true
  //    whenever we're reusing an existing version row — that's the
  //    case where new_version / replace_current asks for a fresh
  //    ingestion event over unchanged bytes.
  const dispatchResult = await dispatchIngestion(env, tenantId, documentId, {
    version_id: versionId,
    doc_type: config.doc_type,
    embedding: config.embedding,
    chunking: config.chunking,
    enrichment: config.enrichment,
    indexing: config.indexing,
    mode: config.mode,
    force_rebuild: reuseVersion,
  });

  // 7. Tag the ingestion_jobs row with the bulk_job_id so the queue
  //    worker's terminal-state writes (and reconcile) can find it.
  await env.db.exec(
    `UPDATE ingestion_jobs SET bulk_job_id = ? WHERE id = ?`,
    [bulkJob.bulk_job_id, dispatchResult.job_id],
  );

  // 8. Update bulk_job_files row.
  await updateBulkJobFileState(env.db, {
    bulk_job_id: bulkJob.bulk_job_id,
    ordinal: fileRow.ordinal,
    state: 'enqueued',
    document_id: documentId,
    version_id: versionId,
    ingestion_job_id: dispatchResult.job_id,
  });

  return {
    state: 'enqueued',
    document_id: documentId,
    version_id: versionId,
    ingestion_job_id: dispatchResult.job_id,
  };
}

async function safeDelete(env: Env, key: string): Promise<void> {
  try {
    await env.blobs.delete(key);
  } catch {
    // R2 deletes are best-effort here; the cleanup cron sweeps
    // any orphans on TTL.
  }
}
