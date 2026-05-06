// Query request + response contracts (Phase 4).
//
// `answer` is a tagged discriminated union — never a raw string-or-object
// union — so SDK consumers and the OpenAPI spec see one stable shape.
// `audit.tokens` is an explicit breakdown.

import { z } from 'zod';

export const InferenceConfig = z.object({
  provider: z.enum(['openai', 'anthropic', 'workers_ai', 'cohere', 'voyage']),
  model: z.string().min(1),
  provider_key_ref: z.string().optional(),
  provider_key_id: z.string().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type InferenceConfig = z.infer<typeof InferenceConfig>;

export const QueryEmbeddingConfig = z.object({
  provider: z.enum(['openai', 'anthropic', 'workers_ai', 'cohere', 'voyage']),
  model: z.string().min(1),
  dimensions: z.number().int().positive().optional(),
  provider_key_ref: z.string().optional(),
  provider_key_id: z.string().optional(),
});
export type QueryEmbeddingConfig = z.infer<typeof QueryEmbeddingConfig>;

/** Per-request rerank overrides. All fields are individually optional —
 *  the request is a partial override, not a full replacement. Omitted
 *  fields inherit from the corpus profile's `retrieval_defaults.rerank`.
 *
 *  `provider` is constrained to the providers that actually expose a
 *  rerank capability in the registry (see apps/api/src/providers/registry.ts).
 *
 *  `provider_key_id` and `provider_key_ref` are mutually exclusive
 *  knobs for pinning which BYOK key the rerank call uses; if both are
 *  omitted, the resolver falls back to the profile-declared key, then
 *  to the tenant's `(provider, label='default')` key. */
export const RerankOverride = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['voyage', 'cohere']).optional(),
  model: z.string().min(1).optional(),
  top_n: z.number().int().positive().max(200).optional(),
  provider_key_ref: z.string().optional(),
  provider_key_id: z.string().optional(),
});
export type RerankOverride = z.infer<typeof RerankOverride>;

export const RetrievalConfig = z.object({
  strategy: z.enum(['hybrid_rrf']).default('hybrid_rrf'),
  top_k_dense: z.number().int().positive().default(30),
  top_k_sparse: z.number().int().positive().default(30),
  rrf_k: z.number().int().positive().default(60),
  artifact_types: z.array(z.string()).default(['passage']),
  require_citations: z.boolean().default(true),
  rerank: RerankOverride.optional(),
});
export type RetrievalConfig = z.infer<typeof RetrievalConfig>;

export const QueryChunkingConfig = z.object({
  profile: z.string().default('generic'),
});
export type QueryChunkingConfig = z.infer<typeof QueryChunkingConfig>;

export const ContextConfig = z.object({
  max_context_tokens: z.number().int().positive().default(12000),
  allow_compression: z.boolean().default(false),
});
export type ContextConfig = z.infer<typeof ContextConfig>;

export const PromptConfig = z.object({
  system: z.string().optional(),
  developer: z.string().optional(),
  template_id: z.string().optional(),
});
export type PromptConfig = z.infer<typeof PromptConfig>;

export const OutputConfig = z.union([
  z.object({ mode: z.literal('text') }),
  z.object({
    mode: z.literal('structured'),
    schema: z.record(z.string(), z.unknown()),
  }),
]);
export type OutputConfig = z.infer<typeof OutputConfig>;

export const QueryRequest = z.object({
  namespace: z.string().min(1),
  document_ids: z.array(z.string()).optional(),
  query: z.string().min(1),
  embedding: QueryEmbeddingConfig,
  inference: InferenceConfig,
  chunking: QueryChunkingConfig.default({}),
  retrieval: RetrievalConfig.default({}),
  context: ContextConfig.default({}),
  prompt: PromptConfig.default({}),
  output: OutputConfig.default({ mode: 'text' }),
});
export type QueryRequest = z.infer<typeof QueryRequest>;

// Response shapes
export const Citation = z.object({
  n: z.number().int().positive(),
  chunk_id: z.string(),
  section_path: z.string().nullable(),
  quote: z.string().optional(),
});
export type Citation = z.infer<typeof Citation>;

