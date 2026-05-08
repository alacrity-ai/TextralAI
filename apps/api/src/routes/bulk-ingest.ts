// /v1/ingest/bulk — multi-file ingestion through one manifest.
//
// See `docs/development/bulk_ingest/BULK_UPLOADS_DESIGN.md` and
// `BULK_UPLOADS_IMPLEMENTATION.md` for the full design + plan.
//
// The bulk pipeline is a thin orchestration layer over the existing
// single-file primitives. Per-file finalize delegates to
// `ingestion/bulk-finalize.ts` which calls `dispatchIngestion` for
// the actual ingestion-job enqueue. The queue worker is unchanged;
// `ingestion_jobs.bulk_job_id` (FK from migration 0014) lets the
// rollup helper reconcile terminal state lazily on read.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import {
  TextralError,
  newId,
  BulkSubmitRequest,
  type BulkConfig,
  type BulkJobStatus as BulkJobStatusType,
  type BulkUploadSlot,
  type BulkJobFile,
  type BulkJobCounts,
} from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import {
  BulkSubmitRequestSchema,
  BulkSubmitResponseSchema,
  BulkJobStatusSchema,
  BulkJobFileListResponseSchema,
  BulkJobListResponseSchema,
  BulkJobOkSchema,
  BulkJobIdParam,
  BulkUploadParam,
} from '../openapi/components.js';
import { Responses } from '../openapi/registry.js';
import { getNamespaceBySlug } from '../db/namespaces.js';
import {
  countActiveBulkJobs,
  deleteBulkJob,
  getBulkJob,
  getBulkJobByClientRequestId,
  getBulkJobFile,
  getBulkJobFileByUploadId,
  getFirstFailureForBulkJob,
  insertBulkJob,
  insertBulkJobFile,
  listBulkJobFiles,
  listRecentBulkJobs,
  updateBulkJobFileState,
  updateBulkJobState,
  type BulkJobRow,
  type BulkJobState,
  type BulkFileState,
} from '../db/bulk-ingest.js';
import { rollupBulkJob } from '../ingestion/bulk-rollup.js';
import { finalizeBulkJobFile } from '../ingestion/bulk-finalize.js';
import { bulkUploadKey } from '../ingestion/bulk-keys.js';

// ── Limits (v1; tunable per tenant later) ───────────────────────────────
const LIMITS = {
  maxFilesPerJob: 1000,
  maxBytesPerFile: 25 * 1024 * 1024,
  maxBytesPerJob: 5 * 1024 * 1024 * 1024,
  maxConcurrentJobsPerTenant: 10,
  unfinalizedTtlMs: 7 * 24 * 60 * 60 * 1000,
  uploadTtlMs: 7 * 24 * 60 * 60 * 1000,
};

export const bulkIngestRoute = new OpenAPIHono<{
  Bindings: Env;
  Variables: Variables;
}>();

// ── POST /v1/ingest/bulk — submit manifest ─────────────────────────────

const submitBulk = createRoute({
  method: 'post',
  path: '/',
  tags: ['Bulk Ingest'],
  summary: 'Submit a bulk-ingest manifest',
  description:
    'Accepts up to 1000 files in one manifest with one shared embedding/chunking config. Returns a `bulk_job_id` and one upload URL per file. Dim-lock conflicts and quota errors fail-fast — no presigned URLs issued.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: BulkSubmitRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Bulk job accepted; upload URLs returned.',
      content: { 'application/json': { schema: BulkSubmitResponseSchema } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    404: Responses.notFound,
    409: Responses.conflict,
    413: { description: 'Bulk job exceeds size or count limits.', content: { 'application/json': { schema: BulkJobOkSchema } } },
    429: Responses.rateLimited,
  },
});

