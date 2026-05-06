// /v1/admin/ingestion-jobs — DLQ inspection (Phase 6.2).
//
// Reads dead-lettered jobs scoped to the caller's tenant. Requires the
// 'admin' scope on the API key. The retry POST lives in the sibling
// /v1/ingestion-jobs/:id/retry route (so the URL matches the user's
// mental model: "the job lives at /v1/ingestion-jobs; retry it
// there").

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Env, Variables } from '../../types.js';
import { z } from '../../openapi/z.js';
import { Responses } from '../../openapi/registry.js';
import { listDeadLetteredJobs } from '../../db/jobs.js';
import { requireScope } from '../../auth/scopes.js';
import { IngestionJobSchema } from '../../openapi/components.js';

export const adminIngestionJobsRoute = new OpenAPIHono<{
  Bindings: Env;
  Variables: Variables;
}>();

const DlqListQuery = z.object({
  dead_lettered: z.enum(['1']).openapi({ example: '1' }),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

const DlqListResponse = z.object({
  items: z.array(IngestionJobSchema),
  next_cursor: z.string().nullable(),
});

const listDlq = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin'],
  summary: 'List dead-lettered ingestion jobs',
  description:
    'Tenant-scoped via the calling API key. Requires `admin` scope. Cursor-paginated by `created_at` descending.',
  security: [{ ApiKeyAuth: [] }],
  request: { query: DlqListQuery },
  responses: {
    200: {
      description: 'Page of DLQ jobs.',
      content: { 'application/json': { schema: DlqListResponse } },
    },
    401: Responses.unauthorized,
    403: Responses.forbidden,
  },
});

adminIngestionJobsRoute.openapi(listDlq, async (c) => {
  requireScope(c, 'admin');
  const tenantId = c.get('tenant_id')!;
  const q = c.req.valid('query');
  const page = await listDeadLetteredJobs(c.env.db, tenantId, {
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  return c.json(
    {
      items: page.items.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id,
        document_id: r.document_id,
        version_id: r.version_id,
        version_index_id: r.version_index_id,
        mode: r.mode as 'full' | 'embed_only' | 'enrichment_only',
        status: r.status as 'pending' | 'running' | 'retrying' | 'completed' | 'failed',
        current_stage: r.current_stage,
        error_code: r.error_code,
        error_message: r.error_message,
        attempt_count: r.attempt_count,
        created_at: r.created_at,
        completed_at: r.completed_at,
      })),
      next_cursor: page.next_cursor,
    },
    200,
  );
});
