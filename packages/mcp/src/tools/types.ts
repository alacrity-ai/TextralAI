// Tool definition shape. Each tool declares its input as a Zod
// schema; the JSON Schema is derived once at module load via
// `toInputSchema`. Handlers receive the validated input + a typed
// REST client.

import type { z } from 'zod';
import type { TextralClient } from '@textral/sdk';
import { toInputSchema } from '../zod-to-input-schema.js';

/** Progress event fields. Maps onto MCP `notifications/progress`.
 *  The wrapper attaches the request's progressToken (if any) before
 *  emitting; tools just call `progress({ progress, total?, message? })`. */
export interface ToolProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface ToolHandlerCtx<TInput> {
  args: TInput;
  client: TextralClient;
  /** Increment when the tool fans out to a REST call. The audit
   *  middleware reads this to populate `mcp_tool_calls.rest_call_count`. */
  recordRestCall: () => void;
  /** Long-running tools call this on stage transitions. No-op when
   *  the caller didn't request progress (no progressToken). */
  progress: (event: ToolProgress) => Promise<void>;
  /** Aborted when the MCP client cancels the request. Long-running
   *  tools should check this between polls and abort with
   *  `outcome=cancelled`. */
  signal: AbortSignal;
}

/** Tool definition. We type both the schema's input (callers) and
 *  output (handlers) explicitly so handlers see post-parse types
 *  with defaults applied (no `string | undefined` on `.default()`
 *  fields). The wrapper invokes `inputSchemaZod.parse(rawArgs)` so
 *  the handler always receives the output type at runtime. */
export interface ToolDef<TIn = unknown, TOut = unknown, THandlerIn = TIn, THandlerOut = unknown> {
  name: string;
  /** Cap at 200 characters (Open Question 4 lock). Rich examples
   *  belong in workflow prompts, not tool descs. */
  description: string;
  inputSchemaZod: z.ZodType<TOut, z.ZodTypeDef, TIn>;
  inputSchema: Record<string, unknown>;
  handler: (ctx: ToolHandlerCtx<THandlerIn>) => Promise<THandlerOut>;
}

/** Define a tool. The handler receives the schema's *output* type —
 *  i.e., after Zod has applied defaults — so `.default(...)` fields
 *  are non-optional inside handlers. */
export function defineTool<TIn, TOut, THandlerOut>(
  args: Omit<ToolDef<TIn, TOut, TOut, THandlerOut>, 'inputSchema'>,
): ToolDef<TIn, TOut, TOut, THandlerOut> {
  if (args.description.length > 200) {
    throw new Error(
      `Tool ${args.name} description exceeds 200 chars (${args.description.length}). Move detail to a workflow prompt.`,
    );
  }
  return {
    ...args,
    inputSchema: toInputSchema(args.inputSchemaZod as unknown as z.ZodTypeAny),
  };
}