bulkIngestRoute.openapi(submitBulk, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const body = c.req.valid('json');

  // 1. Job-level idempotency.
  if (body.client_request_id) {
    const existing = await getBulkJobByClientRequestId(c.env.db, tenantId, body.client_request_id);
    if (existing) {
      // 24-hour dedupe window.
      if (Date.now() - existing.created_at < 24 * 60 * 60 * 1000) {
        // Build the response from existing rows. Re-issue presigned
        // URLs only for entries still in `pending` state.
        const files = await listBulkJobFiles(c.env.db, existing.bulk_job_id);
        const uploads = files
          .filter((f) => f.state === 'pending')
          .map((f) => buildUploadSlot(c.req.url, existing.bulk_job_id, f));
        return c.json(
          {
            bulk_job_id: existing.bulk_job_id,
            state: existing.state,
            total_files: existing.total_files,
            uploads,
            expires_at: existing.expires_at,
          },
          201,
        );
      }
    }
  }

  // 2. Validate filename uniqueness within the job.
  const filenameSet = new Set<string>();
  for (const f of body.files) {
    if (filenameSet.has(f.filename)) {
      throw new TextralError(
        'BULK_DUPLICATE_FILENAMES_IN_JOB',
        400,
        `Filename '${f.filename}' appears more than once in the manifest.`,
      );
    }
    filenameSet.add(f.filename);
  }

  // 3. Validate aggregate size cap.
  const totalBytes = body.files.reduce(
    (s: number, f: { size_bytes: number }) => s + f.size_bytes,
    0,
  );
  if (totalBytes > LIMITS.maxBytesPerJob) {
    throw new TextralError(
      'BULK_BYTES_EXCEEDED',
      413,
      `Total job bytes ${totalBytes} exceeds limit ${LIMITS.maxBytesPerJob}.`,
      { total_bytes: totalBytes, limit: LIMITS.maxBytesPerJob },
    );
  }

  // 4. Validate per-job count cap (zod schema already caps at 1000,
  //    but surface a structured error code in case the schema changes).
  if (body.files.length > LIMITS.maxFilesPerJob) {
    throw new TextralError(
      'BULK_TOO_MANY_FILES',
      413,
      `Manifest has ${body.files.length} files; limit is ${LIMITS.maxFilesPerJob}.`,
    );
  }

  // 5. Quota: concurrent active jobs per tenant.
  const active = await countActiveBulkJobs(c.env.db, tenantId);
  if (active >= LIMITS.maxConcurrentJobsPerTenant) {
    throw new TextralError(
      'BULK_QUOTA_EXCEEDED',
      429,
      `Tenant has ${active} active bulk jobs (limit ${LIMITS.maxConcurrentJobsPerTenant}). Cancel or finish existing jobs before submitting a new one.`,
    );
  }

  // 6. Resolve namespace.
  const ns = await getNamespaceBySlug(c.env.db, tenantId, body.namespace);
  if (!ns) {
    throw new TextralError(
      'BULK_NAMESPACE_NOT_FOUND',
      404,
      `Namespace '${body.namespace}' not found.`,
    );
  }

  // 7. Dim-lock pre-check. Fail fast before any R2 write or presigned-
  //    URL generation. The actual lock is enforced again inside
  //    `dispatchIngestion` per file, but we want to surface mismatches
  //    at submit time so callers don't waste an upload roundtrip.
  const requestedDim = body.config.embedding.dimensions;
  if (requestedDim !== undefined && ns.embedding_dimensions !== undefined && requestedDim !== ns.embedding_dimensions) {
    throw new TextralError(
      'BULK_DIMENSION_LOCK_MISMATCH',
      409,
      `Namespace '${ns.slug}' is locked to ${ns.embedding_dimensions}-d. Manifest requests ${requestedDim}-d.`,
      {
        namespace_dimensions: ns.embedding_dimensions,
        requested_dimensions: requestedDim,
        namespace_slug: ns.slug,
      },
    );
  }

  // 8. INSERT bulk_jobs row.
  const bulkJobId = newId('bjk');
  const now = Date.now();
  const expiresAt = now + LIMITS.unfinalizedTtlMs;
  await insertBulkJob(c.env.db, {
    bulk_job_id: bulkJobId,
    tenant_id: tenantId,
    namespace_id: ns.id,
    config: body.config,
    on_existing: body.on_existing,
    client_request_id: body.client_request_id ?? null,
    total_files: body.files.length,
    source: c.req.header('x-textral-source') === 'mcp'
      ? 'mcp'
      : c.req.header('x-textral-source') === 'sandbox'
        ? 'sandbox'
        : 'api',
    auto_finalize: body.auto_finalize,
    expires_at: expiresAt,
  });

  // 9. INSERT one bulk_job_files row per entry, with upload_id +
  //    upload URL. Done sequentially today; D1 batch is a Phase 1 perf
  //    knob to revisit if 1000-file submits feel slow.
  const uploads: BulkUploadSlot[] = [];
  for (const f of body.files) {
    const uploadId = newId('bjku');
    const uploadExpires = now + LIMITS.uploadTtlMs;
    await insertBulkJobFile(c.env.db, {
      bulk_job_id: bulkJobId,
      ordinal: f.ordinal,
      filename: f.filename,
      size_bytes: f.size_bytes,
      content_type: f.content_type,
      upload_id: uploadId,
      upload_url_expires_at: uploadExpires,
      client_request_id: f.client_request_id ?? null,
    });
    uploads.push({
      ordinal: f.ordinal,
      upload_url: buildBulkUploadUrl(c.req.url, bulkJobId, f.ordinal),
      upload_id: uploadId,
      expires_at: uploadExpires,
      method: 'PUT',
      headers: { 'Content-Type': f.content_type },
    });
  }

  return c.json(
    {
      bulk_job_id: bulkJobId,
      state: 'accepted' as const,
      total_files: body.files.length,
      uploads,
      expires_at: expiresAt,
    },
    201,
  );
});

