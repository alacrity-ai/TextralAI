// Override semantics for mergeProfile.
//
// The big rule: arrays REPLACE wholesale. The small rules: scalars
// and objects deep-merge.

import { describe, expect, it } from 'vitest';
import { getProfileOrThrow } from '../src/loader.js';
import { mergeProfile } from '../src/merge.js';

describe('mergeProfile', () => {
  it('overriding a scalar in chunking preserves the rest', () => {
    const base = getProfileOrThrow('narrative');
    const merged = mergeProfile(base, { chunking: { target_tokens: 999 } });
    expect(merged.chunking.target_tokens).toBe(999);
    expect(merged.chunking.overlap_tokens).toBe(base.chunking.overlap_tokens);
    expect(merged.chunking.boundary_depth).toBe(base.chunking.boundary_depth);
  });

  it('overriding rerank.enabled preserves provider and model', () => {
    const base = getProfileOrThrow('narrative');
    const merged = mergeProfile(base, {
      retrieval_defaults: { rerank: { enabled: false } },
    });
    expect(merged.retrieval_defaults.rerank.enabled).toBe(false);
    expect(merged.retrieval_defaults.rerank.provider).toBe(
      base.retrieval_defaults.rerank.provider,
    );
    expect(merged.retrieval_defaults.rerank.model).toBe(base.retrieval_defaults.rerank.model);
  });

  it('overriding enrichment.passes replaces the array (footgun documented)', () => {
    const base = getProfileOrThrow('narrative');
    const merged = mergeProfile(base, {
      enrichment: { passes: [] },
    });
    expect(merged.enrichment.passes.length).toBe(0);
    expect(base.enrichment.passes.length).toBe(4);
  });

  it('layer_budgets merge by key', () => {
    const base = getProfileOrThrow('narrative');
    const merged = mergeProfile(base, {
      retrieval_defaults: { layer_budgets: { passage: 0.9 } },
    });
    expect(merged.retrieval_defaults.layer_budgets.passage).toBe(0.9);
    expect(merged.retrieval_defaults.layer_budgets['narrative.section_summary']).toBe(
      base.retrieval_defaults.layer_budgets['narrative.section_summary'],
    );
  });

  it('artifact_types replace wholesale when overridden', () => {
    const base = getProfileOrThrow('narrative');
    const merged = mergeProfile(base, {
      retrieval_defaults: { artifact_types: ['passage'] },
    });
    expect(merged.retrieval_defaults.artifact_types).toEqual(['passage']);
  });

  it('undefined override returns the base unchanged', () => {
    const base = getProfileOrThrow('legal');
    expect(mergeProfile(base, undefined)).toBe(base);
  });
});
