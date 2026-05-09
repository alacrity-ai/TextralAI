// SSE stream parser tests.

import { describe, it, expect } from 'vitest';
import { streamSse, TextralStreamInterrupted } from '../src/index.js';

function bodyFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]!));
      i++;
    },
  });
}

describe('streamSse', () => {
  it('yields parsed JSON frames in order', async () => {
    const body = bodyFrom([
      'data: {"type":"token","value":"a"}\n\n',
      'data: {"type":"token","value":"b"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const out: unknown[] = [];
    for await (const f of streamSse(body)) {
      out.push(f);
    }
    expect(out).toEqual([
      { type: 'token', value: 'a' },
      { type: 'token', value: 'b' },
    ]);
  });

  it('reassembles frames split across chunk boundaries', async () => {
    const body = bodyFrom([
      'data: {"type":"to', // half a frame
      'ken","value":"x"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const out: unknown[] = [];
    for await (const f of streamSse(body)) {
      out.push(f);
    }
    expect(out).toEqual([{ type: 'token', value: 'x' }]);
  });

  it('handles multiple frames per chunk', async () => {
    const body = bodyFrom([
      'data: {"a":1}\n\ndata: {"a":2}\n\ndata: {"a":3}\n\ndata: [DONE]\n\n',
    ]);
    const out: unknown[] = [];
    for await (const f of streamSse(body)) {
      out.push(f);
    }
    expect(out).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('throws TextralStreamInterrupted when stream ends without [DONE]', async () => {
    const body = bodyFrom([
      'data: {"type":"token","value":"a"}\n\n',
      // No [DONE] frame; reader hits EOS.
    ]);
    const out: unknown[] = [];
    await expect(async () => {
      for await (const f of streamSse(body)) {
        out.push(f);
      }
    }).rejects.toBeInstanceOf(TextralStreamInterrupted);
    expect(out).toEqual([{ type: 'token', value: 'a' }]);
  });

  it('throws TextralStreamInterrupted on malformed JSON inside a data line', async () => {
    const body = bodyFrom([
      'data: {"type":"token","value":"a"}\n\n',
      'data: not json {\n\n',
      'data: [DONE]\n\n',
    ]);
    const out: unknown[] = [];
    await expect(async () => {
      for await (const f of streamSse(body)) {
        out.push(f);
      }
    }).rejects.toBeInstanceOf(TextralStreamInterrupted);
    // Only the first valid frame yielded.
    expect(out).toEqual([{ type: 'token', value: 'a' }]);
  });

  it('skips comment-only frames (lines without data:)', async () => {
    const body = bodyFrom([
      ': keepalive\n\n',
      'data: {"type":"token","value":"a"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const out: unknown[] = [];
    for await (const f of streamSse(body)) {
      out.push(f);
    }
    expect(out).toEqual([{ type: 'token', value: 'a' }]);
  });

  it('aborts mid-stream when signal aborts', async () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Slow pull — emits one frame, waits, then would emit another.
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'));
        await new Promise((r) => setTimeout(r, 100));
        controller.enqueue(new TextEncoder().encode('data: {"a":2}\n\n'));
        controller.close();
      },
    });
    const ac = new AbortController();
    const out: unknown[] = [];
    const promise = (async () => {
      for await (const f of streamSse(body, { signal: ac.signal })) {
        out.push(f);
        ac.abort();
      }
    })();
    await expect(promise).rejects.toThrow();
    expect(out).toEqual([{ a: 1 }]);
  });

  it('handles `data:` (no space) variant', async () => {
    const body = bodyFrom([
      'data:{"a":1}\n\n',
      'data: [DONE]\n\n',
    ]);
    const out: unknown[] = [];
    for await (const f of streamSse(body)) {
      out.push(f);
    }
    expect(out).toEqual([{ a: 1 }]);
  });
});
