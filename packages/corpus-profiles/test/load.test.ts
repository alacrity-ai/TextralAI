// Profile YAMLs all parse, the registry is well-formed, and a few
// representative fields land where we expect.

import { describe, expect, it } from 'vitest';
import { getProfile, getProfileOrThrow, listProfiles } from '../src/loader.js';

describe('corpus-profiles loader', () => {
  it('loads every shipped profile', () => {
    const ids = listProfiles().map((p) => p.id).sort();
    expect(ids).toEqual(['generic', 'legal', 'narrative', 'support', 'technical']);
  });

  it('returns the generic profile by id', () => {
    const p = getProfile('generic');
    expect(p).toBeDefined();
    expect(p!.enrichment.enabled).toBe(false);
    expect(p!.retrieval_defaults.rerank.enabled).toBe(false);
  });

  it('throws on unknown profile id', () => {
    expect(() => getProfileOrThrow('not-a-profile')).toThrow(/Unknown corpus profile/);
  });

  it('narrative profile has 4 enrichment passes including character_dossier', () => {
    const p = getProfileOrThrow('narrative');
    expect(p.enrichment.enabled).toBe(true);
    const ids = p.enrichment.passes.map((x) => x.id).sort();
    expect(ids).toEqual(['character_dossier', 'scene', 'section_summary', 'theme']);
    const dossier = p.enrichment.passes.find((x) => x.id === 'character_dossier')!;
    expect(dossier.scope).toBe('document');
    expect(dossier.model?.model).toBe('gpt-4o');
  });

  it('legal profile uses the clause-aware chunker', () => {
    const p = getProfileOrThrow('legal');
    expect(p.chunking.profile).toBe('legal_clause_aware');
  });

  it('rerank-enabled profiles have provider + model set', () => {
    for (const p of listProfiles()) {
      if (p.retrieval_defaults.rerank.enabled) {
        expect(p.retrieval_defaults.rerank.provider).toBeDefined();
        expect(p.retrieval_defaults.rerank.model).toBeDefined();
      }
    }
  });
});
