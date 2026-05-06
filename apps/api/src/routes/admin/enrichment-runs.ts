// Phase 6.8 — bulk enrichment-only admin endpoint.
//
// POST /v1/admin/namespaces/:slug/enrichment-runs
//   { filter?: { profile_id?, since?, until?, limit? }, dry_run?: bool }
//
// Selects (ready|partial) version_indexes in the namespace and enqueues
// `mode='enrichment_only'` jobs for each. The dry-run path reports the
// matched count without touching D1 or the queue.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError, newId } from '@textral/contracts';
import type { Env, Variables } from '../../types.js';
import { z } from '../../openapi/z.js';
import { Responses } from '../../openapi/registry.js';
import { requireScope } from '../../auth/scopes.js';
import { selectIndexesForEnrichmentRun } from '../../db/version-indexes.js';
import { insertIngestionJob } from '../../db/jobs.js';
import { bumpAndCheck } from '../../db/admin-rate-limits.js';
import { getNamespaceBySlug } from '../../db/namespaces.js';

const RATE_LIMIT_PER_MIN = 10;

export const adminEnrichmentRunsRoute = new OpenAPIHono<{
  Bindings: Env;
  Variables: Variables;
}>();

const Body = z.object({
  filter: z
    .object({
      profile_id: z.string().min(1).max(100).optional(),
      since: z.number().int().nonnegative().optional(),
      until: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    })
    .optional(),
  dry_run: z.boolean().optional(),
});

const Resp = z.object({
  matched: z.number().int(),
  enqueued: z.number().int(),
  dry_run: z.boolean(),
});

const SlugParam = z.object({ slug: z.string().min(1).max(80) });

const route = createRoute({
  method: 'post',
  path: '/{slug}/enrichment-runs',
  tags: ['Admin'],
  summary: 'Enqueue enrichment-only ingestion jobs in bulk',
  description:
    'Selects ready|partial version_indexes in the namespace matching the filter and enqueues `mode=enrichment_only` jobs. Requires `admin` scope. Rate-limited to 10 batches/min/tenant.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: SlugParam,
    body: { content: { 'application/json': { schema: Body } }, required: true },
  },
  responses: {
    200: { description: 'Batch result.', content: { 'application/json': { schema: Resp } } },
    401: Responses.unauthorized,
    403: Responses.forbidden,
    404: Responses.notFound,
    429: Responses.rateLimited,
  },
});

adminEnrichmentRunsRoute.openapi(route, async (c) => {
  requireScope(c, 'admin');
  const tenantId = c.get('tenant_id')!;
  const { slug } = c.req.valid('param');
  const body = c.req.valid('json');

  // Verify the namespace exists for this tenant up front; returns 404
  // if not (avoids a no-op succeed-with-zero-matches that hides a typo).
  const ns = await getNamespaceBySlug(c.env.db, tenantId, slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);

  // Rate limit before the (potentially expensive) selection.
  const rl = await bumpAndCheck(c.env.db, tenantId, 'enrichment_runs', RATE_LIMIT_PER_MIN);
  if (!rl.allowed) {
    throw new TextralError(
      'ADMIN_RATE_LIMITED',
      429,
      `Limit exceeded: ${RATE_LIMIT_PER_MIN}/min for enrichment_runs (current: ${rl.current})`,
    );
  }

  const matches = await selectIndexesForEnrichmentRun(c.env.db, {
    tenant_id: tenantId,
    namespace_slug: slug,
    ...(body.filter?.profile_id !== undefined ? { profile_id: body.filter.profile_id } : {}),
    ...(body.filter?.since !== undefined ? { since: body.filter.since } : {}),
    ...(body.filter?.until !== undefined ? { until: body.filter.until } : {}),
    ...(body.filter?.limit !== undefined ? { limit: body.filter.limit } : {}),
  });

  if (body.dry_run === true) {
    return c.json({ matched: matches.length, enqueued: 0, dry_run: true }, 200);
  }

  let enqueued = 0;
  for (const m of matches) {
    const jobId = newId('job');
    await insertIngestionJob(c.env.db, {
      id: jobId,
      tenant_id: m.tenant_id,
      document_id: m.document_id,
      version_id: m.version_id,
      version_index_id: m.id,
      mode: 'enrichment_only',
      config_json: '{}',
    });
    await c.env.queue.send({ job_id: jobId, tenant_id: m.tenant_id, attempt: 0 });
    enqueued++;
  }

  return c.json({ matched: matches.length, enqueued, dry_run: false }, 200);
});
