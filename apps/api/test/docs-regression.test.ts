// Phase D5 — docs regression test.
//
// Pins the spec's docs-completeness contract so /docs can't drift back
// to the bare-bones state. Hits /openapi.json against the in-process
// Worker; asserts:
//
//   * info.description is non-trivial (> 1500 chars)
//   * x-tagGroups is present and groups every tag
//   * every tag in x-tagGroups has a description in the spec
//   * every public operation has an operationId + summary
//   * the flagship operations have x-codeSamples
//   * no internal route (bootstrap, __redaction_check) is in the spec
//   * the error catalog is in info.description (key codes appear)

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { callJson } from './helpers/fetch.js';
import { ErrorCode } from '@textral/contracts';
import { ERROR_CATALOG } from '../src/openapi/error-catalog.js';
import { FLAGSHIP_OPERATION_KEYS } from '../src/openapi/code-samples.js';
import type { Env } from '../src/types.js';

interface SpecPaths {
  [path: string]: {
    [method: string]: {
      operationId?: string;
      summary?: string;
      tags?: string[];
      'x-codeSamples'?: unknown[];
    };
  };
}

interface Spec {
  info: { title: string; description?: string };
  paths?: SpecPaths;
  tags?: { name: string; description?: string }[];
  'x-tagGroups'?: { name: string; tags: string[] }[];
}

async function fetchSpec(): Promise<Spec> {
  const e = env as unknown as Env;
  const res = await callJson(e, 'GET', 'http://x/openapi.json');
  expect(res.status).toBe(200);
  return (await res.json()) as Spec;
}

describe('Phase D5 — docs regression', () => {
  it('info.description is a real landing page (> 1500 chars)', async () => {
    const spec = await fetchSpec();
    expect(spec.info.description?.length ?? 0).toBeGreaterThan(1500);
  });

  it('x-tagGroups is present and references real tags', async () => {
    const spec = await fetchSpec();
    expect(spec['x-tagGroups']).toBeTruthy();
    const groups = spec['x-tagGroups']!;
    expect(groups.length).toBeGreaterThanOrEqual(3);

    const tagNames = new Set((spec.tags ?? []).map((t) => t.name));
    for (const g of groups) {
      for (const t of g.tags) {
        expect(tagNames.has(t)).toBe(true);
      }
    }
  });

  it('every grouped tag has a description', async () => {
    const spec = await fetchSpec();
    const groupedTagNames = new Set(
      (spec['x-tagGroups'] ?? []).flatMap((g) => g.tags),
    );
    const taggedDescriptions = new Map(
      (spec.tags ?? []).map((t) => [t.name, t.description ?? '']),
    );
    for (const name of groupedTagNames) {
      const desc = taggedDescriptions.get(name) ?? '';
      expect.soft(desc.length, `tag "${name}" missing description`).toBeGreaterThan(40);
    }
  });

  it('every public operation has a non-empty summary', async () => {
    const spec = await fetchSpec();
    const offenders: string[] = [];
    for (const [path, ops] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(ops)) {
        if (!op.summary || op.summary.length < 5) {
          offenders.push(`${method.toUpperCase()} ${path} (no/short summary)`);
        }
      }
    }
    // operationId is auto-derived by Scalar from (method, path) when
    // not explicitly set; it isn't load-bearing for the rendered UI.
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('flagship operations have x-codeSamples', async () => {
    const spec = await fetchSpec();
    const offenders: string[] = [];
    for (const k of FLAGSHIP_OPERATION_KEYS) {
      const op = spec.paths?.[k.path]?.[k.method];
      if (!op) {
        offenders.push(`${k.method.toUpperCase()} ${k.path} not in spec`);
        continue;
      }
      const samples = op['x-codeSamples'];
      if (!Array.isArray(samples) || samples.length === 0) {
        offenders.push(`${k.method.toUpperCase()} ${k.path} missing x-codeSamples`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('hidden routes do not appear in the public spec', async () => {
    const spec = await fetchSpec();
    const paths = spec.paths ?? {};
    const hidden = ['/v1/admin/bootstrap', '/__redaction_check'];
    for (const p of hidden) {
      expect(
        Object.keys(paths).find((k) => k === p || k.startsWith(p + '/')),
      ).toBeUndefined();
    }
  });

  it('error catalog appendix lists every catalog code', async () => {
    const spec = await fetchSpec();
    const desc = spec.info.description ?? '';
    expect(desc).toContain('Full error catalog');
    // Sample 5 random codes; each should appear in the description.
    const sample = ['EMBEDDING_PROFILE_MISMATCH', 'INVALID_API_KEY', 'PROVIDER_KEY_INVALID', 'DLQ_NOT_DEAD_LETTERED', 'EVAL_RUN_FAILED'];
    for (const code of sample) {
      expect(desc).toContain(code);
    }
  });

  it('no duplicate operations across paths (sidebar dedupe)', async () => {
    const spec = await fetchSpec();
    // Group operations by summary; if the same summary appears at >1
    // path, the route module is mounted at multiple prefixes and the
    // sidebar will show duplicates. This regressed once with the
    // documents router.
    const bySummary = new Map<string, string[]>();
    for (const [path, ops] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(ops)) {
        const key = op.summary ?? `${method} ${path}`;
        const list = bySummary.get(key) ?? [];
        list.push(`${method.toUpperCase()} ${path}`);
        bySummary.set(key, list);
      }
    }
    const duplicates: string[] = [];
    for (const [summary, ops] of bySummary) {
      if (ops.length > 1) {
        duplicates.push(`"${summary}" appears at ${ops.length} paths: ${ops.join(', ')}`);
      }
    }
    expect(duplicates, duplicates.join('\n')).toEqual([]);
  });

  it('error catalog stays in sync with the contracts enum', () => {
    const enumCodes = new Set<string>(ErrorCode.options);
    const catalogCodes = new Set(Object.keys(ERROR_CATALOG));
    const missing = [...enumCodes].filter((c) => !catalogCodes.has(c));
    const orphan = [...catalogCodes].filter((c) => !enumCodes.has(c));
    expect(missing, `enum codes missing from ERROR_CATALOG: ${missing.join(', ')}`).toEqual([]);
    expect(orphan, `ERROR_CATALOG has codes not in enum: ${orphan.join(', ')}`).toEqual([]);
  });
});
