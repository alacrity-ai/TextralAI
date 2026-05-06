// /v1/query-events — read-side audit.
//
//   GET /                  list (paginated, tenant-scoped, ?namespace_slug, ?status)
//   GET /{id}              single audit row
//   GET /{id}/response     mirrored QueryResponse from blob storage (sandbox replay)

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  TextralError,
  QueryEvent,
  QueryResponse,
  type QueryEvent as QueryEventType,
  type QueryResponse as QueryResponseType,
} from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { Responses } from '../openapi/registry.js';
import { z } from '../openapi/z.js';
import {
  getQueryEventById,
  listQueryEvents,
  type QueryEventRow,
} from '../db/query-events.js';
import { getNamespaceBySlug } from '../db/namespaces.js';

export const queryEventsRoute = new OpenAPIHono<{
  Bindings: Env;
  Variables: Variables;
}>();

const QueryEventComponent = QueryEvent.openapi('QueryEvent');

const QueryEventListResponse = z
  .object({
    data: z.array(QueryEventComponent),
    next_cursor: z.string().nullable(),
  })
  .openapi('QueryEventList');

/** Row → API DTO. Centralized so the single-event GET and the list GET
 *  emit identical shapes — the FE's QueryHistory replay flow assumes
 *  a row from the list and a row from the detail look the same. */
function rowToEvent(row: QueryEventRow): QueryEventType {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    namespace_id: row.namespace_id,
    status: row.status as QueryEventType['status'],
    query_text: row.query_text,
    request_config: JSON.parse(row.request_config) as Record<string, unknown>,
    degradation_level: (row.degradation_level ?? null) as QueryEventType['degradation_level'],
    retrieval_status: row.retrieval_status,
    citation_integrity: row.citation_integrity,
    synthesis_status: row.synthesis_status,
    candidates_returned: row.candidates_returned,
    citations_returned: row.citations_returned,
    dropped_citations: row.dropped_citations
      ? (JSON.parse(row.dropped_citations) as number[])
      : null,
    latency_ms: row.latency_ms,
    answer_r2_key: row.answer_r2_key,
    mirror_error: row.mirror_error,
    error_code: row.error_code,
    error_message: row.error_message,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().openapi({
    param: { name: 'limit', in: 'query' },
    example: 50,
    description: 'Page size, 1..200 (default 50).',
  }),
  cursor: z.string().optional().openapi({
    param: { name: 'cursor', in: 'query' },
    description:
      'Opaque cursor returned as `next_cursor` from the previous page. Pass it back to fetch the next page; omit for the first page.',
  }),
  namespace_slug: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: 'namespace_slug', in: 'query' },
      example: 'cookbook-qdrant',
      description:
        'Filter to one namespace by slug. The slug is resolved against the calling tenant; an unknown slug returns an empty page.',
    }),
  status: z
    .enum([
      'received',
      'retrieval_started',
      'retrieval_completed',
      'synthesis_started',
      'completed',
      'failed',
    ])
    .optional()
    .openapi({
      param: { name: 'status', in: 'query' },
      description:
        'Filter by event status. Useful values: `failed` (triage), `completed` (success-only history).',
    }),
});

const list = createRoute({
  method: 'get',
  path: '/',
  tags: ['Query'],
  summary: 'List query events',
  description:
    "Returns the calling tenant's most recent query events, newest first. Cursor-paginated by `created_at` descending — pass the previous page's `next_cursor` back to fetch the next page. Supports optional `namespace_slug` and `status` filters.",
  security: [{ ApiKeyAuth: [] }],
  request: { query: ListQuery },
  responses: {
    200: {
      description: 'A page of query events.',
      content: { 'application/json': { schema: QueryEventListResponse } },
    },
    401: Responses.unauthorized,
  },
});

queryEventsRoute.openapi(list, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const q = c.req.valid('query');

  // Slug → id resolution. An unknown slug short-circuits to an empty
  // page so callers don't see a 404 (the list surface is "no rows" -
  // friendly, not "missing collection"-strict).
  let namespaceId: string | undefined;
  if (q.namespace_slug) {
    const ns = await getNamespaceBySlug(c.env.db, tenantId, q.namespace_slug);
    if (!ns) {
      return c.json({ data: [], next_cursor: null }, 200);
    }
    namespaceId = ns.id;
  }

  const page = await listQueryEvents(c.env.db, tenantId, {
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
    ...(namespaceId ? { namespace_id: namespaceId } : {}),
    ...(q.status ? { status: q.status } : {}),
  });

  return c.json(
    {
      data: page.items.map(rowToEvent),
      next_cursor: page.next_cursor,
    },
    200,
  );
});