// ── PUT /v1/ingest/bulk/{id}/files/{ordinal}/data — upload bytes ───────

const proxyUpload = createRoute({
  method: 'put',
  path: '/{id}/files/{ordinal}/data',
  tags: ['Bulk Ingest'],
  summary: 'Upload bytes for a file in a bulk job',
  description:
    'Worker-proxied PUT for one file in a bulk job. Validates the bulk_job + file row, writes bytes to the tmp R2 prefix for the job, and transitions the per-file row to `uploaded`. Returns 204.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: BulkUploadParam,
    body: {
      content: {
        'application/octet-stream': { schema: z.unknown() },
        'text/plain': { schema: z.string() },
      },
    },
  },
  responses: {
    204: { description: 'Bytes stored.' },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    404: Responses.notFound,
    410: Responses.gone,
  },
});

bulkIngestRoute.openapi(proxyUpload, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id: bulkJobId, ordinal } = c.req.valid('param');
  const job = await getBulkJob(c.env.db, tenantId, bulkJobId);
  if (!job) throw new TextralError('BULK_JOB_NOT_FOUND', 404, 'Bulk job not found');
  if (job.state !== 'accepted' && job.state !== 'uploading') {
    throw new TextralError(
      'BULK_FILE_UPLOAD_INVALID_STATE',
      400,
      `Cannot upload while bulk job state is '${job.state}'`,
    );
  }
  const file = await getBulkJobFile(c.env.db, bulkJobId, Number(ordinal));
  if (!file) throw new TextralError('BULK_FILE_NOT_FOUND', 404, 'Bulk file not found');
  if (file.state !== 'pending') {
    throw new TextralError(
      'BULK_FILE_UPLOAD_INVALID_STATE',
      400,
      `Cannot upload over file in state '${file.state}'`,
    );
  }
  if ((file.upload_url_expires_at ?? 0) < Date.now()) {
    throw new TextralError(
      'BULK_FILE_UPLOAD_EXPIRED',
      410,
      'Upload URL expired. Re-submit the bulk job.',
    );
  }

  const bodyBuf = await c.req.raw.arrayBuffer();
  if (bodyBuf.byteLength !== file.size_bytes) {
    throw new TextralError(
      'BULK_FILE_HASH_MISMATCH',
      400,
      `Body size ${bodyBuf.byteLength} differs from declared ${file.size_bytes}`,
    );
  }
  await c.env.blobs.put(bulkUploadKey(bulkJobId, Number(ordinal)), bodyBuf, {
    contentType: file.content_type,
  });
  await updateBulkJobFileState(c.env.db, {
    bulk_job_id: bulkJobId,
    ordinal: Number(ordinal),
    state: 'uploaded',
  });
  // Lift bulk_jobs.state to 'uploading' on first byte landing.
  if (job.state === 'accepted') {
    await updateBulkJobState(c.env.db, bulkJobId, 'uploading');
  }
  return new Response(null, { status: 204 });
});

