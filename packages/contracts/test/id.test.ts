import { describe, it, expect } from 'vitest';
import { newId, parseId } from '../src/id.js';

describe('newId', () => {
  it('produces a prefixed 26-char ULID per call', () => {
    const id = newId('doc');
    expect(id).toMatch(/^doc_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('produces unique values across calls', () => {
    const a = newId('ten');
    const b = newId('ten');
    expect(a).not.toBe(b);
  });
});

describe('parseId', () => {
  it('round-trips a freshly-generated id', () => {
    const id = newId('ver');
    const parsed = parseId(id, 'ver');
    expect(parsed.prefix).toBe('ver');
    expect(parsed.ulid).toHaveLength(26);
  });

  it('throws when the prefix does not match', () => {
    const id = newId('ten');
    expect(() => parseId(id, 'doc')).toThrow(/Expected doc id, got ten/);
  });

  it('throws on a malformed id', () => {
    expect(() => parseId('no-underscore-here', 'doc')).toThrow(/Malformed id/);
  });
});
