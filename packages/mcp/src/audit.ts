// MCP tool-call audit writer. Two implementations:
//
//   * ApiAuditWriter — used by the stdio transport. POSTs to
//     `/v1/_internal/mcp_tool_calls` so the API resolves tenant_id
//     from the API key and writes to the canonical store.
//   * Direct callback — used by the embedded /mcp transport. The
//     handler in apps/api passes a closure that calls
//     `recordMcpToolCall(env, ...)` directly.
//
// Both implementations satisfy the same `AuditWriter` interface so
// `wrapWithAudit` doesn't care which is in play.

import type { TextralClient } from '@textral/sdk';
import { TextralApiError } from '@textral/sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDef, ToolProgress } from './tools/types.js';

/** Per-call hooks the request handler in `server.ts` plumbs through
 *  from MCP's `RequestHandlerExtra`. The wrapper attaches the
 *  request's `progressToken` (if any) to every emitted progress
 *  notification; the AbortSignal lets long-running tools observe
 *  client cancellation. */
export interface RequestHooks {
  /** Set when the caller requested progress (params._meta.progressToken). */
  progressToken?: string | number;
  /** Sends an MCP progress notification. */
  sendProgress?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
  /** Aborted when the MCP client cancels the request. */
  signal: AbortSignal;
}

export type ToolOutcome = 'ok' | 'tool_error' | 'rest_error' | 'cancelled';

export interface AuditEvent {
  tool_name: string;
  transport: 'stdio' | 'http';
  args_redacted: unknown;
  rest_call_count: number;
  latency_ms: number;
  outcome: ToolOutcome;
  error_code?: string;
  error_message?: string;
}

export interface AuditWriter {
  record: (event: AuditEvent) => Promise<void>;
}

export class ApiAuditWriter implements AuditWriter {
  constructor(private client: TextralClient) {}
  async record(event: AuditEvent): Promise<void> {
    // Best-effort. We never want an audit-write failure to mask a
    // tool result; swallow + log to stderr. The stdio MCP server
    // routes its writes through /v1/_internal/mcp_tool_calls so
    // tenant resolution stays server-side.
    try {
      await this.client.internal.submitMcpToolCall(event);
    } catch (e) {
      console.error('mcp audit write failed:', (e as Error).message);
    }
  }
}

/** Wraps a tool handler with: input validation (Zod .parse), latency
 *  tracking, REST-call counting, and audit-row writing. The audit
 *  row is written from a `finally` block, so it always lands —
 *  even on exceptions. */
// Type-erased alias so callers can pass concrete tools without
// fighting invariance on the four ToolDef generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = ToolDef<any, any, any, any>;

export async function wrapWithAudit(
  ctx: { client: TextralClient; audit: AuditWriter; transport: 'stdio' | 'http' },
  tool: AnyToolDef,
  rawArgs: unknown,
  hooks: RequestHooks,
): Promise<CallToolResult> {
  const start = Date.now();
  let restCalls = 0;
  let outcome: ToolOutcome = 'ok';
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  let validatedArgs: unknown;
  let result: unknown;
  let raised: unknown;

  const progress = async (event: ToolProgress): Promise<void> => {
    if (hooks.progressToken === undefined || !hooks.sendProgress) return;
    try {
      await hooks.sendProgress({
        method: 'notifications/progress',
        params: {
          progressToken: hooks.progressToken,
          progress: event.progress,
          ...(event.total !== undefined ? { total: event.total } : {}),
          ...(event.message !== undefined ? { message: event.message } : {}),
        },
      });
    } catch {
      // Progress is best-effort. Don't fail the tool on a transport
      // hiccup.
    }
  };

  try {
    validatedArgs = tool.inputSchemaZod.parse(rawArgs);
    result = await (tool.handler as (ctx: unknown) => Promise<unknown>)({
      args: validatedArgs,
      client: ctx.client,
      recordRestCall: () => {
        restCalls += 1;
      },
      progress,
      signal: hooks.signal,
    });
  } catch (e) {
    raised = e;
    if (hooks.signal.aborted) {
      outcome = 'cancelled';
      errorCode = 'CANCELLED';
      errorMessage = 'request cancelled';
    } else if (e instanceof TextralApiError) {
      outcome = 'rest_error';
      errorCode = e.code;
      errorMessage = e.message;
    } else if (e instanceof Error) {
      outcome = 'tool_error';
      errorCode = (e as { code?: string }).code ?? 'TOOL_INVALID_INPUT';
      errorMessage = e.message;
    } else {
      outcome = 'tool_error';
      errorMessage = String(e);
    }
  }

  await ctx.audit
    .record({
      tool_name: tool.name,
      transport: ctx.transport,
      args_redacted: rawArgs,
      rest_call_count: restCalls,
      latency_ms: Date.now() - start,
      outcome,
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(errorMessage ? { error_message: errorMessage } : {}),
    })
    .catch((e: Error) => {
      console.error('mcp audit write failed:', e.message);
    });

  if (raised) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: {
                code: errorCode ?? 'INTERNAL',
                message: errorMessage ?? 'tool failed',
              },
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}
