// Conservative FTS5 query construction.
//
// Default mode: parse quoted phrases first (preserve them verbatim);
// for unquoted text, alphanumeric + safe Unicode-letter terms only,
// drop FTS5 operators (AND OR NOT NEAR ^ : -), OR-join.
//
// `advanced_query: true` mode is reserved for a later phase. For now
// the assumption is: consumer queries are natural language; never
// pass raw operators through.

import { TextralError } from '@textral/contracts';

const FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

export function buildFts5Match(query: string): string {
  const quoted: string[] = [];
  let cleaned = query;

  // 1. Pull out quoted phrases.
  cleaned = cleaned.replace(/"([^"]+)"/g, (_, phrase: string) => {
    const inner = phrase.trim();
    if (inner) quoted.push(`"${inner.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim()}"`);
    return ' ';
  });

  // 2. Tokenize remaining text. Allow Unicode letters/numbers + underscore.
  const terms: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue;
    const upper = raw.toUpperCase();
    if (FTS5_OPERATORS.has(upper)) continue;
    // Strip leading/trailing punctuation; bail if nothing usable left.
    const trimmed = raw.replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase();
    if (!trimmed) continue;
    terms.push(trimmed);
  }

  const all = [...quoted, ...terms];
  if (all.length === 0) {
    throw new TextralError('EMPTY_QUERY', 400, 'Query has no usable terms after sanitization');
  }
  return all.join(' OR ');
}
