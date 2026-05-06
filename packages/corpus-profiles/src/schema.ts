// Zod schema for corpus profiles.
//
// !! MIRRORED in apps/ingest/app/corpus_profiles/schema.py — any
// change here MUST land in the Pydantic mirror in the same PR.
// The parity test enforces it; the convention is documented in
// ../README.md.
//
// One source of truth for the YAMLs in ../profiles.

import { z } from 'zod';

/** The chunker IDs the Container's stages/chunk.py dispatch knows
 *  about. A typo in a profile YAML crashes the Worker at boot rather
 *  than silently falling back to `generic`. */
export const ChunkerId = z.enum(['generic', 'code_aware', 'legal_clause_aware']);
export type ChunkerId = z.infer<typeof ChunkerId>;

export const ChunkingProfileConfig = z.object({
  profile: ChunkerId.default('generic'),
  target_tokens: z.number().int().positive().default(600),
  overlap_tokens: z.number().int().nonnegative().default(80),
  boundary_depth: z.number().int().nonnegative().default(2),
});
export type ChunkingProfileConfig = z.infer<typeof ChunkingProfileConfig>;

export const InferenceModelRef = z.object({
  provider: z.enum(['openai', 'anthropic', 'workers_ai', 'cohere', 'voyage']),
  model: z.string().min(1),
  provider_key_ref: z.string().optional(),
});
export type InferenceModelRef = z.infer<typeof InferenceModelRef>;

/** pass id: snake_case, no dot. Distinguished from the dotted
 *  artifact_type form so the two namespaces never collide. */
export const PassId = z.string().regex(
  /^[a-z][a-z0-9_]*$/,
  'pass id must be snake_case, no dot',
);

export const EnrichmentPassDef = z
  .object({
    id: PassId,
    scope: z.enum(['chunk', 'section', 'document']),
    required: z.boolean().default(false),
    depends_on: z.array(PassId).default([]),
    /** Per-pass model override; falls through to profile default. */
    model: InferenceModelRef.optional(),
    /** Vendor namespace prefix the pass writes under, e.g. 'narrative'. */
    artifact_namespace: z.string().min(1),
    /** Concrete artifact_type values this pass produces. Each must
     *  start with `${artifact_namespace}.` (enforced in superRefine). */
    produces: z.array(z.string().min(1)).min(1),
    /** Max input tokens the pass may consume in one invocation.
     *  Document-scope passes use this to cap full-document blowups. */
    max_input_tokens: z.number().int().positive().default(100_000),
    /** What happens when input tokens exceed max_input_tokens.
     *  - 'map_reduce' (default): the pass implements partial+combine
     *  - 'truncate': head-N tokens, ingest_stage_attempts.metadata
     *    records truncated_input=true
     *  - 'fail': raise INPUT_TOO_LARGE_FOR_PASS (fatal if required) */
    oversize_strategy: z.enum(['map_reduce', 'truncate', 'fail']).default('map_reduce'),
  })
  .superRefine((p, ctx) => {
    for (const at of p.produces) {
      if (!at.startsWith(`${p.artifact_namespace}.`)) {
        ctx.addIssue({
          code: 'custom',
          message: `produces[${at}] must start with ${p.artifact_namespace}.`,
        });
      }
    }
  });
export type EnrichmentPassDef = z.infer<typeof EnrichmentPassDef>;

export const RerankConfig = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(['voyage', 'cohere']).optional(),
    model: z.string().optional(),
    top_n: z.number().int().positive().default(12),
    provider_key_ref: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.enabled) {
      if (!cfg.provider) {
        ctx.addIssue({ code: 'custom', message: 'rerank.provider is required when enabled' });
      }
      if (!cfg.model) {
        ctx.addIssue({ code: 'custom', message: 'rerank.model is required when enabled' });
      }
    }
  });
export type RerankConfig = z.infer<typeof RerankConfig>;

export const RetrievalDefaults = z.object({
  strategy: z.literal('hybrid_rrf').default('hybrid_rrf'),
  artifact_types: z.array(z.string()).min(1),
  rerank: RerankConfig,
  layer_budgets: z.record(z.string(), z.number().min(0).max(1)).default({}),
  layer_order: z.array(z.string()).default([]),
});
export type RetrievalDefaults = z.infer<typeof RetrievalDefaults>;

export const PromptDefaults = z
  .object({
    system: z.string().optional(),
    developer: z.string().optional(),
  })
  .default({});
export type PromptDefaults = z.infer<typeof PromptDefaults>;

export const EnrichmentSection = z.object({
  enabled: z.boolean().default(false),
  default_model: InferenceModelRef.optional(),
  passes: z.array(EnrichmentPassDef).default([]),
});
export type EnrichmentSection = z.infer<typeof EnrichmentSection>;

export const CorpusProfile = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  chunking: ChunkingProfileConfig,
  enrichment: EnrichmentSection,
  retrieval_defaults: RetrievalDefaults,
  prompt_defaults: PromptDefaults,
});
export type CorpusProfile = z.infer<typeof CorpusProfile>;
