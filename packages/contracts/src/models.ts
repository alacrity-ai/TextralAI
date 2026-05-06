// Curated model registry — schema and data.
//
// `KNOWN_MODELS` is a hand-maintained list of models we've validated
// work end-to-end with Textral's provider adapters. It serves the
// `GET /v1/models` endpoint, the MCP `list_models` tool, and the
// sandbox dropdown — single source of truth so all three stay aligned.
//
// **The registry will go stale.** Mitigations:
//   1. The custom-model escape hatch in the sandbox keeps users
//      unblocked when a new model isn't yet listed.
//   2. The list is one PR away from being updated — entries are
//      additive and deprecation is a flag, not a delete.
//   3. Free-text fallback at the `embedding_model`, `inference_model`,
//      `rerank_model` schema layer is preserved (`z.string().min(1)`).

import { z } from 'zod';
import { ProviderName } from './provider-key.js';

export const ModelKind = z.enum(['embedding', 'inference', 'rerank']);
export type ModelKind = z.infer<typeof ModelKind>;

export const ModelFamily = z.enum([
  'openai_chat',
  'openai_reasoning',
  'openai_embedding',
  'anthropic_messages',
  'voyage_rerank',
  'cohere_rerank',
  'workers_ai_chat',
  'workers_ai_embedding',
]);
export type ModelFamily = z.infer<typeof ModelFamily>;

export const KnownModel = z.object({
  id: z.string().describe('Wire-format model ID, exactly as the provider expects.'),
  provider: ProviderName,
  kind: ModelKind,
  family: ModelFamily,
  /** Native (or recommended-default) embedding dimension. */
  dimensions: z.number().int().positive().optional(),
  /** Embedding-only: dimensions the API will return when explicitly
   *  requested via `dimensions=N` (Matryoshka). Includes `dimensions`
   *  itself if both fields are set. */
  supported_dimensions: z.array(z.number().int().positive()).optional(),
  tier: z.enum(['flagship', 'standard', 'mini', 'lite']).optional(),
  deprecated: z.boolean().optional(),
  notes: z.string().optional(),
});
export type KnownModel = z.infer<typeof KnownModel>;

export const KnownModelList = z.object({
  data: z.array(KnownModel),
});
export type KnownModelList = z.infer<typeof KnownModelList>;

export const ListModelsQuery = z.object({
  provider: ProviderName.optional(),
  kind: ModelKind.optional(),
  include_deprecated: z.boolean().optional(),
});
export type ListModelsQuery = z.infer<typeof ListModelsQuery>;

/** The curated list. Order is presentation order — flagship first, then
 *  standard, then mini/lite. */
