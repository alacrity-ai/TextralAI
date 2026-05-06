import { describe, it, expect, vi } from 'vitest';
import { WorkersAIBindingProvider } from '../src/providers/workers-ai-binding.js';

interface FakeAi {
  run: ReturnType<typeof vi.fn>;
}

function fakeAi(impl: (...args: unknown[]) => unknown): FakeAi {
  return { run: vi.fn().mockImplementation(impl) };
}

describe('WorkersAIBindingProvider.chat', () => {
  it('returns success for a non-empty response', async () => {
    const ai = fakeAi(() => ({
      response: 'hi there',
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }));
    const p = new WorkersAIBindingProvider(ai as unknown as Ai);
    const r = await p.chat(
      { model: '@cf/meta/llama-3.1-8b-instruct', messages: [{ role: 'user', content: 'hi' }] },
      {},
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      expect(r.value.content).toBe('hi there');
      expect(r.value.usage.input_tokens).toBe(2);
    }
  });

  it('returns retryable_error type=schema_violation when json parse fails', async () => {
    const ai = fakeAi(() => ({ response: '{not json' }));
    const p = new WorkersAIBindingProvider(ai as unknown as Ai);
    const r = await p.chat(
      {
        model: '@cf/meta/llama-3.1-8b-instruct',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      },
      {},
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('schema_violation');
    }
  });

  it('returns retryable_error type=server_error when binding throws', async () => {
    const ai = fakeAi(() => {
      throw new Error('binding boom');
    });
    const p = new WorkersAIBindingProvider(ai as unknown as Ai);
    const r = await p.chat(
      { model: '@cf/meta/llama-3.1-8b-instruct', messages: [{ role: 'user', content: 'hi' }] },
      {},
    );
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('server_error');
      expect(r.error.safe_upstream_message).toContain('binding boom');
    }
  });
});

describe('WorkersAIBindingProvider.embed', () => {
  it('returns vectors when shape matches', async () => {
    const ai = fakeAi(() => ({
      data: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    }));
    const p = new WorkersAIBindingProvider(ai as unknown as Ai);
    const r = await p.embed({ model: '@cf/baai/bge-large-en-v1.5', input: ['a', 'b'] }, {});
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') expect(r.value.vectors).toHaveLength(2);
  });

  it('returns retryable_error type=partial_batch when count diverges', async () => {
    const ai = fakeAi(() => ({ data: [[0, 0]] }));
    const p = new WorkersAIBindingProvider(ai as unknown as Ai);
    const r = await p.embed({ model: '@cf/baai/bge-large-en-v1.5', input: ['a', 'b'] }, {});
    expect(r.outcome).toBe('retryable_error');
    if (r.outcome === 'retryable_error') {
      expect(r.error.type).toBe('partial_batch');
    }
  });
});

describe('WorkersAIBindingProvider.dimensions', () => {
  const p = new WorkersAIBindingProvider({} as Ai);
  it('maps known Workers AI embedding models', () => {
    expect(p.dimensions('@cf/baai/bge-large-en-v1.5')).toBe(1024);
    expect(p.dimensions('@cf/baai/bge-base-en-v1.5')).toBe(768);
    expect(p.dimensions('@cf/baai/bge-small-en-v1.5')).toBe(384);
  });
  it('throws on unknown', () => {
    expect(() => p.dimensions('mystery')).toThrow();
  });
});

describe('WorkersAIBindingProvider.stream', () => {
  it('emits a single error event explaining the unsupported path', async () => {
    const p = new WorkersAIBindingProvider({} as Ai);
    const out: unknown[] = [];
    for await (const ev of p.stream(
      { model: '@cf/meta/llama-3.1-8b-instruct', messages: [{ role: 'user', content: 'hi' }] },
      {},
    )) {
      out.push(ev);
    }
    expect(out).toHaveLength(1);
    expect((out[0] as { type: string }).type).toBe('error');
  });
});
