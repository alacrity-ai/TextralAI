// /v1/ingestion-jobs/* — read-side + cancel. Status, stage attempt
// logs, list, retry, cancel.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { IngestionJobSchema, StageAttemptList, JobIdParam } from '../openapi/components.js';
import { Responses } from '../openapi/registry.js';
import { z } from '../openapi/z.js';
import {
  cancelJob,
  getJobById,
  listJobsForTenant,
  listStageAttemptsForJob,
  rowToJob,
  rowToStageAttempt,
  clearDeadLetterAndReset,
} from '../db/jobs.js';
import { getNamespaceBySlug } from '../db/namespaces.js';
import { requireScope } from '../auth/scopes.js';

export const ingestionJobsRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ── GET /v1/ingestion-jobs ───────────────────────────────────────────
// Tenant-scoped paginated list. Powers the sandbox's ingest history
// page and the cross-page "active jobs" recovery on app load.

const ListJobsQuery = z.object({
  status: z
    .string()
    .optional()
    .openapi({
      param: { name: 'status', in: 'query' },
      example: 'pending,running,retrying',
      description:
        'CSV of job statuses to include. Valid values: pending, running, retrying, completed, failed.',
    }),
  namespace_slug: z.string().optional().openapi({ param: { name: 'namespace_slug', in: 'query' } }),
  document_id: z.string().optional().openapi({ param: { name: 'document_id', in: 'query' } }),
  limit: z.coerce.number().int().min(1).max(100).optional().openapi({
    param: { name: 'limit', in: 'query' },
    example: 25,
  }),
  cursor: z.string().optional().openapi({
    param: { name: 'cursor', in: 'query' },
    description: 'Opaque cursor returned as `next_cursor` from the previous page.',
  }),
});

