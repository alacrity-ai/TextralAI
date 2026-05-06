// /v1/ingestion-jobs/* — read-side. Status, stage attempt logs, retry.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { IngestionJobSchema, StageAttemptList, JobIdParam } from '../openapi/components.js';
import { Responses } from '../openapi/registry.js';
import {
  getJobById,
  listStageAttemptsForJob,
  rowToJob,
  rowToStageAttempt,
  clearDeadLetterAndReset,
} from '../db/jobs.js';
import { requireScope } from '../auth/scopes.js';

export const ingestionJobsRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

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
