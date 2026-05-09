// Server-Sent-Events parser + AsyncIterable wrapper.
//
// The Textral API exposes streaming query at
// `POST /v1/query?stream=sse`. Frames are JSON payloads in
// `data: ...` lines, terminated by `\n\n`, with `data: [DONE]`
// signaling the stream's end. This module turns a `ReadableStream<
// Uint8Array>` into an async iterator over decoded JSON frames.
//
// Streams are deliberately NOT retried by the SDK
// (NODE_SDK_IMPLEMENTATION.md §4.4 / Q7). If the underlying fetch
// fails mid-stream, we throw `TextralStreamInterrupted` and let the
// caller decide what to do.

import { TextralStreamInterrupted } from './errors.js';

/** Generic SSE frame emitted by the Textral query stream. The
 *  client narrows this to a discriminated union when it knows the
 *  expected shape (see `client.query.stream(...)`). */
export type SseFrame = Record<string, unknown>;

export interface StreamSseOptions {
  /** Cancel the stream mid-iteration. Aborting the signal cancels
   *  any in-flight `reader.read()` and releases the lock. */
  signal?: AbortSignal;
}

/** Consume a `Response.body` as an async iterable of decoded SSE
 *  frames. Caller owns the response lifecycle (we don't open or
 *  close it).
 *
 *  Generic-typed; the caller passes the expected union to narrow.
 *  We don't validate against a schema here — that's the wrapping
 *  client method's job (it knows what shapes are expected for the
 *  endpoint being called). */
export async function* streamSse<T extends SseFrame = SseFrame>(
  body: ReadableStream<Uint8Array>,
  opts: StreamSseOptions = {},
): AsyncIterable<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => {
      /* best-effort */
    });
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (aborted || opts.signal?.aborted) {
        throw opts.signal?.reason ?? new DOMException('Aborted', 'AbortError');
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (aborted) {
          throw opts.signal?.reason ?? new DOMException('Aborted', 'AbortError');
        }
        throw new TextralStreamInterrupted(
          `read failed: ${(err as Error)?.message ?? err}`,
          err,
        );
      }
      if (chunk.done) {
        // Reader reached end-of-stream without a [DONE] frame.
        // That's a soft interruption — the upstream pipe was cut.
        if (buffer.trim().length > 0) {
          // Try to emit any buffered last frame before interrupting.
          for (const f of drainBuffer<T>(buffer)) yield f;
        }
        throw new TextralStreamInterrupted(
          'stream ended before [DONE] frame',
        );
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const rawFrame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const payload = parseFrame(rawFrame);
        if (payload === DONE) return;
        if (payload !== undefined) yield payload as T;
      }
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel() */
    }
  }
}

const DONE = Symbol('DONE');

/** Parse one `data:`-prefixed frame block. Returns:
 *  - DONE      when the frame is `data: [DONE]`
 *  - undefined for empty / comment-only frames (skipped)
 *  - parsed JSON otherwise
 *  Throws on malformed JSON within a data block. */
function parseFrame(frame: string): typeof DONE | unknown | undefined {
  const dataLines = frame
    .split('\n')
    .filter((l) => l.startsWith('data: ') || l.startsWith('data:'))
    .map((l) => (l.startsWith('data: ') ? l.slice(6) : l.slice(5)));
  if (dataLines.length === 0) return undefined;
  const joined = dataLines.join('\n');
  const trimmed = joined.trim();
  if (trimmed === '[DONE]') return DONE;
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(joined);
  } catch (err) {
    throw new TextralStreamInterrupted(
      `malformed SSE data frame: ${(err as Error)?.message ?? err}`,
      err,
    );
  }
}

function* drainBuffer<T>(buffer: string): Generator<T> {
  // Best-effort flush of a non-terminated final frame. Used only on
  // soft EOS to give the caller something useful before we throw.
  const payload = parseFrame(buffer);
  if (payload !== undefined && payload !== DONE) yield payload as T;
}
