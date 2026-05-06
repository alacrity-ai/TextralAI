// Provider error redaction.
//
// Phase 2 contract: no upstream string is assigned to
// `safe_upstream_message` without flowing through `redact()` first.
// This test pins the contract for every provider key shape we know:
// no fragment of a provider key ever appears in a `ProviderError`, in
// a logged telemetry event, or in any error envelope.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { openaiDirect } from '../src/providers/openai-compat.js';
import { anthropic } from '../src/providers/anthropic.js';
import { voyageRerank } from '../src/providers/voyage-rerank.js';

const FAKE_KEYS = [
  'sk-proj-abcdefghijklmnopqrstuvwxyz0123',
  'sk-ant-abcdefghijklmnopqrstuvwxyz0123',
  'voy-abcdefghijklmnopqrstuvwxyz',
];

afterEach(() => {
  vi.restoreAllMocks();
});

for (const fakeKey of FAKE_KEYS) {
  describe(`provider-error redaction (${fakeKey.slice(0, 8)}...)`, () => {
    it('OpenAI: upstream error echoing the key never leaks', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'invalid_api_key',
              message: `Invalid API key: ${fakeKey}`,
            },
          }),
          { status: 401 },
        ),
      ) as unknown as typeof globalThis.fetch;

      const captured: string[] = [];
      const origInfo = console.info;
      console.info = (...args: unknown[]): void => {
        captured.push(JSON.stringify(args));
      };

      try {
        const result = await openaiDirect.chat(
          { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
          { api_key: fakeKey },
        );
        const blob = JSON.stringify(result);
        expect(blob).not.toContain(fakeKey);
        expect(captured.some((s) => s.includes(fakeKey))).toBe(false);
      } finally {
        console.info = origInfo;
      }
    });

    it('Anthropic: upstream error echoing the key never leaks', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: `Bad key: ${fakeKey}` },
          }),
          { status: 401 },
        ),
      ) as unknown as typeof globalThis.fetch;

      const captured: string[] = [];
      const origInfo = console.info;
      console.info = (...args: unknown[]): void => {
        captured.push(JSON.stringify(args));
      };
      try {
        const result = await anthropic.chat(
          { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
          { api_key: fakeKey },
        );
        const blob = JSON.stringify(result);
        expect(blob).not.toContain(fakeKey);
        expect(captured.some((s) => s.includes(fakeKey))).toBe(false);
      } finally {
        console.info = origInfo;
      }
    });

    it('Voyage: upstream error echoing the key never leaks', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'invalid_api_key', message: `Invalid: ${fakeKey}` },
          }),
          { status: 401 },
        ),
      ) as unknown as typeof globalThis.fetch;

      const captured: string[] = [];
      const origInfo = console.info;
      console.info = (...args: unknown[]): void => {
        captured.push(JSON.stringify(args));
      };
      try {
        const result = await voyageRerank.rerank(
          { model: 'rerank-2', query: 'q', documents: ['a'] },
          { api_key: fakeKey },
        );
        const blob = JSON.stringify(result);
        expect(blob).not.toContain(fakeKey);
        expect(captured.some((s) => s.includes(fakeKey))).toBe(false);
      } finally {
        console.info = origInfo;
      }
    });
  });
}
