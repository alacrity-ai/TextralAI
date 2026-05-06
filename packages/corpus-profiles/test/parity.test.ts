// Cross-runtime parity dump. Writes:
//   - test/_canonical.json — full validated profiles
//   - test/_merge_canonical.json — `mergeProfile(base, override)` outputs
//     for a representative override matrix
// Both files are read by the Python parity test. Any divergence between
// Zod / Pydantic on validation OR between mergeProfile / merge_profile
// shows up here as a diff.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getProfile, listProfiles } from '../src/loader.js';
import { mergeProfile, type CorpusProfileOverride } from '../src/merge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '_canonical.json');
const MERGE_OUT = join(__dirname, '_merge_canonical.json');

function canonical(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of listProfiles().slice().sort((a, b) => a.id.localeCompare(b.id))) {
    out[p.id] = p as unknown;
  }
  return out;
}

// Override matrix. Each entry exercises a different merge codepath.
// Keep these in sync with apps/ingest/tests/test_profile_parity.py.
//
// Schema:
//   { id, base, override } — the Python side reads `id`, looks up
//   `base` from the loader, and applies `override` via merge_profile.
const MERGE_MATRIX: Array<{
  id: string;
  base: string;
  override: CorpusProfileOverride;
}> = [
  {
    id: 'generic_no_override',
    base: 'generic',
    override: {},
  },
  {
    id: 'generic_chunking_target_bump',
    base: 'generic',
    override: { chunking: { target_tokens: 1200 } },
  },
  {
    id: 'narrative_disable_enrichment',
    base: 'narrative',
    override: { enrichment: { enabled: false } },
  },
  {
    id: 'narrative_replace_passes_with_empty',
    base: 'narrative',
    override: { enrichment: { passes: [] } },
  },
  {
    id: 'generic_rerank_on_top_n_5',
    base: 'generic',
    override: {
      retrieval_defaults: {
        rerank: { enabled: true, provider: 'voyage', model: 'rerank-2', top_n: 5 },
      },
    },
  },
  {
    id: 'generic_artifact_types_extended',
    base: 'generic',
    override: {
      retrieval_defaults: { artifact_types: ['passage', 'narrative.section_summary'] },
    },
  },
  {
    id: 'legal_layer_budgets_partial_merge',
    base: 'legal',
    override: { retrieval_defaults: { layer_budgets: { 'legal.clause': 2.0 } } },
  },
  {
    id: 'generic_prompt_defaults_system_replace',
    base: 'generic',
    override: { prompt_defaults: { system: 'Custom system prompt for tests.' } },
  },
];

function mergeCanonical(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of MERGE_MATRIX) {
    const base = getProfile(entry.base);
    if (!base) throw new Error(`merge matrix references unknown profile: ${entry.base}`);
    out[entry.id] = mergeProfile(base, entry.override) as unknown;
  }
  return out;
}

describe('parity', () => {
  it('writes canonical JSON for the Python parity test to consume', () => {
    const data = canonical();
    writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8');
    expect(Object.keys(data)).toContain('generic');
    expect(Object.keys(data)).toContain('narrative');
  });

  it('writes mergeProfile canonical JSON', () => {
    const data = mergeCanonical();
    writeFileSync(MERGE_OUT, JSON.stringify(data, null, 2) + '\n', 'utf8');
    expect(Object.keys(data)).toContain('generic_no_override');
    expect(Object.keys(data).length).toBeGreaterThanOrEqual(MERGE_MATRIX.length);
  });
});
