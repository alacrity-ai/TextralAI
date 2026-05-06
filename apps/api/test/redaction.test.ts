// Unit tests for the redaction primitives. Fuzz-style coverage of every
// known provider-key shape.

import { describe, it, expect } from 'vitest';
import { redact, redactJson, redactHeaders } from '../src/middleware/redaction.js';

const SAMPLES = [
  // OpenAI project + plain
  'sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
  'sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
  // Anthropic
  'sk-ant-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
  // xAI
  'xai-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
  // Replicate
  'r8_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
  // Voyage
  'voy-aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789',
  // Our own keys
  'tx_live_01HZ8YQ8P9ABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
];

describe('redact()', () => {
  it.each(SAMPLES)('redacts %s out of plain text', (sample) => {
    const out = redact(`Hello ${sample} world`);
    expect(out).not.toContain(sample);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts multiple keys in one string', () => {
    const out = redact(`a=${SAMPLES[0]} b=${SAMPLES[1]}`);
    for (const s of [SAMPLES[0]!, SAMPLES[1]!]) {
      expect(out).not.toContain(s);
    }
  });

  it('does not over-redact innocent strings', () => {
    expect(redact('not a key')).toBe('not a key');
    expect(redact('http://example.com')).toBe('http://example.com');
  });
});

describe('redactJson()', () => {
  it('redacts string values that match patterns', () => {
    const out = redactJson({ note: `key=${SAMPLES[0]}` }) as { note: string };
    expect(out.note).not.toContain(SAMPLES[0]);
  });

  it('redacts known-sensitive field names regardless of value shape', () => {
    const out = redactJson({ apiKey: 'literally-anything' }) as { apiKey: string };
    expect(out.apiKey).toBe('[REDACTED]');
  });

  it('descends into nested objects + arrays', () => {
    const out = redactJson({
      payload: { nested: { secret: 'literally-anything', okay: 'fine' } },
      list: [{ key: 'x' }],
    }) as { payload: { nested: { secret: string; okay: string } }; list: { key: string }[] };
    expect(out.payload.nested.secret).toBe('[REDACTED]');
    expect(out.payload.nested.okay).toBe('fine');
    expect(out.list[0]!.key).toBe('[REDACTED]');
  });
});

describe('redactHeaders()', () => {
  it('strips Authorization, X-Textral-Api-Key, X-Provider-Key-* fully', () => {
    const h = new Headers({
      Authorization: 'Bearer secret-bearer-token-abc',
      'X-Textral-Api-Key': SAMPLES[6]!,
      'X-Provider-Key-OpenAI': SAMPLES[0]!,
      'Content-Type': 'application/json',
    });
    const out = redactHeaders(h);
    expect(out['authorization']).toBe('[REDACTED]');
    expect(out['x-textral-api-key']).toBe('[REDACTED]');
    expect(out['x-provider-key-openai']).toBe('[REDACTED]');
    expect(out['content-type']).toBe('application/json');
  });

  it('also pattern-redacts non-allowlisted headers that happen to contain a key shape', () => {
    const h = new Headers({ 'X-Echo-Header': `note ${SAMPLES[0]}` });
    const out = redactHeaders(h);
    expect(out['x-echo-header']).not.toContain(SAMPLES[0]);
  });
});
