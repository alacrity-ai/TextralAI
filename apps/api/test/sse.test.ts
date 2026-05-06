import { describe, it, expect } from 'vitest';
import { readSseEvents } from '../src/providers/lib/sse.js';

function streamFrom(body: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(body));
      controller.close();
    },
  });
}

describe('readSseEvents', () => {
  it('parses a single event with one data line', async () => {
    const out: { event?: string; data: string }[] = [];
    for await (const ev of readSseEvents(streamFrom('data: hello\n\n'))) {
      out.push(ev);
    }
    expect(out).toEqual([{ data: 'hello' }]);
  });

  it('parses multiple events', async () => {
    const body = 'data: a\n\ndata: b\n\ndata: c\n\n';
    const out: { event?: string; data: string }[] = [];
    for await (const ev of readSseEvents(streamFrom(body))) {
      out.push(ev);
    }
    expect(out.map((e) => e.data)).toEqual(['a', 'b', 'c']);
  });

  it('parses event: + data: pairs', async () => {
    const out: { event?: string; data: string }[] = [];
    for await (const ev of readSseEvents(streamFrom('event: token\ndata: hi\n\n'))) {
      out.push(ev);
    }
    expect(out).toEqual([{ event: 'token', data: 'hi' }]);
  });

  it('skips comment lines', async () => {
    const out: { event?: string; data: string }[] = [];
    for await (const ev of readSseEvents(streamFrom(': comment\ndata: x\n\n'))) {
      out.push(ev);
    }
    expect(out).toEqual([{ data: 'x' }]);
  });

  it('handles \\r\\n line endings', async () => {
    const out: { event?: string; data: string }[] = [];
    for await (const ev of readSseEvents(streamFrom('data: a\r\n\r\ndata: b\r\n\r\n'))) {
      out.push(ev);
    }
    expect(out.map((e) => e.data)).toEqual(['a', 'b']);
  });

  it('emits the OpenAI-style [DONE] terminator as a normal event', async () => {
    const out: { event?: string; data: string }[] = [];
    for await (const ev of readSseEvents(streamFrom('data: [DONE]\n\n'))) {
      out.push(ev);
    }
    expect(out).toEqual([{ data: '[DONE]' }]);
  });
});
