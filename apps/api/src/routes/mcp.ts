// Embedded MCP transport mounted at POST/GET/DELETE /v1/mcp.
//
// Phase 1 ships only on the Node runtime (self-host). The CF runtime
// returns 501 NOT_IMPLEMENTED with a documented message; CF-Workers
// support arrives once we've validated the Streamable HTTP transport
// against workerd's long-lived stream semantics.
//
// Auth lives upstream — every /v1/* request runs through requireApiKey
// before reaching this handler, so c.env.tenant_id and c.env.api_key_id
// are populated. Audit writes happen in-process via recordMcpToolCall;
// no extra back-channel hop.

import { Hono } from 'hono';
import type { Env, Variables } from '../types.js';
import { handleHttpMcp } from '@textral/mcp/http';
import { TextralClient } from '@textral/sdk';
import { recordMcpToolCall } from '../audit/mcp.js';
import type { AuditEvent } from '@textral/mcp';

export const mcpRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

mcpRoute.all('/', async (c) => {
  if (c.env.runtimeEnv !== 'self-host') {
    return c.json(
      {
        error: {
          code: 'NOT_IMPLEMENTED',
          message:
            'Embedded /v1/mcp is Node-runtime-only in Phase 1. Use the stdio CLI (`npx @textral/mcp`) on the Cloudflare runtime.',
          ...(c.get('request_id') ? { request_id: c.get('request_id') as string } : {}),
        },
      },
      501,
    );
  }

  const tenantId = c.get('tenant_id') as string;
  const apiKeyId = (c.get('api_key_id') as string | undefined) ?? null;
  const apiKey = c.req.header('X-Textral-Api-Key') ?? '';
  const baseUrl = new URL(c.req.url).origin;

  // The MCP server reaches the API back through the same /v1/* surface
  // it's currently serving. Loopback through fetch is fine here — every
  // tool fans out to public REST routes that already enforce tenant
  // scoping; embedding direct DB calls would duplicate that surface.
  const client = new TextralClient({ baseUrl, apiKey });

  const audit = {
    record: (event: AuditEvent): Promise<void> =>
      recordMcpToolCall(c.env, {
        tenant_id: tenantId,
        api_key_id: apiKeyId,
        tool_name: event.tool_name,
        transport: event.transport,
        args_redacted: event.args_redacted,
        rest_call_count: event.rest_call_count,
        latency_ms: event.latency_ms,
        outcome: event.outcome,
        ...(event.error_code ? { error_code: event.error_code } : {}),
        ...(event.error_message ? { error_message: event.error_message } : {}),
      }),
  };

  return await handleHttpMcp(c.req.raw, { client, audit, transport: 'http' });
});
