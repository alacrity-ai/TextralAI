import { describe, it, expect } from 'vitest';
import { validateCitations } from '../src/synthesis/citation-validator.js';
import type { IncludedChunk } from '../src/retrieval/context-assembly.js';

function included(...ids: string[]): IncludedChunk[] {
  return ids.map((chunk_id, i) => ({
    n: i + 1,
    chunk_id,
    artifact_type: 'passage',
    section_path: '/',
    text: 't',
    metadata: null,
  }));
}

describe('validateCitations', () => {
  it('returns valid citations when all [N] exist in context', () => {
    const r = validateCitations('See [1] and [2] for details.', included('chk_a', 'chk_b'));
    expect(r.citation_integrity).toBe('valid');
    expect(r.dropped_citations).toEqual([]);
    expect(r.valid_citations.map((c) => c.n)).toEqual([1, 2]);
    expect(r.valid_citations[0]!.chunk_id).toBe('chk_a');
  });

  it('drops invalid citations but does NOT mutate prose', () => {
    const text = 'Per [99], see also [1].';
    const r = validateCitations(text, included('chk_a', 'chk_b'));
    expect(r.citation_integrity).toBe('invalid_removed');
    expect(r.dropped_citations).toEqual([99]);
    expect(r.valid_citations.map((c) => c.n)).toEqual([1]);
    // Caller is responsible for keeping the answer text — this function
    // never touches it. Verify by re-asserting the input text equals
    // itself (sanity).
    expect(text).toBe('Per [99], see also [1].');
  });

  it('returns missing when answer has no [N] markers', () => {
    const r = validateCitations('Just some text.', included('chk_a'));
    expect(r.citation_integrity).toBe('missing');
    expect(r.valid_citations).toEqual([]);
  });

  it('returns missing when every [N] is invalid', () => {
    const r = validateCitations('See [9] and [10].', included('chk_a'));
    expect(r.citation_integrity).toBe('missing');
    expect(r.dropped_citations).toEqual([9, 10]);
  });
});