export const Answer = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('text'), text: z.string() }),
  z.object({
    mode: z.literal('structured'),
    object: z.unknown(),
    raw: z.string().optional(),
  }),
]);
export type Answer = z.infer<typeof Answer>;

export const RerankerFallbackReason = z.enum([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_QUOTA_EXHAUSTED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_KEY_NOT_FOUND',
  'EMPTY_INPUT',
]);
export type RerankerFallbackReason = z.infer<typeof RerankerFallbackReason>;

/** Reasons that suggest operator action (vs transient blips). The
 *  audit emits `actionable: true` for these so dashboards can surface
 *  them distinctly without parsing the reason string. */
export const ACTIONABLE_FALLBACK_REASONS: ReadonlySet<RerankerFallbackReason> = new Set([
  'PROVIDER_QUOTA_EXHAUSTED',
  'PROVIDER_KEY_NOT_FOUND',
]);

export const RerankerAudit = z.object({
  enabled: z.boolean(),
  /** Whether the rerank actually ran. `enabled && !executed` ⇒
   *  fallback was used; `fallback_reason` is set. */
  executed: z.boolean(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  top_n: z.number().int().nullable().optional(),
  latency_ms: z.number().int().nullable().optional(),
  fallback_reason: RerankerFallbackReason.nullable().optional(),
  /** True when fallback_reason represents a state an operator should
   *  act on (out of quota, missing key) vs a transient blip (timeout,
   *  5xx). Always present when `executed: false`. */
  actionable: z.boolean().nullable().optional(),
});
export type RerankerAudit = z.infer<typeof RerankerAudit>;

export const TokenBreakdown = z.object({
  embedding_input: z.number().int(),
  synthesis_input: z.number().int(),
  synthesis_output: z.number().int(),
  context: z.number().int(),
});
export type TokenBreakdown = z.infer<typeof TokenBreakdown>;

export const QueryAudit = z.object({
  embedding_profile: z.string(),
  chunking_profile: z.string(),
  inference_provider: z.string(),
  inference_model: z.string(),
  provider_key_id: z.string().nullable(),
  retrieval_strategy: z.string(),
  retrieval_status: z.enum(['full', 'dense_only', 'sparse_only', 'empty']),
  dense_candidates_returned: z.number().int(),
  sparse_candidates_returned: z.number().int(),
  embedding_missing_count: z.number().int(),
  candidates_returned: z.number().int(),
  reranker: RerankerAudit,
  citation_integrity: z.enum(['valid', 'invalid_removed', 'missing']).nullable(),
  synthesis_status: z.enum(['success', 'truncated', 'failed']).nullable(),
  dropped_citations: z.array(z.number().int()),
  tokens: TokenBreakdown,
  total_cost_usd_micros: z.number().int().nullable(),
  latency_ms: z.number().int(),
});
export type QueryAudit = z.infer<typeof QueryAudit>;

export const DegradationLevel = z.enum(['full', 'no_citations', 'partial', 'cannot_answer']);
export type DegradationLevel = z.infer<typeof DegradationLevel>;

export const QueryResponse = z.object({
  query_event_id: z.string(),
  answer: Answer,
  citations: z.array(Citation),
  degradation_level: DegradationLevel,
  audit: QueryAudit,
});
export type QueryResponse = z.infer<typeof QueryResponse>;

export const QueryEvent = z.object({
  id: z.string(),
  tenant_id: z.string(),
  namespace_id: z.string(),
  status: z.enum([
    'received',
    'retrieval_started',
    'retrieval_completed',
    'synthesis_started',
    'completed',
    'failed',
  ]),
  query_text: z.string(),
  request_config: z.record(z.string(), z.unknown()),
  degradation_level: DegradationLevel.nullable(),
  retrieval_status: z.string().nullable(),
  citation_integrity: z.string().nullable(),
  synthesis_status: z.string().nullable(),
  candidates_returned: z.number().int().nullable(),
  citations_returned: z.number().int().nullable(),
  dropped_citations: z.array(z.number().int()).nullable(),
  latency_ms: z.number().int().nullable(),
  answer_r2_key: z.string().nullable(),
  mirror_error: z.string().nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.number().int(),
  completed_at: z.number().int().nullable(),
});
export type QueryEvent = z.infer<typeof QueryEvent>;
