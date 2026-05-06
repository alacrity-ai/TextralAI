// /v1/admin/mcp_tool_calls — list recent MCP tool invocations for the
// calling tenant. Powers the Sandbox MCP tab (Step 13). Sister to
// /v1/admin/ingestion-jobs?dead_lettered=1.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Env, Variables } from '../../types.js';
import { z } from '../../openapi/z.js';
import { Responses } from '../../openapi/registry.js';
import { listMcpToolCalls } from '../../db/mcp-tool-calls.js';
import { requireScope } from '../../auth/scopes.js';

export const adminMcpToolCallsRoute = new OpenAPIHono<{
  Bindings: Env;
  Variables: Variables;
}>();

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

const McpToolCallSchema = z
  .object({
    id: z.string(),
    api_key_id: z.string().nullable(),
    tool_name: z.string(),
    transport: z.enum(['stdio', 'http']),
    args_redacted: z.unknown(),
    rest_call_count: z.number().int(),
    latency_ms: z.number().int(),
    outcome: z.enum(['ok', 'tool_error', 'rest_error', 'cancelled']),
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    created_at: z.number().int(),
  })
  .openapi('McpToolCall');

const ListResponse = z
  .object({
    items: z.array(McpToolCallSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi('McpToolCallListResponse');

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin'],
  summary: 'List recent MCP tool calls',
  description:
    'Returns the audit trail of MCP tool invocations for the calling tenant. Cursor-paginated by created_at descending. Requires `admin` scope.',
  security: [{ ApiKeyAuth: [] }],
  request: { query: ListQuery },
  responses: {
    200: {
      description: 'Page of MCP tool-call audit rows.',
      content: { 'application/json': { schema: ListResponse } },
    },
    401: Responses.unauthorized,
    403: Responses.forbidden,
  },
});

adminMcpToolCallsRoute.openapi(listRoute, async (c) => {
  requireScope(c, 'admin');
  const tenantId = c.get('tenant_id')!;
  const q = c.req.valid('query');
  const page = await listMcpToolCalls(c.env.db, tenantId, {
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  return c.json(page, 200);
});