const Param = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
});

const get = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Query'],
  summary: 'Get a query event',
  description: 'Returns the audit record for a single query (success or failed).',
  security: [{ ApiKeyAuth: [] }],
  request: { params: Param },
  responses: {
    200: {
      description: 'Query event.',
      content: { 'application/json': { schema: QueryEventComponent } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

queryEventsRoute.openapi(get, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const row = await getQueryEventById(c.env.db, tenantId, id);
  if (!row) throw new TextralError('NOT_FOUND', 404, 'Query event not found');
  return c.json(rowToEvent(row), 200);
});

// ── GET /{id}/response — mirrored QueryResponse ────────────────────────
//
// Pulls the JSON we mirrored to blob storage at query time
// (`mirrorAnswer` in src/audit/query-events.ts) and returns it. Powers
// the sandbox's history replay: when an operator clicks a row, we want
// not just the request_config but the answer + citations + audit they
// got back originally, so the right pane on QueryBench can hydrate
// without re-running.
//
// Failure modes:
//   404  — row doesn't exist (or wrong tenant — same shape).
//   410  — row exists, but the mirror isn't readable: the query failed
//          before mirroring (`answer_r2_key` null), the mirror call
//          itself failed (`mirror_error` set), or the blob has been
//          reaped. Emits `QUERY_RESPONSE_UNAVAILABLE` with details so
//          the FE can pick the right empty-state copy.
//   502  — blob present but not parseable as a QueryResponse (corrupt
//          mirror). Practically unreachable; pinned for completeness.
const QueryResponseComponent = QueryResponse.openapi('QueryResponse');

const getResponse = createRoute({
  method: 'get',
  path: '/{id}/response',
  tags: ['Query'],
  summary: 'Get the mirrored answer for a query event',
  description:
    "Returns the full `QueryResponse` (answer + citations + audit) we wrote at query time. Used by the sandbox's history replay — clicking a historical row hydrates the QueryBench result pane from this endpoint without re-running the query. Returns 410 with `QUERY_RESPONSE_UNAVAILABLE` when the row exists but the mirror is missing (failed query, mirror_error, or reaped blob).",
  security: [{ ApiKeyAuth: [] }],
  request: { params: Param },
  responses: {
    200: {
      description: 'Mirrored QueryResponse.',
      content: { 'application/json': { schema: QueryResponseComponent } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
    410: Responses.gone,
  },
});

queryEventsRoute.openapi(getResponse, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const row = await getQueryEventById(c.env.db, tenantId, id);
  if (!row) throw new TextralError('NOT_FOUND', 404, 'Query event not found');

  if (!row.answer_r2_key) {
    throw new TextralError(
      'QUERY_RESPONSE_UNAVAILABLE',
      410,
      'No mirrored answer available for this query event.',
      {
        reason: row.mirror_error ? 'mirror_error' : 'never_mirrored',
        ...(row.mirror_error ? { mirror_error: row.mirror_error } : {}),
        ...(row.error_code ? { event_error_code: row.error_code } : {}),
        ...(row.error_message ? { event_error_message: row.error_message } : {}),
      },
    );
  }

  const obj = await c.env.blobs.get(row.answer_r2_key);
  if (!obj) {
    throw new TextralError(
      'QUERY_RESPONSE_UNAVAILABLE',
      410,
      'Mirrored answer was reaped or never written; key no longer resolves.',
      { reason: 'reaped', key: row.answer_r2_key },
    );
  }

  // BlobGet.body is a ReadableStream<Uint8Array>; `new Response(...)`
  // gives us .text() / .json() on both runtimes.
  const text = await new Response(obj.body).text();
  let parsed: QueryResponseType;
  try {
    parsed = JSON.parse(text) as QueryResponseType;
  } catch (e) {
    throw new TextralError(
      'INTERNAL',
      502,
      'Mirrored answer is not valid JSON.',
      { reason: 'corrupt_mirror', detail: String((e as Error).message) },
    );
  }
  // The mirror is the exact JSON we serialized at query time, so the
  // shape match is guaranteed at write time. We don't re-validate here
  // (would add latency for no benefit and would surface drift bugs as
  // 502s on previously-valid rows after schema evolution).
  return c.json(parsed, 200);
});
