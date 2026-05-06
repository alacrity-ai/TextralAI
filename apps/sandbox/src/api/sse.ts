// Server-Sent Events reader. Yields {event, data} pairs.
//
// /v1/query?stream=sse emits two event types:
//   - `token`: `data: {"delta": "..."}` — append to in-progress answer
//   - `done`:  `data: {<full QueryResponse-shaped payload>}`

export async function* readSSE(
  res: Response,
): AsyncGenerator<{ event: string; data: string }, void, unknown> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      yield { event, data: data.join('\n') };
    }
  }
}
