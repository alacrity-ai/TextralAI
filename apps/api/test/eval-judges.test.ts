// Phase 7.3 — judge invocation.
//
// Mocks globalThis.fetch so the judge's chat call returns a fixture
// JSON response. Asserts: high-quality fixture scores ≥ 4; malformed
// JSON throws EVAL_JUDGE_FAILED.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { runJudge } from '../src/eval/judges.js';
import { TextralError } from '@textral/contracts';
import type { Env } from '../src/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockChatJson(payload: unknown, status = 200): void {
  const body = JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  globalThis.fetch = vi
    .fn()
    .mockResolvedValue(new Response(body, { status })) as unknown as typeof globalThis.fetch;
}

describe('Phase 7.3 — judges', () => {
  it('parses a 5-score JSON response', async () => {
    const e = env as unknown as Env;
    mockChatJson({ score: 5, reasoning: 'Excellent' });
    const out = await runJudge(
      e,
      'relevance',
      {
        question: 'Where is Alexandria?',
        answer: 'Egypt.',
        citations: [{ n: 1, text: 'Alexandria is in Egypt.' }],
      },
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        api_key: 'sk-ant-test',
        tenant_id: 'ten_x',
      },
    );
    expect(out.score).toBe(5);
    expect(out.reasoning).toBe('Excellent');
  });

  it('parses a 2-score for a known-bad answer', async () => {
    const e = env as unknown as Env;
    mockChatJson({ score: 2, reasoning: 'Off-topic' });
    const out = await runJudge(
      e,
      'groundedness',
      {
        question: 'Where is Alexandria?',
        answer: 'I prefer pasta.',
        citations: [],
      },
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        api_key: 'sk-ant-test',
        tenant_id: 'ten_x',
      },
    );
    expect(out.score).toBe(2);
  });

  it('throws EVAL_JUDGE_FAILED on malformed JSON', async () => {
    const e = env as unknown as Env;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'not-json-at-all' }],
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      runJudge(
        e,
        'citation_quality',
        { question: 'Q?', answer: 'A.', citations: [] },
        {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          api_key: 'sk-ant-test',
          tenant_id: 'ten_x',
        },
      ),
    ).rejects.toBeInstanceOf(TextralError);
  });

  it('throws EVAL_JUDGE_FAILED on out-of-range score', async () => {
    const e = env as unknown as Env;
    mockChatJson({ score: 99, reasoning: 'lol' });
    await expect(
      runJudge(
        e,
        'relevance',
        { question: 'Q?', answer: 'A.', citations: [] },
        {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          api_key: 'sk-ant-test',
          tenant_id: 'ten_x',
        },
      ),
    ).rejects.toBeInstanceOf(TextralError);
  });

  it('honors tenant-supplied judge override', async () => {
    const e = env as unknown as Env;
    let capturedRequest: { messages: Array<{ content: string }> } | null = null;
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) capturedRequest = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"score":4,"reasoning":"ok"}' }],
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const customPrompt = 'CUSTOM_PROMPT_MARKER\nQuestion: {{question}}\nAnswer: {{answer}}';
    await runJudge(
      e,
      'relevance',
      { question: 'Q?', answer: 'A.', citations: [] },
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        api_key: 'sk-ant-test',
        tenant_id: 'ten_x',
      },
      customPrompt,
    );
    expect(capturedRequest).not.toBeNull();
    const messages = (capturedRequest as unknown as { messages: Array<{ content: string }> })
      .messages;
    expect(messages[0]!.content).toContain('CUSTOM_PROMPT_MARKER');
  });
});