// ── POST /v1/ingest/bulk/{id}/finalize ─────────────────────────────────

const finalizeBulk = createRoute({
  method: 'post',
  path: '/{id}/finalize',
  tags: ['Bulk Ingest'],
  summary: 'Finalize all uploaded files in a bulk job',
  description:
    'Triggers per-file finalize (HEAD → hash → dedupe → register → enqueue). Only runs files in state `uploaded`; safe to call multiple times. Auto-fired by the server when `auto_finalize: true` and the last upload lands.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: BulkJobIdParam },
  responses: {
    200: {
      description: 'Finalize loop complete.',
      content: { 'application/json': { schema: BulkJobOkSchema } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

bulkIngestRoute.openapi(finalizeBulk, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id: bulkJobId } = c.req.valid('param');
  await runBulkFinalizeLoop(c.env, tenantId, bulkJobId);
  return c.json({ ok: true as const }, 200);
});

/** Internal helper used by the explicit finalize endpoint and (in the
 *  future) by an R2-event-driven trigger when auto_finalize=true. */
export async function runBulkFinalizeLoop(
  env: Env,
  tenantId: string,
  bulkJobId: string,
): Promise<void> {
  const job = await getBulkJob(env.db, tenantId, bulkJobId);
  if (!job) throw new TextralError('BULK_JOB_NOT_FOUND', 404, 'Bulk job not found');
  if (
    job.state !== 'accepted' &&
    job.state !== 'uploading' &&
    job.state !== 'finalizing'
  ) {
    // Already past finalize or terminal — no-op.
    return;
  }
  await updateBulkJobState(env.db, bulkJobId, 'finalizing', {
    finalized_at: Date.now(),
  });
  const refreshedJob = (await getBulkJob(env.db, tenantId, bulkJobId))!;

  const files = await listBulkJobFiles(env.db, bulkJobId, { state: 'uploaded' });
  for (const f of files) {
    await finalizeBulkJobFile(env, refreshedJob, f);
  }
  await rollupBulkJob(env, refreshedJob);
}

// ── GET /v1/ingest/bulk/{id} ───────────────────────────────────────────

const getBulkJobRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Bulk Ingest'],
  summary: 'Get bulk job status',
  description:
    'Returns aggregate state, per-state counts, progress percentage, first failure (if any), and an audit query filter. Reconciles per-file state with underlying ingestion_jobs lazily on read.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: BulkJobIdParam },
  responses: {
    200: {
      description: 'Aggregate bulk job status.',
      content: { 'application/json': { schema: BulkJobStatusSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

bulkIngestRoute.openapi(getBulkJobRoute, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id: bulkJobId } = c.req.valid('param');
  const job = await getBulkJob(c.env.db, tenantId, bulkJobId);
  if (!job) throw new TextralError('BULK_JOB_NOT_FOUND', 404, 'Bulk job not found');
  // Reconcile the denormalized counters first so the auto-finalize
  // check below sees fresh `files_uploaded`. Without this, the first
  // poll after the last PUT would see stale 0 and skip finalize,
  // pushing actual ingestion start to the second poll cycle.
  await rollupBulkJob(c.env, job);
  const afterRollup = (await getBulkJob(c.env.db, tenantId, bulkJobId))!;
  if (
    afterRollup.auto_finalize &&
    afterRollup.state === 'uploading' &&
    afterRollup.files_uploaded >= afterRollup.total_files
  ) {
    await runBulkFinalizeLoop(c.env, tenantId, bulkJobId);
  }
  const refreshed = (await getBulkJob(c.env.db, tenantId, bulkJobId))!;
  const result = await rollupBulkJob(c.env, refreshed);

  const status = await buildBulkJobStatus(c.env, refreshed, result.counts);
  return c.json(status, 200);
});

// ── GET /v1/ingest/bulk/{id}/files ─────────────────────────────────────

const listFilesRoute = createRoute({
  method: 'get',
  path: '/{id}/files',
  tags: ['Bulk Ingest'],
  summary: 'List per-file rows for a bulk job',
  description:
    'Paginated per-file rows with their full state + audit ids. Use this to render a table and drill into failed files.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: BulkJobIdParam,
    query: z.object({
      state: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1).optional(),
      page_size: z.coerce.number().int().min(1).max(1000).default(100).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Per-file rows.',
      content: { 'application/json': { schema: BulkJobFileListResponseSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

bulkIngestRoute.openapi(listFilesRoute, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id: bulkJobId } = c.req.valid('param');
  const q = c.req.valid('query');
  const job = await getBulkJob(c.env.db, tenantId, bulkJobId);
  if (!job) throw new TextralError('BULK_JOB_NOT_FOUND', 404, 'Bulk job not found');
  const limit = q.page_size ?? 100;
  const offset = ((q.page ?? 1) - 1) * limit;
  const listOpts: { state?: BulkFileState; limit: number; offset: number } = {
    limit: limit + 1,
    offset,
  };
  if (q.state) listOpts.state = q.state as BulkFileState;
  const rows = await listBulkJobFiles(c.env.db, bulkJobId, listOpts);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const data: BulkJobFile[] = items.map((r) => ({
    ordinal: r.ordinal,
    filename: r.filename,
    size_bytes: r.size_bytes,
    content_type: r.content_type,
    state: r.state,
    document_id: r.document_id,
    version_id: r.version_id,
    ingestion_job_id: r.ingestion_job_id,
    error_code: r.error_code,
    error_detail: r.error_detail,
  }));
  return c.json(
    { data, next_cursor: hasMore ? String((q.page ?? 1) + 1) : null },
    200,
  );
});

// ── DELETE /v1/ingest/bulk/{id} — cancel ───────────────────────────────

const cancelBulk = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Bulk Ingest'],
  summary: 'Cancel a bulk job',
  description:
    'Refuses if any file is `succeeded` (cancellation must be all-or-nothing for clean audit). Otherwise marks remaining files `failed` with `BULK_JOB_CANCELLED` and the bulk job `cancelled`.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: BulkJobIdParam },
  responses: {
    200: {
      description: 'Bulk job cancelled.',
      content: { 'application/json': { schema: BulkJobOkSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
    409: Responses.conflict,
  },
});

bulkIngestRoute.openapi(cancelBulk, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id: bulkJobId } = c.req.valid('param');
  const job = await getBulkJob(c.env.db, tenantId, bulkJobId);
  if (!job) throw new TextralError('BULK_JOB_NOT_FOUND', 404, 'Bulk job not found');
  if (job.files_succeeded > 0) {
    throw new TextralError(
      'BULK_JOB_HAS_SUCCEEDED_FILES',
      409,
      `Bulk job has ${job.files_succeeded} succeeded files; cancel refuses for audit cleanliness. Submit a new job to continue.`,
    );
  }
  // Mark every non-terminal file failed with the cancellation cause.
  const inFlight = await listBulkJobFiles(c.env.db, bulkJobId);
  for (const f of inFlight) {
    if (
      f.state === 'pending' ||
      f.state === 'uploaded' ||
      f.state === 'finalized' ||
      f.state === 'enqueued' ||
      f.state === 'processing'
    ) {
      await updateBulkJobFileState(c.env.db, {
        bulk_job_id: bulkJobId,
        ordinal: f.ordinal,
        state: 'failed',
        error_code: 'BULK_JOB_CANCELLED',
        error_detail: 'Cancelled by tenant.',
      });
    }
  }
  await updateBulkJobState(c.env.db, bulkJobId, 'cancelled', {
    completed_at: Date.now(),
  });
  // Best-effort tmp cleanup; non-fatal.
  await tryDeleteJobTmp(c.env, bulkJobId);
  return c.json({ ok: true as const }, 200);
});

// ── POST /v1/ingest/bulk/{id}/retry ────────────────────────────────────

const retryBulk = createRoute({
  method: 'post',
  path: '/{id}/retry',
  tags: ['Bulk Ingest'],
  summary: 'Retry only failed files in a bulk job',
  description:
    'For each `failed` row whose tmp R2 bytes are still present, re-runs finalize. Files whose upload itself failed are reset to `pending` with a fresh upload URL.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: BulkJobIdParam },
  responses: {
    200: {
      description: 'Retry initiated.',
      content: { 'application/json': { schema: BulkJobOkSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
    409: Responses.conflict,
  },
});

bulkIngestRoute.openapi(retryBulk, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id: bulkJobId } = c.req.valid('param');
  const job = await getBulkJob(c.env.db, tenantId, bulkJobId);
  if (!job) throw new TextralError('BULK_JOB_NOT_FOUND', 404, 'Bulk job not found');
  if (job.state === 'cancelled' || job.state === 'expired') {
    throw new TextralError(
      'BULK_JOB_TERMINAL',
      409,
      `Cannot retry a ${job.state} bulk job. Submit a new job.`,
    );
  }
  // Gather failed rows. If their bytes are still in tmp, re-run
  // finalize. Otherwise reset to 'pending' (caller will re-upload).
  const failed = await listBulkJobFiles(c.env.db, bulkJobId, { state: 'failed' });
  let reFinalized = 0;
  let resetToPending = 0;
  for (const f of failed) {
    const head = await c.env.blobs.head(bulkUploadKey(bulkJobId, f.ordinal));
    if (head) {
      // Reset state to 'uploaded' so finalize will pick it up.
      await updateBulkJobFileState(c.env.db, {
        bulk_job_id: bulkJobId,
        ordinal: f.ordinal,
        state: 'uploaded',
        error_code: null,
        error_detail: null,
      });
      reFinalized++;
    } else {
      // Bytes gone — caller has to re-upload.
      await updateBulkJobFileState(c.env.db, {
        bulk_job_id: bulkJobId,
        ordinal: f.ordinal,
        state: 'pending',
        error_code: null,
        error_detail: null,
      });
      resetToPending++;
    }
  }
  if (reFinalized > 0) {
    await runBulkFinalizeLoop(c.env, tenantId, bulkJobId);
  }
  void resetToPending;
  return c.json({ ok: true as const }, 200);
});

// ── GET /v1/ingest/bulk — list recent jobs ─────────────────────────────

const listJobsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Bulk Ingest'],
  summary: 'List recent bulk jobs',
  description:
    'Paginated by `created_at` (cursor). Optional filter by namespace slug or state.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    query: z.object({
      namespace: z.string().optional(),
      state: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Bulk job list.',
      content: { 'application/json': { schema: BulkJobListResponseSchema } },
    },
    401: Responses.unauthorized,
  },
});

bulkIngestRoute.openapi(listJobsRoute, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const q = c.req.valid('query');
  let namespaceId: string | undefined;
  if (q.namespace) {
    const ns = await getNamespaceBySlug(c.env.db, tenantId, q.namespace);
    namespaceId = ns?.id;
    if (!namespaceId) {
      // Empty list rather than 404 — list endpoints are forgiving.
      return c.json({ data: [], next_cursor: null }, 200);
    }
  }
  const listJobsOpts: {
    namespace_id?: string;
    state?: BulkJobState;
    limit?: number;
    cursor?: string;
  } = {};
  if (namespaceId) listJobsOpts.namespace_id = namespaceId;
  if (q.state) listJobsOpts.state = q.state as BulkJobState;
  if (q.limit !== undefined) listJobsOpts.limit = q.limit;
  if (q.cursor !== undefined) listJobsOpts.cursor = q.cursor;
  const { items, next_cursor } = await listRecentBulkJobs(c.env.db, tenantId, listJobsOpts);
  // Resolve namespace slug for each row (bounded by `limit`).
  const data: BulkJobStatusType[] = [];
  for (const r of items) {
    const status = await buildBulkJobStatus(c.env, r);
    data.push(status);
  }
  return c.json({ data, next_cursor }, 200);
});

// ── Shared helpers ──────────────────────────────────────────────────────

function buildBulkUploadUrl(requestUrl: string, bulkJobId: string, ordinal: number): string {
  const origin = new URL(requestUrl).origin;
  return `${origin}/v1/ingest/bulk/${bulkJobId}/files/${ordinal}/data`;
}

function buildUploadSlot(
  requestUrl: string,
  bulkJobId: string,
  f: { ordinal: number; upload_id: string | null; upload_url_expires_at: number | null; content_type: string },
): BulkUploadSlot {
  return {
    ordinal: f.ordinal,
    upload_url: buildBulkUploadUrl(requestUrl, bulkJobId, f.ordinal),
    upload_id: f.upload_id ?? '',
    expires_at: f.upload_url_expires_at ?? 0,
    method: 'PUT',
    headers: { 'Content-Type': f.content_type },
  };
}

async function buildBulkJobStatus(
  env: Env,
  job: BulkJobRow,
  precomputedCounts?: BulkJobCounts,
): Promise<BulkJobStatusType> {
  // Resolve namespace slug.
  const ns = await env.db.one<{ slug: string }>(
    `SELECT slug FROM namespaces WHERE id = ?`,
    [job.namespace_id],
  );
  const counts = precomputedCounts ?? {
    pending: job.total_files - (job.files_uploaded + job.files_succeeded + job.files_failed + job.files_skipped),
    uploaded: 0,
    finalized: 0,
    enqueued: 0,
    processing: 0,
    succeeded: job.files_succeeded,
    failed: job.files_failed,
    skipped: job.files_skipped,
  };
  const totalTerminal = counts.succeeded + counts.failed + counts.skipped;
  const progressPct = job.total_files === 0
    ? 100
    : Math.floor((totalTerminal / job.total_files) * 100);
  const firstFailureRow = await getFirstFailureForBulkJob(env.db, job.bulk_job_id);
  return {
    bulk_job_id: job.bulk_job_id,
    state: job.state,
    namespace: ns?.slug ?? '',
    total_files: job.total_files,
    counts,
    progress_pct: progressPct,
    first_failure: firstFailureRow
      ? {
          ordinal: firstFailureRow.ordinal,
          filename: firstFailureRow.filename,
          error_code: firstFailureRow.error_code ?? 'UNKNOWN',
          error_detail: firstFailureRow.error_detail ?? undefined,
        }
      : null,
    source: job.source,
    created_at: job.created_at,
    finalized_at: job.finalized_at,
    completed_at: job.completed_at,
    audit_query_event_filter: `bulk_job_id:${job.bulk_job_id}`,
  };
}

async function tryDeleteJobTmp(env: Env, bulkJobId: string): Promise<void> {
  // BlobStore interface doesn't expose `list`, so we iterate the
  // bulk_job_files rows directly and delete each ordinal's tmp key.
  // R2 TTL-based lifecycle backstops anything we miss here.
  try {
    const files = await listBulkJobFiles(env.db, bulkJobId);
    for (const f of files) {
      try {
        await env.blobs.delete(bulkUploadKey(bulkJobId, f.ordinal));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

void deleteBulkJob; // exported but intentionally not called from routes — used by the expire cron only
