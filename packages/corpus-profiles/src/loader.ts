// Profile registry loader.
//
// Reads the precompiled `_generated.ts` (regenerated from
// ../profiles/*.yaml via `pnpm gen`). The Worker runtime (workerd)
// doesn't expose `readdirSync`, so we can't read YAMLs directly at
// runtime. The Container has its own Python loader that reads YAMLs
// natively; the parity test ensures the two paths agree.

import { CorpusProfile } from './schema.js';
import { GENERATED_PROFILES } from './_generated.js';

function loadAll(): Map<string, CorpusProfile> {
  const out = new Map<string, CorpusProfile>();
  for (const [id, raw] of Object.entries(GENERATED_PROFILES)) {
    let parsed: CorpusProfile;
    try {
      parsed = CorpusProfile.parse(raw);
    } catch (e) {
      throw new Error(`Invalid corpus profile ${id}: ${(e as Error).message}`);
    }
    if (parsed.id !== id) {
      throw new Error(`Profile filename id ${id} mismatches body id ${parsed.id}`);
    }
    out.set(parsed.id, parsed);
  }
  if (!out.has('generic')) {
    throw new Error('Missing required profile: generic');
  }
  return out;
}

const REGISTRY: ReadonlyMap<string, CorpusProfile> = loadAll();

export function getProfile(id: string): CorpusProfile | undefined {
  return REGISTRY.get(id);
}

export function listProfiles(): CorpusProfile[] {
  return Array.from(REGISTRY.values());
}

export function getProfileOrThrow(id: string): CorpusProfile {
  const p = REGISTRY.get(id);
  if (!p) {
    const known = Array.from(REGISTRY.keys()).sort().join(', ');
    throw new Error(`Unknown corpus profile: ${id}. Known: ${known}`);
  }
  return p;
}
