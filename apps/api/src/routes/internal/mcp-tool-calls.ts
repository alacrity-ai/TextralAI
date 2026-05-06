// POST /v1/_internal/mcp_tool_calls — back-channel for the stdio MCP
// server's audit write. The MCP server (running outside the API
// process) submits each tool-call event with the standard tenant
// API key; the route resolves tenant_id from the auth context and
// inserts via the canonical `recordMcpToolCall` writer.
//
// Embedded `/mcp` writes audit rows in-process and does not call
// this endpoint.
//
// Not on the public OpenAPI sidebar — it's part of the MCP
// integration's internal protocol, not the user-facing REST API.

import { Hono } from 'hono';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../../types.js';
import { recordMcpToolCall } from '../../audit/mcp.js';

export const internalMcpToolCallsRoute = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();

interface SubmitBody {
  tool_name?: unknown;
  transport?: unknown;
  args_redacted?: unknown;
  rest_call_count?: unknown;
  latency_ms?: unknown;
  outcome?: unknown;
  error_code?: unknown;
  error_message?: unknown;
}

internalMcpToolCallsRoute.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SubmitBody;

  const toolName = typeof body.tool_name === 'string' ? body.tool_name : '';
  const transport =
    body.transport === 'stdio' || body.transport === 'http' ? body.transport : null;
  const outcome =
    body.outcome === 'ok' ||
    body.outcome === 'tool_error' ||
    body.outcome === 'rest_error' ||
    body.outcome === 'cancelled'
      ? body.outcome
      : null;
  const restCalls =
    typeof body.rest_call_count === 'number' && Number.isFinite(body.rest_call_count)
      ? body.rest_call_count
      : null;
  const latency =
    typeof body.latency_ms === 'number' && Number.isFinite(body.latency_ms)
      ? body.latency_ms
      : null;

  if (!toolName || transport === null || outcome === null || restCalls === null || latency === null) {
    throw new TextralError('BAD_REQUEST', 400, 'mcp_tool_calls: missing or invalid fields');
  }

  const tenantId = c.get('tenant_id') as string;
  const apiKeyId = (c.get('api_key_id') as string | undefined) ?? null;

  const errorCode = typeof body.error_code === 'string' ? body.error_code : undefined;
  const errorMessage = typeof body.error_message === 'string' ? body.error_message : undefined;

  await recordMcpToolCall(c.env, {
    tenant_id: tenantId,
    api_key_id: apiKeyId,
    tool_name: toolName,
    transport,
    args_redacted: body.args_redacted,
    rest_call_count: Math.max(0, Math.floor(restCalls)),
    latency_ms: Math.max(0, Math.floor(latency)),
    outcome,
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(errorMessage ? { error_message: errorMessage } : {}),
  });

  return c.json({ ok: true }, 201);
});
