import { describe, it, expect } from 'vitest';
import {
  ChatRequest,
  EmbeddingRequest,
  RerankRequest,
  ChatResponse,
  EmbeddingResponse,
  RerankResponse,
} from '../src/provider.js';

describe('provider request schemas', () => {
  it('parses a minimal ChatRequest', () => {
    const out = ChatRequest.parse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.model).toBe('gpt-4o-mini');
    expect(out.messages).toHaveLength(1);
  });

  it('rejects ChatRequest with empty messages array', () => {
    expect(() => ChatRequest.parse({ model: 'gpt-4o-mini', messages: [] })).toThrow();
  });

  it('parses a ChatRequest with json_schema response format', () => {
    const out = ChatRequest.parse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: {
        type: 'json_schema',
        name: 'Reply',
        strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    });
    expect(out.response_format?.type).toBe('json_schema');
  });

  it('parses an EmbeddingRequest with multiple inputs', () => {
    const out = EmbeddingRequest.parse({
      model: 'text-embedding-3-large',
      input: ['a', 'b', 'c'],
    });
    expect(out.input).toHaveLength(3);
  });

  it('rejects EmbeddingRequest with empty input array', () => {
    expect(() => EmbeddingRequest.parse({ model: 'text-embedding-3-large', input: [] })).toThrow();
  });

  it('parses a RerankRequest', () => {
    const out = RerankRequest.parse({
      model: 'rerank-2',
      query: 'how does X work?',
      documents: ['doc1', 'doc2', 'doc3'],
      top_n: 2,
    });
    expect(out.documents).toHaveLength(3);
    expect(out.top_n).toBe(2);
  });
});

describe('provider response schemas', () => {
  it('round-trips a ChatResponse', () => {
    const r = {
      content: 'hello',
      usage: { input_tokens: 5, output_tokens: 7 },
      model: 'gpt-4o-mini',
      finish_reason: 'stop' as const,
    };
    const parsed = ChatResponse.parse(r);
    expect(parsed.content).toBe('hello');
  });

  it('round-trips an EmbeddingResponse', () => {
    const r = {
      vectors: [
        [1, 2, 3],
        [4, 5, 6],
      ],
      model: 'text-embedding-3-large',
      usage: { input_tokens: 4 },
    };
    const parsed = EmbeddingResponse.parse(r);
    expect(parsed.vectors).toHaveLength(2);
  });

  it('round-trips a RerankResponse', () => {
    const r = {
      results: [
        { index: 1, score: 0.91 },
        { index: 0, score: 0.5 },
      ],
      model: 'rerank-2',
    };
    const parsed = RerankResponse.parse(r);
    expect(parsed.results).toHaveLength(2);
  });
});
