// Citation validation.
//
// Parses [N] references from the answer text and validates them against
// the assembled context. Hallucinated citations are recorded in
// `dropped_citations` and excluded from the returned `citations[]`,
// but the answer prose is NEVER mutated.

import type { IncludedChunk } from '../retrieval/context-assembly.js';

export interface CitationOut {
  n: number;
  chunk_id: string;
  section_path: string | null;
  quote?: string;
}

export interface CitationValidation {
  valid_citations: CitationOut[];
  dropped_citations: number[]; // bogus Ns
  citation_integrity: 'valid' | 'invalid_removed' | 'missing';
}

const CITATION_RE = /\[(\d+)\]/g;

export function validateCitations(
  answerText: string,
  included: IncludedChunk[],
): CitationValidation {
  const matches = new Set<number>();
  for (const m of answerText.matchAll(CITATION_RE)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) matches.add(n);
  }
  if (matches.size === 0) {
    return { valid_citations: [], dropped_citations: [], citation_integrity: 'missing' };
  }
  const byN = new Map<number, IncludedChunk>();
  for (const c of included) byN.set(c.n, c);

  const valid: CitationOut[] = [];
  const dropped: number[] = [];
  for (const n of [...matches].sort((a, b) => a - b)) {
    const c = byN.get(n);
    if (!c) {
      dropped.push(n);
      continue;
    }
    valid.push({
      n,
      chunk_id: c.chunk_id,
      section_path: c.section_path,
    });
  }
  let integrity: CitationValidation['citation_integrity'];
  if (valid.length > 0 && dropped.length === 0) integrity = 'valid';
  else if (valid.length === 0) integrity = 'missing';
  else integrity = 'invalid_removed';
  return { valid_citations: valid, dropped_citations: dropped, citation_integrity: integrity };
}

/** For structured-mode citation arrays that come back as objects with
 *  chunk_id keys. Filters to chunks that exist in the context. */
export function filterStructuredCitations<T extends { chunk_id?: unknown }>(
  raw: T[],
  included: IncludedChunk[],
): { kept: T[]; dropped_ids: string[] } {
  const validIds = new Set(included.map((c) => c.chunk_id));
  const kept: T[] = [];
  const dropped: string[] = [];
  for (const c of raw) {
    if (typeof c.chunk_id === 'string' && validIds.has(c.chunk_id)) kept.push(c);
    else if (typeof c.chunk_id === 'string') dropped.push(c.chunk_id);
  }
  return { kept, dropped_ids: dropped };
}
