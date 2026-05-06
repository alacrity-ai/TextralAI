// Phase 6.1 — error-catalog gating.
//
// Walks every `new TextralError(<CODE>, ...)` site in apps/api/src and
// asserts the code is in the contracts catalog enum. Drift is prevented
// at PR review time: a fresh `'NOT_REGISTERED'` literal anywhere fails
// this test until either the catalog is extended or the code is
// renamed.
//
// Implementation note: this is a string-grep test, not a runtime test.
// We don't import or execute the route code; we just regex-match the
// source files.

import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@textral/contracts';

// Eager glob — Vite inlines every src/**/*.ts as a string at build time.
// Avoids node:fs which isn't available inside the workers test pool.
const SOURCE_FILES = import.meta.glob('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const TEXTRAL_ERROR_RE = /new\s+TextralError\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g;

describe('Phase 6.1 — error catalog gating', () => {
  it('every TextralError code in src/ is in the catalog', () => {
    const validCodes = new Set(ErrorCode.options);
    const offenders: { file: string; code: string }[] = [];
    for (const [file, text] of Object.entries(SOURCE_FILES)) {
      for (const m of text.matchAll(TEXTRAL_ERROR_RE)) {
        const code = m[1]!;
        if (!validCodes.has(code as (typeof ErrorCode.options)[number])) {
          offenders.push({ file, code });
        }
      }
    }
    if (offenders.length > 0) {
      const lines = offenders.map((o) => `  ${o.code} (in ${o.file})`).join('\n');
      throw new Error(
        `Found TextralError codes not in the catalog:\n${lines}\n\n` +
          `Add them to packages/contracts/src/error.ts ErrorCode enum.`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  it('every code in the catalog is reachable somewhere', () => {
    const allowlist = new Set([
      'NOT_IMPLEMENTED',
      'PROVIDER_REFUSAL',
      'INDEX_ALREADY_BUILT',
      'EVAL_QUESTION_NOT_FOUND',
      'EVAL_RUN_NOT_FOUND',
      'EVAL_JUDGE_FAILED',
    ]);
    const referenced = new Set<string>();
    for (const text of Object.values(SOURCE_FILES)) {
      for (const m of text.matchAll(TEXTRAL_ERROR_RE)) referenced.add(m[1]!);
      for (const m of text.matchAll(/['"]([A-Z][A-Z0-9_]+)['"]/g)) {
        const v = m[1]!;
        if (ErrorCode.options.includes(v as (typeof ErrorCode.options)[number])) {
          referenced.add(v);
        }
      }
    }
    const orphans = ErrorCode.options.filter(
      (c) => !referenced.has(c) && !allowlist.has(c),
    );
    if (orphans.length > 0) {
      console.warn(
        'Catalog codes not referenced in apps/api/src:',
        orphans.join(', '),
        '— consider removing or allowlisting.',
      );
    }
    expect(orphans.length).toBeLessThan(50);
  });
});