export const KNOWN_MODELS: readonly KnownModel[] = [
  // ── OpenAI inference ────────────────────────────────────────────────
  {
    id: 'gpt-5.5',
    provider: 'openai',
    kind: 'inference',
    family: 'openai_reasoning',
    tier: 'flagship',
    notes: 'Reasoning model. Temperature locked to 1; uses max_completion_tokens.',
  },
  {
    id: 'gpt-5.4',
    provider: 'openai',
    kind: 'inference',
    family: 'openai_reasoning',
    tier: 'standard',
    notes: 'Reasoning model. Temperature locked to 1; uses max_completion_tokens.',
  },
  {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    kind: 'inference',
    family: 'openai_reasoning',
    tier: 'mini',
    notes: 'Reasoning model. Temperature locked to 1; uses max_completion_tokens.',
  },
  {
    id: 'gpt-5',
    provider: 'openai',
    kind: 'inference',
    family: 'openai_reasoning',
    tier: 'flagship',
    notes: 'Reasoning model. Temperature locked to 1; uses max_completion_tokens.',
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    kind: 'inference',
    family: 'openai_reasoning',
    tier: 'mini',
    notes: 'Reasoning model. Temperature locked to 1; uses max_completion_tokens.',
  },
  {
    id: 'o1',
    provider: 'openai',
    kind: 'inference',
    family: 'openai_reasoning',
    tier: 'flagship',
    notes: 'Reasoning model.',
  },
  {
    id: 'o1-mini',
    provider: 'openai',
    kind: 'inference',
    family: 'openai_reasoning',
    tier: 'mini',
    notes: 'Reasoning model.',
  },
  {
    id: 'o3-mini',
    provider: 'openai',
    kind: 'inference',
    family: 'openai_reasoning',
    tier: 'mini',
    notes: 'Reasoning model.',
  },
  {
    id: 'o4-mini',
    provider: 'openai',
    kind: 'inference',
    family: 'openai_reasoning',
    tier: 'mini',
    notes: 'Reasoning model.',
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    kind: 'inference',
    family: 'openai_chat',
    tier: 'flagship',
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    kind: 'inference',
    family: 'openai_chat',
    tier: 'mini',
  },

  // ── OpenAI embeddings ───────────────────────────────────────────────
  {
    id: 'text-embedding-3-large',
    provider: 'openai',
    kind: 'embedding',
    family: 'openai_embedding',
    dimensions: 3072,
    supported_dimensions: [256, 768, 1024, 1536, 3072],
    tier: 'flagship',
    notes: 'Matryoshka — pass `dimensions` to truncate.',
  },
  {
    id: 'text-embedding-3-small',
    provider: 'openai',
    kind: 'embedding',
    family: 'openai_embedding',
    dimensions: 1536,
    supported_dimensions: [512, 1536],
    tier: 'standard',
    notes: 'Matryoshka — pass `dimensions` to truncate.',
  },
  {
    id: 'text-embedding-ada-002',
    provider: 'openai',
    kind: 'embedding',
    family: 'openai_embedding',
    dimensions: 1536,
    deprecated: true,
    notes: 'Superseded by text-embedding-3-*.',
  },

  // ── Anthropic inference ─────────────────────────────────────────────
  {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    kind: 'inference',
    family: 'anthropic_messages',
    tier: 'flagship',
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    kind: 'inference',
    family: 'anthropic_messages',
    tier: 'standard',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    kind: 'inference',
    family: 'anthropic_messages',
    tier: 'mini',
  },

  // ── Voyage rerank ───────────────────────────────────────────────────
  {
    id: 'rerank-2.5',
    provider: 'voyage',
    kind: 'rerank',
    family: 'voyage_rerank',
    tier: 'flagship',
  },
  {
    id: 'rerank-2.5-lite',
    provider: 'voyage',
    kind: 'rerank',
    family: 'voyage_rerank',
    tier: 'lite',
  },
  {
    id: 'rerank-2',
    provider: 'voyage',
    kind: 'rerank',
    family: 'voyage_rerank',
    tier: 'standard',
  },
  {
    id: 'rerank-2-lite',
    provider: 'voyage',
    kind: 'rerank',
    family: 'voyage_rerank',
    tier: 'lite',
  },

  // ── Cohere rerank ───────────────────────────────────────────────────
  {
    id: 'rerank-english-v3.0',
    provider: 'cohere',
    kind: 'rerank',
    family: 'cohere_rerank',
    tier: 'standard',
  },
  {
    id: 'rerank-multilingual-v3.0',
    provider: 'cohere',
    kind: 'rerank',
    family: 'cohere_rerank',
    tier: 'standard',
  },

  // ── Workers AI ──────────────────────────────────────────────────────
  {
    id: '@cf/baai/bge-large-en-v1.5',
    provider: 'workers_ai',
    kind: 'embedding',
    family: 'workers_ai_embedding',
    dimensions: 1024,
  },
  {
    id: '@cf/baai/bge-base-en-v1.5',
    provider: 'workers_ai',
    kind: 'embedding',
    family: 'workers_ai_embedding',
    dimensions: 768,
  },
];

/** Filter the registry by optional provider/kind, defaulting to hide
 *  deprecated entries. Pure — usable from both API and MCP. */
export function filterModels(opts: ListModelsQuery): KnownModel[] {
  const includeDeprecated = opts.include_deprecated === true;
  return KNOWN_MODELS.filter((m) => {
    if (opts.provider && m.provider !== opts.provider) return false;
    if (opts.kind && m.kind !== opts.kind) return false;
    if (!includeDeprecated && m.deprecated === true) return false;
    return true;
  });
}
