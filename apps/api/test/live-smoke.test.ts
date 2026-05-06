// Live integration smoke test — gated by RUN_LIVE_TESTS=1.
//
// Hits each provider with one minimal call and asserts only that the
// outcome is `success`. Latency is recorded for inspection but not
// asserted; PR-blocking SLO checks belong in a nightly benchmark, not
// the unit suite (a transient network/region hiccup must not red-line
// the PR pipeline).
//
// Provider keys come from environment variables:
//   OPENAI_API_KEY, ANTHROPIC_API_KEY, VOYAGE_API_KEY
// The Workers AI binding tier needs no key.

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { openaiDirect } from '../src/providers/openai-compat.js';
import { anthropic } from '../src/providers/anthropic.js';
import { voyageRerank } from '../src/providers/voyage-rerank.js';
import { WorkersAIBindingProvider } from '../src/providers/workers-ai-binding.js';
import type { Env } from '../src/types.js';

const RUN = process.env.RUN_LIVE_TESTS === '1';
const dlive = RUN ? describe : describe.skip;

interface LatencyRecord {
  provider: string;
  op: string;
  latency_ms: number;
  retry_count: number;
}

const records: LatencyRecord[] = [];

dlive('Phase 2 live smoke', () => {
  it('OpenAI chat: gpt-4o-mini "ping"', async () => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY not set');
    const r = await openaiDirect.chat(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] },
      { api_key: key },
    );
    expect(r.outcome).toBe('success');
    records.push({
      provider: 'openai',
      op: 'chat',
      latency_ms: r.meta.latency_ms,
      retry_count: r.meta.retry_count,
    });
  }, 30_000);

  it('OpenAI embed: text-embedding-3-small ["ping"]', async () => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY not set');
    const r = await openaiDirect.embed(
      { model: 'text-embedding-3-small', input: ['ping'] },
      { api_key: key },
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      expect(r.value.vectors).toHaveLength(1);
      expect(r.value.vectors[0]!.length).toBe(1536);
    }
    records.push({
      provider: 'openai',
      op: 'embed',
      latency_ms: r.meta.latency_ms,
      retry_count: r.meta.retry_count,
    });
  }, 30_000);

  it('Workers AI chat: @cf/meta/llama-3.1-8b-instruct "ping"', async () => {
    const e = env as unknown as Env;
    const provider = new WorkersAIBindingProvider(e.AI);
    const r = await provider.chat(
      {
        model: '@cf/meta/llama-3.1-8b-instruct',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 32,
      },
      {},
    );
    expect(r.outcome).toBe('success');
    records.push({
      provider: 'workers_ai',
      op: 'chat',
      latency_ms: r.meta.latency_ms,
      retry_count: r.meta.retry_count,
    });
  }, 30_000);

  it('Workers AI embed: @cf/baai/bge-large-en-v1.5 ["ping","pong"]', async () => {
    const e = env as unknown as Env;
    const provider = new WorkersAIBindingProvider(e.AI);
    const r = await provider.embed(
      { model: '@cf/baai/bge-large-en-v1.5', input: ['ping', 'pong'] },
      {},
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      expect(r.value.vectors).toHaveLength(2);
      // BGE-large-en-v1.5 is 1024-dim; the binding tier returns floats[].
      expect(r.value.vectors[0]!.length).toBe(1024);
      expect(provider.dimensions('@cf/baai/bge-large-en-v1.5')).toBe(1024);
    }
    records.push({
      provider: 'workers_ai',
      op: 'embed',
      latency_ms: r.meta.latency_ms,
      retry_count: r.meta.retry_count,
    });
  }, 30_000);

  it('Anthropic chat: claude-haiku-4-5 "ping"', async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY not set');
    const r = await anthropic.chat(
      {
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 32,
      },
      { api_key: key },
    );
    expect(r.outcome).toBe('success');
    records.push({
      provider: 'anthropic',
      op: 'chat',
      latency_ms: r.meta.latency_ms,
      retry_count: r.meta.retry_count,
    });
  }, 30_000);

  it('Voyage rerank: top-3 over 5 candidates', async () => {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) throw new Error('VOYAGE_API_KEY not set');
    const r = await voyageRerank.rerank(
      {
        model: 'rerank-2',
        query: 'how does retrieval work?',
        documents: [
          'The capital of France is Paris.',
          'RAG combines retrieval with generation.',
          'Vector databases store embeddings.',
          'A bicycle has two wheels.',
          'Cosine similarity measures vector closeness.',
        ],
        top_n: 3,
      },
      { api_key: key },
    );
    expect(r.outcome).toBe('success');
    if (r.outcome === 'success') {
      expect(r.value.results.length).toBeGreaterThanOrEqual(1);
    }
    records.push({
      provider: 'voyage',
      op: 'rerank',
      latency_ms: r.meta.latency_ms,
      retry_count: r.meta.retry_count,
    });
  }, 30_000);

  it('records latency summary', () => {
    if (records.length === 0) return;
    console.log('phase2_live_latency', JSON.stringify(records, null, 2));
  });
});
