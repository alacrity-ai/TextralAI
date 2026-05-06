// Deep merge: scalars and objects from `override` win; arrays
// replace wholesale (no concatenation). Mirrors the Python impl
// (apps/ingest/app/corpus_profiles/merge.py).
//
// IMPORTANT footgun: if `override.enrichment.passes` is supplied, it
// REPLACES the profile's pass list entirely. A request that wants to
// disable one pass must respecify the complete remaining pass list.

import type { CorpusProfile } from './schema.js';

export type CorpusProfileOverride = {
  chunking?: Partial<CorpusProfile['chunking']> | undefined;
  enrichment?: {
    enabled?: boolean;
    default_model?: CorpusProfile['enrichment']['default_model'];
    passes?: CorpusProfile['enrichment']['passes'];
  };
  retrieval_defaults?: {
    strategy?: CorpusProfile['retrieval_defaults']['strategy'];
    artifact_types?: CorpusProfile['retrieval_defaults']['artifact_types'];
    rerank?: Partial<CorpusProfile['retrieval_defaults']['rerank']>;
    layer_budgets?: Record<string, number>;
    layer_order?: string[];
  };
  prompt_defaults?: Partial<CorpusProfile['prompt_defaults']>;
};

export function mergeProfile(
  base: CorpusProfile,
  override: CorpusProfileOverride | undefined,
): CorpusProfile {
  if (!override) return base;
  return {
    ...base,
    chunking: { ...base.chunking, ...(override.chunking ?? {}) },
    enrichment: {
      ...base.enrichment,
      ...(override.enrichment ?? {}),
      passes: override.enrichment?.passes ?? base.enrichment.passes,
    },
    retrieval_defaults: {
      ...base.retrieval_defaults,
      ...(override.retrieval_defaults ?? {}),
      rerank: {
        ...base.retrieval_defaults.rerank,
        ...(override.retrieval_defaults?.rerank ?? {}),
      },
      layer_budgets: {
        ...base.retrieval_defaults.layer_budgets,
        ...(override.retrieval_defaults?.layer_budgets ?? {}),
      },
      layer_order:
        override.retrieval_defaults?.layer_order ?? base.retrieval_defaults.layer_order,
      artifact_types:
        override.retrieval_defaults?.artifact_types ?? base.retrieval_defaults.artifact_types,
    },
    prompt_defaults: { ...base.prompt_defaults, ...(override.prompt_defaults ?? {}) },
  };
}
