// Phase 6.4 — AI Gateway tag coverage.
//
// Lint-style test that walks every `resolve(env, { ... })` call site in
// apps/api/src and asserts each carries `tenant_id` in
// `request_metadata`. Drift-prevention: a fresh provider call without
// tenant_id breaks AIG dashboards' per-tenant grouping silently. This
// test catches it at PR time.

import { describe, it, expect } from 'vitest';

const SOURCE_FILES = import.meta.glob('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Match the start of `resolve(<env>, { ... })` — captures the args
// block up to the matching `)`. Brace-counting via regex isn't reliable
// across multi-line, so we do a linear scan after the match.
const RESOLVE_OPEN_RE = /\bresolveProvider\s*\(\s*[^,]+,\s*\{/g;

function extractCallArgs(text: string, start: number): string {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return text.slice(start, i);
}

const ALLOWLIST_FILE_SUFFIX = [
  // validate.ts uses an internal validation context where tenant_id is
  // a constructor invariant; multi-line assembly slips past the regex.
  '/providers/validate.ts',
];

describe('Phase 6.4 — AI Gateway tag coverage', () => {
  it('every resolveProvider call carries tenant_id in request_metadata', () => {
    const offenders: { file: string; snippet: string }[] = [];
    for (const [file, text] of Object.entries(SOURCE_FILES)) {
      if (ALLOWLIST_FILE_SUFFIX.some((s) => file.endsWith(s))) continue;
      for (const m of text.matchAll(RESOLVE_OPEN_RE)) {
        const start = m.index! + m[0].length;
        const args = extractCallArgs(text, start);
        if (!args.includes('tenant_id')) {
          offenders.push({ file, snippet: args.slice(0, 120) });
        }
      }
    }
    if (offenders.length > 0) {
      const lines = offenders
        .map((o) => `  ${o.file}: ${o.snippet}`)
        .join('\n');
      throw new Error(
        `resolveProvider call without tenant_id in request_metadata:\n${lines}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });
});
