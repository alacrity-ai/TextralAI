// `wrapWithAudit` records a row regardless of outcome (ok / tool
// error / rest error / cancelled). The audit row is written from a
// finally-block, so it always lands.

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { TextralClient, TextralApiError } from '@textral/sdk';
import { wrapWithAudit, type AuditEvent } from '../src/audit.js';
import { defineTool } from '../src/tools/types.js';

function fakeClient(): TextralClient {
  return new TextralClient({
    baseUrl: 'http://x',
    apiKey: 'tx_test',
    fetch: vi.fn(async () => new Response('null', { status: 200 })) as unknown as typeof globalThis.fetch,
  });
}

function recorder(): {
  writer: { record: (e: AuditEvent) => Promise<void> };
  events: AuditEvent[];
} {
  const events: AuditEvent[] = [];
  return {
    events,
    writer: {
      record: async (e) => {
        events.push(e);
      },
    },
  };
}

describe('wrapWithAudit', () => {
  it('records ok outcome on a successful tool', async () => {
    const tool = defineTool({
      name: 'echo',
      description: 'echo',
      inputSchemaZod: z.object({ msg: z.string() }),
      handler: async ({ args, recordRestCall }) => {
        recordRestCall();
        return { echo: args.msg };
      },
    });
    const { writer, events } = recorder();
    const ctrl = new AbortController();
    const result = await wrapWithAudit(
      { client: fakeClient(), audit: writer, transport: 'stdio' },
      tool,
      { msg: 'hi' },
      { signal: ctrl.signal },
    );
    expect(result.isError).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('ok');
    expect(events[0]!.tool_name).toBe('echo');
    expect(events[0]!.rest_call_count).toBe(1);
  });

  it('records tool_error on Zod validation failure', async () => {
    const tool = defineTool({
      name: 'strict',
      description: 'strict',
      inputSchemaZod: z.object({ n: z.number() }),
      handler: async () => ({}),
    });
    const { writer, events } = recorder();
    const ctrl = new AbortController();
    const result = await wrapWithAudit(
      { client: fakeClient(), audit: writer, transport: 'stdio' },
      tool,
      { n: 'oops' },
      { signal: ctrl.signal },
    );
    expect(result.isError).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('tool_error');
  });

  it('records rest_error on TextralApiError', async () => {
    const tool = defineTool({
      name: 'fail',
      description: 'fail',
      inputSchemaZod: z.object({}),
      handler: async () => {
        throw new TextralApiError(500, 'INTERNAL', 'boom');
      },
    });
    const { writer, events } = recorder();
    const ctrl = new AbortController();
    const result = await wrapWithAudit(
      { client: fakeClient(), audit: writer, transport: 'http' },
      tool,
      {},
      { signal: ctrl.signal },
    );
    expect(result.isError).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('rest_error');
    expect(events[0]!.error_code).toBe('INTERNAL');
  });

  it('records cancelled when the abort signal fires', async () => {
    const tool = defineTool({
      name: 'slow',
      description: 'slow',
      inputSchemaZod: z.object({}),
      handler: async ({ signal }) => {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) return reject(new Error('aborted'));
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return {};
      },
    });
    const { writer, events } = recorder();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5);
    const result = await wrapWithAudit(
      { client: fakeClient(), audit: writer, transport: 'stdio' },
      tool,
      {},
      { signal: ctrl.signal },
    );
    expect(result.isError).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('cancelled');
  });

  it('forwards progress notifications when a progressToken is set', async () => {
    const tool = defineTool({
      name: 'reporter',
      description: 'reporter',
      inputSchemaZod: z.object({}),
      handler: async ({ progress }) => {
        await progress({ progress: 1, total: 2, message: 'half' });
        await progress({ progress: 2, total: 2, message: 'done' });
        return { ok: true };
      },
    });
    const { writer } = recorder();
    const sent: Array<{ progress: number; message?: string }> = [];
    const ctrl = new AbortController();
    await wrapWithAudit(
      { client: fakeClient(), audit: writer, transport: 'http' },
      tool,
      {},
      {
        progressToken: 'tok',
        signal: ctrl.signal,
        sendProgress: async (n) => {
          sent.push({ progress: n.params.progress, ...(n.params.message ? { message: n.params.message } : {}) });
        },
      },
    );
    expect(sent).toEqual([
      { progress: 1, message: 'half' },
      { progress: 2, message: 'done' },
    ]);
  });
});
