// mcp_tool_calls writer.
//
// Sister to query-events.ts — same redaction policy
// (tenants.audit_mode), same write-on-finally discipline. Used by
// both transports:
//
//   * Stdio: the MCP server (running outside the API process) POSTs
//     to /v1/_internal/mcp_tool_calls, which calls this writer.
//   * Embedded /mcp: the route handler invokes this writer directly,
//     no extra round-trip.

import { newId } from '@textral/contracts';
import type { Env } from '../types.js';
import type { AuditMode } from './query-events.js';
import { getTenantAuditMode } from './query-events.js';

const REDACTED_TOKEN = '[REDACTED]';

export type McpToolOutcome = 'ok' | 'tool_error' | 'rest_error' | 'cancelled';
export type McpTransport = 'stdio' | 'http';

export interface RecordMcpToolCallArgs {
  tenant_id: string;
  api_key_id: string | null;
  tool_name: string;
  transport: McpTransport;
  args_redacted: unknown;
  rest_call_count: number;
  latency_ms: number;
  outcome: McpToolOutcome;
  error_code?: string;
  error_message?: string;
}

export async function recordMcpToolCall(
  env: Env,
  args: RecordMcpToolCallArgs,
): Promise<void> {
  const id = newId('mcp');
  const mode = await getTenantAuditMode(env, args.tenant_id);
  const redacted = redactMcpToolArgs(args.tool_name, args.args_redacted, mode);

  await env.db.exec(
    `INSERT INTO mcp_tool_calls (
       id, tenant_id, api_key_id, tool_name, transport,
       args_redacted, rest_call_count, latency_ms, outcome,
       error_code, error_message, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.tenant_id,
      args.api_key_id,
      args.tool_name,
      args.transport,
      JSON.stringify(redacted),
      args.rest_call_count,
      args.latency_ms,
      args.outcome,
      args.error_code ?? null,
      args.error_message ?? null,
      Date.now(),
    ],
  );
}

/** Redaction policy mirrors `redactRequestConfig` in query-events.ts.
 *  Tools with sensitive payloads:
 *    - query.query, query.prompt.system/developer, query.output.schema
 *    - ingest_file.bytes (always redacted; size kept for audit)
 *    - register_provider_key.key (always redacted; metadata kept)
 *  Other tools pass through their input under `audit_mode='full'`,
 *  ship a structural skeleton under `metadata_only`, and have
 *  string-shaped fields hidden under `redacted`. */
export function redactMcpToolArgs(
  toolName: string,
  rawArgs: unknown,
  mode: AuditMode,
): unknown {
  if (rawArgs === null || rawArgs === undefined) return rawArgs;
  if (typeof rawArgs !== 'object') return rawArgs;

  const cloned = JSON.parse(JSON.stringify(rawArgs)) as Record<string, unknown>;

  // Always-redact fields. These never go to disk, regardless of
  // audit_mode.
  if ('bytes' in cloned && typeof cloned.bytes === 'string') {
    cloned.bytes = `${REDACTED_TOKEN}(base64:${cloned.bytes.length}b)`;
  }
  if (toolName === 'register_provider_key' && 'key' in cloned) {
    cloned.key = REDACTED_TOKEN;
  }

  if (mode === 'full') return cloned;

  if (mode === 'metadata_only') {
    return shrinkToMetadata(toolName, cloned);
  }

  // 'redacted' — keep structure, redact prompt-shaped strings.
  if (toolName === 'query') {
    if (typeof cloned.query === 'string') cloned.query = REDACTED_TOKEN;
    if (cloned.prompt && typeof cloned.prompt === 'object') {
      const p = cloned.prompt as Record<string, unknown>;
      if (typeof p.system === 'string') p.system = REDACTED_TOKEN;
      if (typeof p.developer === 'string') p.developer = REDACTED_TOKEN;
    }
    if (cloned.output && typeof cloned.output === 'object') {
      const o = cloned.output as Record<string, unknown>;
      if ('schema' in o) o.schema = REDACTED_TOKEN;
    }
  }
  return cloned;
}

function shrinkToMetadata(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Preserve common identifiers/structure that's not user content.
  for (const k of ['namespace', 'slug', 'id', 'document_id', 'job_id', 'limit', 'cursor', 'mode', 'wait', 'transport'] as const) {
    if (k in args) out[k] = args[k];
  }
  if ('embedding' in args && typeof args.embedding === 'object' && args.embedding) {
    const e = args.embedding as Record<string, unknown>;
    out.embedding = pick(e, ['provider', 'model']);
  }
  if (toolName === 'query') {
    if ('inference' in args && typeof args.inference === 'object' && args.inference) {
      const i = args.inference as Record<string, unknown>;
      out.inference = pick(i, ['provider', 'model']);
    }
    if ('retrieval' in args && typeof args.retrieval === 'object' && args.retrieval) {
      const r = args.retrieval as Record<string, unknown>;
      out.retrieval = pick(r, ['strategy']);
    }
    if ('output' in args && typeof args.output === 'object' && args.output) {
      const o = args.output as Record<string, unknown>;
      out.output = pick(o, ['mode']);
    }
  }
  if (toolName === 'register_provider_key') {
    out.provider = args.provider;
    out.label = args.label;
  }
  return out;
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in obj) out[k] = obj[k];
  }
  return out;
}
