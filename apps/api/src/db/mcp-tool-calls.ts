// mcp_tool_calls reads. Sister to db/jobs.ts (DLQ list pattern).
// Writes happen in audit/mcp.ts.

import type { Db } from '../runtime/shared/interfaces.js';

export interface McpToolCallRow {
  id: string;
  tenant_id: string;
  api_key_id: string | null;
  tool_name: string;
  transport: 'stdio' | 'http';
  args_redacted: string | Record<string, unknown>;
  rest_call_count: number;
  latency_ms: number;
  outcome: 'ok' | 'tool_error' | 'rest_error' | 'cancelled';
  error_code: string | null;
  error_message: string | null;
  created_at: number;
}

export interface McpToolCall {
  id: string;
  api_key_id: string | null;
  tool_name: string;
  transport: 'stdio' | 'http';
  args_redacted: Record<string, unknown> | unknown[] | null;
  rest_call_count: number;
  latency_ms: number;
  outcome: 'ok' | 'tool_error' | 'rest_error' | 'cancelled';
  error_code: string | null;
  error_message: string | null;
  created_at: number;
}

function rowToCall(r: McpToolCallRow): McpToolCall {
  let parsed: McpToolCall['args_redacted'] = null;
  if (r.args_redacted === null || r.args_redacted === undefined) {
    parsed = null;
  } else if (typeof r.args_redacted === 'string') {
    try {
      parsed = JSON.parse(r.args_redacted) as McpToolCall['args_redacted'];
    } catch {
      parsed = null;
    }
  } else {
    // Postgres returns JSONB as a parsed object already.
    parsed = r.args_redacted as McpToolCall['args_redacted'];
  }
  return {
    id: r.id,
    api_key_id: r.api_key_id,
    tool_name: r.tool_name,
    transport: r.transport,
    args_redacted: parsed,
    rest_call_count: r.rest_call_count,
    latency_ms: r.latency_ms,
    outcome: r.outcome,
    error_code: r.error_code,
    error_message: r.error_message,
    created_at: r.created_at,
  };
}

export async function listMcpToolCalls(
  db: Db,
  tenant_id: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ items: McpToolCall[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const cursorTs = opts.cursor ? Number(opts.cursor) : null;
  const rows =
    cursorTs !== null
      ? await db.all<McpToolCallRow>(
          `SELECT * FROM mcp_tool_calls
              WHERE tenant_id = ? AND created_at < ?
              ORDER BY created_at DESC
              LIMIT ?`,
          [tenant_id, cursorTs, limit + 1],
        )
      : await db.all<McpToolCallRow>(
          `SELECT * FROM mcp_tool_calls
              WHERE tenant_id = ?
              ORDER BY created_at DESC
              LIMIT ?`,
          [tenant_id, limit + 1],
        );
  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const items = sliced.map(rowToCall);
  const next_cursor = hasMore ? String(sliced[sliced.length - 1]!.created_at) : null;
  return { items, next_cursor };
}
