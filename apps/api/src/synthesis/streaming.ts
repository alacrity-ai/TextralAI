// Phase 6.5 — SSE encoding for the streaming query path.
//
// Two SSE event types:
//   token: { text: "..." }       — emitted per upstream content delta
//   done:  { audit, citations,   — emitted exactly once at the end
//            answer, degradation_level, query_event_id }
//
// We deliberately don't expose an `error` event. A mid-stream upstream
// failure is reported as a `done` with degradation_level='cannot_answer'
// + synthesis_status='failed'. This keeps consumers in a two-state
// machine instead of three.

const enc = new TextEncoder();

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

export function encodeSseFrame(event: 'token' | 'done', data: unknown): Uint8Array {
  // SSE wire format: `event: <name>\ndata: <json>\n\n`. JSON keeps
  // multi-line content from breaking the wire.
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export interface StreamRunResult {
  /** Concatenated token deltas. */
  text: string;
  input_tokens: number;
  output_tokens: number;
  /** True if the stream completed cleanly; false on any provider error
   *  or network drop. */
  ok: boolean;
  /** Populated when ok=false. */
  error_message?: string;
}
