import { describe, it, expect } from 'vitest';
import { buildFts5Match } from '../src/retrieval/fts5-query.js';

describe('buildFts5Match', () => {
  it('OR-joins simple alphanumeric terms (lowercased)', () => {
    expect(buildFts5Match('Force Quit Application')).toBe('force OR quit OR application');
  });

  it('preserves quoted phrases', () => {
    expect(buildFts5Match('"force quit" application')).toBe('"force quit" OR application');
  });

  it('drops FTS5 operators (AND OR NOT NEAR)', () => {
    expect(buildFts5Match('AND OR NOT helpful?')).toBe('helpful');
    expect(buildFts5Match('NEAR query')).toBe('query');
  });

  it('drops special punctuation like : ^ - and emits the bare term', () => {
    expect(buildFts5Match('colon:case ^anchor -negative')).toBe('coloncase OR anchor OR negative');
  });

  it('throws EMPTY_QUERY when nothing usable remains', () => {
    expect(() => buildFts5Match('AND OR NOT')).toThrow(/no usable terms/);
    expect(() => buildFts5Match('!!!')).toThrow(/no usable terms/);
  });

  it('preserves Unicode letters', () => {
    expect(buildFts5Match('café résumé')).toBe('café OR résumé');
  });
});
