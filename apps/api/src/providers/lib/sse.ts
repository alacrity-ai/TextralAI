// Minimal SSE event-stream reader. Produces { event?, data } objects
// from a stream of bytes.
//
// Not a generic SSE library — it handles only the fields we consume:
//   event: <name>
//   data:  <json>
//   data:  [DONE]   (OpenAI terminator; the caller decides what to do)
//
// Comments (lines starting with ':') and unknown fields are skipped.
// Multi-line `data:` is concatenated with `\n`, per the spec.

export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<{ event?: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const idx = indexOfDelimiter(buffer);
      if (idx === null) break;
      const block = buffer.slice(0, idx.start);
      buffer = buffer.slice(idx.end);
      const ev: { event?: string; data: string } = { data: '' };
      for (const line of block.split('\n')) {
        const trimmed = line.replace(/\r$/, '');
        if (trimmed.startsWith(':')) continue;
        const colon = trimmed.indexOf(':');
        if (colon < 0) continue;
        const key = trimmed.slice(0, colon).trim();
        // The SSE spec calls for a single optional space after the colon.
        let val = trimmed.slice(colon + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (key === 'event') ev.event = val;
        else if (key === 'data') ev.data += (ev.data ? '\n' : '') + val;
      }
      if (ev.data) yield ev;
    }
  }
}

interface Delim {
  start: number;
  end: number;
}

/** Finds either `\n\n` or `\r\n\r\n` (whichever comes first). */
function indexOfDelimiter(s: string): Delim | null {
  const a = s.indexOf('\n\n');
  const b = s.indexOf('\r\n\r\n');
  if (a < 0 && b < 0) return null;
  if (a >= 0 && (b < 0 || a < b)) return { start: a, end: a + 2 };
  return { start: b, end: b + 4 };
}