const ListJobsResponse = z
  .object({
    data: z.array(IngestionJobSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi('IngestionJobList');

const VALID_STATUSES = new Set([
  'pending',
  'running',
  'retrying',
  'completed',
  'failed',
]);

const listJobs = createRoute({
  method: 'get',
  path: '/',
  tags: ['Ingestion'],
  summary: 'List ingestion jobs',
  description:
    'Tenant-scoped, cursor-paginated. Order by `created_at` descending. Use `status` (CSV) to filter to in-flight jobs (`pending,running,retrying`) or to a slice of history (`completed,failed`).',
  security: [{ ApiKeyAuth: [] }],
  request: { query: ListJobsQuery },
  responses: {
    200: { description: 'Page of jobs.', content: { 'application/json': { schema: ListJobsResponse } } },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

ingestionJobsRoute.openapi(listJobs, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const q = c.req.valid('query');
  const statuses = q.status
    ? q.status.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  for (const s of statuses) {
    if (!VALID_STATUSES.has(s)) {
      throw new TextralError(
        'BAD_REQUEST',
        400,
        `Unknown status "${s}". Valid: ${[...VALID_STATUSES].join(', ')}`,
      );
    }
  }
  let namespaceId: string | undefined;
  if (q.namespace_slug) {
    const ns = await getNamespaceBySlug(c.env.db, tenantId, q.namespace_slug);
    if (!ns) {
      throw new TextralError(
        'NAMESPACE_NOT_FOUND',
        404,
        `Namespace not found: ${q.namespace_slug}`,
      );
    }
    namespaceId = ns.id;
  }
  const page = await listJobsForTenant(c.env.db, tenantId, {
    ...(statuses.length > 0 ? { status: statuses } : {}),
    ...(namespaceId ? { namespace_id: namespaceId } : {}),
    ...(q.document_id ? { document_id: q.document_id } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  return c.json(
    { data: page.items.map(rowToJob), next_cursor: page.next_cursor },
    200,
  );
});

const getJob = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Ingestion'],
  summary: 'Get an ingestion job',
  security: [{ ApiKeyAuth: [] }],
  request: { params: JobIdParam },
  responses: {
    200: {
      description: 'Job state.',
      content: { 'application/json': { schema: IngestionJobSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

ingestionJobsRoute.openapi(getJob, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const row = await getJobById(c.env.db, tenantId, id);
  if (!row) throw new TextralError('NOT_FOUND', 404, 'Ingestion job not found');
  return c.json(rowToJob(row), 200);
});

const getJobLogs = createRoute({
  method: 'get',
  path: '/{id}/logs',
  tags: ['Ingestion'],
  summary: 'Stage attempt history for a job',
  description:
    'One row per stage attempt; failed attempts are preserved. Latest attempt per stage is the row with the highest `attempt` and `status="completed"`.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: JobIdParam },
  responses: {
    200: {
      description: 'Stage attempts.',
      content: { 'application/json': { schema: StageAttemptList } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

ingestionJobsRoute.openapi(getJobLogs, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const job = await getJobById(c.env.db, tenantId, id);
  if (!job) throw new TextralError('NOT_FOUND', 404, 'Ingestion job not found');
  const rows = await listStageAttemptsForJob(c.env.db, tenantId, id);
  return c.json({ data: rows.map(rowToStageAttempt) }, 200);
});

// ── POST /v1/ingestion-jobs/{id}/retry ───────────────────────────────
// Phase 6.2 — clears dead_lettered, resets attempt_count, re-enqueues.
// Requires the 'admin' scope.

const retryJob = createRoute({
  method: 'post',
  path: '/{id}/retry',
  tags: ['Ingestion'],
  summary: 'Retry a dead-lettered ingestion job',
  description:
    'Re-enqueues a previously dead-lettered job. Requires `admin` scope. Returns 404 if the job does not exist or is not currently dead-lettered (the latter masquerades as 404 to avoid leaking job state).',
  security: [{ ApiKeyAuth: [] }],
  request: { params: JobIdParam },
  responses: {
    200: {
      description: 'Job re-enqueued.',
      content: { 'application/json': { schema: IngestionJobSchema } },
    },
    401: Responses.unauthorized,
    403: Responses.forbidden,
    404: Responses.notFound,
  },
});

ingestionJobsRoute.openapi(retryJob, async (c) => {
  requireScope(c, 'admin');
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const existing = await getJobById(c.env.db, tenantId, id);
  if (!existing) throw new TextralError('DLQ_NOT_FOUND', 404, 'Ingestion job not found');
  if (existing.dead_lettered !== 1) {
    // Don't reveal whether the job exists vs is/isn't DLQ'd. Same 404,
    // distinct code so legitimate admins see the right message.
    throw new TextralError(
      'DLQ_NOT_DEAD_LETTERED',
      400,
      'Job is not in dead-letter state',
    );
  }
  const updated = await clearDeadLetterAndReset(c.env.db, tenantId, id);
  if (!updated) {
    // Lost the CAS race — another retry just fired.
    throw new TextralError('DLQ_NOT_DEAD_LETTERED', 400, 'Job is not in dead-letter state');
  }
  await c.env.queue.send({ job_id: id, tenant_id: tenantId, attempt: 0 });
  return c.json(rowToJob(updated), 200);
});

// ── POST /v1/ingestion-jobs/{id}/cancel ──────────────────────────────
// User-initiated cancellation. Atomic CAS marks the job
// `failed`/`USER_CANCELLED` only if it's currently in a non-terminal
// state. Cooperative — the runner checks job status at each stage
// boundary and exits cleanly. The internal stage-attempt write also
// 409s on a cancelled job (defense in depth).

const cancelJobRoute = createRoute({
  method: 'post',
  path: '/{id}/cancel',
  tags: ['Ingestion'],
  summary: 'Cancel a running ingestion job',
  description:
    'Marks the job `failed` with `error_code="USER_CANCELLED"`. Cooperative cancellation — the running stage finishes (~seconds), the next stage skips, and the runner exits. Returns 409 `JOB_NOT_RUNNING` if the job is already terminal.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: JobIdParam },
  responses: {
    200: {
      description: 'Job marked cancelled.',
      content: { 'application/json': { schema: IngestionJobSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
    409: Responses.conflict,
  },
});

ingestionJobsRoute.openapi(cancelJobRoute, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const existing = await getJobById(c.env.db, tenantId, id);
  if (!existing) throw new TextralError('NOT_FOUND', 404, 'Ingestion job not found');
  const updated = await cancelJob(c.env.db, tenantId, id);
  if (!updated) {
    // CAS lost (job was terminal at update time).
    throw new TextralError(
      'JOB_NOT_RUNNING',
      409,
      `Job ${id} is already in a terminal state (${existing.status}); nothing to cancel.`,
    );
  }
  return c.json(rowToJob(updated), 200);
});
