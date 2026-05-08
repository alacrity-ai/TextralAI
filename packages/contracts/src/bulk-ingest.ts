// Bulk ingest contracts. Mirrors `BULK_UPLOADS_DESIGN.md` §5.1.
//
// One bulk job applies one shared `BulkConfig` to N files. Per-file
// rows track upload + ingestion lineage. v1 enforces homogeneous
// config; per-file overrides are intentionally not in this surface
// (locked answer §11.1 of IMPLEMENTATION.md).

import { z } from 'zod';
import {
  EmbeddingConfig,
  ChunkingConfig,
  EnrichmentConfig,
  IndexingConfig,
} from './ingest.js';

export const BulkOnExisting = z.enum([
  'skip_if_unchanged',
  'new_version',
  'replace_current',
]);
export type BulkOnExisting = z.infer<typeof BulkOnExisting>;

export const BulkSource = z.enum(['api', 'mcp', 'sandbox']);
export type BulkSource = z.infer<typeof BulkSource>;

/** Shared configuration applied to every file in the bulk job. */
export const BulkConfig = z.object({
  embedding: EmbeddingConfig,
  chunking: ChunkingConfig.default({}),
  enrichment: EnrichmentConfig.default({}),
  indexing: IndexingConfig.default({}),
  mode: z.enum(['full', 'embed_only', 'enrichment_only']).default('full'),
  doc_type: z.string().optional(),
});
export type BulkConfig = z.infer<typeof BulkConfig>;

/** Per-file manifest entry. Filename + size + content type;
 *  optional caller-supplied dedupe key. */
export const BulkFileEntry = z.object({
  ordinal: z.number().int().nonnegative(),
  filename: z.string().min(1).max(512),
  size_bytes: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024, 'individual files capped at 25 MB'),
  content_type: z.string().min(1),
  client_request_id: z.string().optional(),
});
export type BulkFileEntry = z.infer<typeof BulkFileEntry>;

/** Submit a bulk ingest job. POST /v1/ingest/bulk. */
export const BulkSubmitRequest = z.object({
  namespace: z.string().min(1),
  config: BulkConfig,
  files: z
    .array(BulkFileEntry)
    .min(1, 'at least one file')
    .max(1000, 'bulk job is capped at 1000 files'),
  on_existing: BulkOnExisting.default('skip_if_unchanged'),
  /** When true (default), the server transitions to `processing`
   *  automatically once every file is uploaded. When false, the
   *  caller must POST /finalize explicitly. The Sandbox uses false
   *  so the user can review before paid work begins; SDK and MCP
   *  use true. */
  auto_finalize: z.boolean().default(true),
  client_request_id: z.string().optional(),
});
export type BulkSubmitRequest = z.infer<typeof BulkSubmitRequest>;

/** A single presigned upload slot returned by submit. */
export const BulkUploadSlot = z.object({
  ordinal: z.number().int(),
  upload_url: z.string().url(),
  upload_id: z.string(),
  expires_at: z.number().int(),
  method: z.literal('PUT'),
  headers: z.record(z.string()),
});
export type BulkUploadSlot = z.infer<typeof BulkUploadSlot>;

export const BulkSubmitResponse = z.object({
  bulk_job_id: z.string(),
  state: z.string(),
  total_files: z.number().int(),
  uploads: z.array(BulkUploadSlot),
  expires_at: z.number().int(),
});
export type BulkSubmitResponse = z.infer<typeof BulkSubmitResponse>;

export const BulkJobCounts = z.object({
  pending: z.number().int(),
  uploaded: z.number().int(),
  finalized: z.number().int(),
  enqueued: z.number().int(),
  processing: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});
export type BulkJobCounts = z.infer<typeof BulkJobCounts>;

export const BulkJobFirstFailure = z.object({
  ordinal: z.number().int(),
  filename: z.string(),
  error_code: z.string(),
  error_detail: z.string().optional(),
});
export type BulkJobFirstFailure = z.infer<typeof BulkJobFirstFailure>;

/** GET /v1/ingest/bulk/{id}. Aggregate state. */
export const BulkJobStatus = z.object({
  bulk_job_id: z.string(),
  state: z.string(),
  namespace: z.string(),
  total_files: z.number().int(),
  counts: BulkJobCounts,
  progress_pct: z.number().int().min(0).max(100),
  first_failure: BulkJobFirstFailure.nullable(),
  source: BulkSource,
  created_at: z.number().int(),
  finalized_at: z.number().int().nullable(),
  completed_at: z.number().int().nullable(),
  /** Ready-to-paste audit query filter, e.g. "bulk_job_id:bjk_…". */
  audit_query_event_filter: z.string(),
});
export type BulkJobStatus = z.infer<typeof BulkJobStatus>;

/** GET /v1/ingest/bulk/{id}/files. One row per file. */
export const BulkJobFile = z.object({
  ordinal: z.number().int(),
  filename: z.string(),
  size_bytes: z.number().int(),
  content_type: z.string(),
  state: z.string(),
  document_id: z.string().nullable(),
  version_id: z.string().nullable(),
  ingestion_job_id: z.string().nullable(),
  error_code: z.string().nullable(),
  error_detail: z.string().nullable(),
});
export type BulkJobFile = z.infer<typeof BulkJobFile>;

export const BulkJobFileListResponse = z.object({
  data: z.array(BulkJobFile),
  next_cursor: z.string().nullable(),
});
export type BulkJobFileListResponse = z.infer<typeof BulkJobFileListResponse>;

export const BulkJobListResponse = z.object({
  data: z.array(BulkJobStatus),
  next_cursor: z.string().nullable(),
});
export type BulkJobListResponse = z.infer<typeof BulkJobListResponse>;

export const BulkJobOk = z.object({ ok: z.literal(true) });
export type BulkJobOk = z.infer<typeof BulkJobOk>;
