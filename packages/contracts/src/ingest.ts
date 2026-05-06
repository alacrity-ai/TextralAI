// Ingestion contracts.
//
// IngestRequest mirrors `1-DESIGN.md` §6.7 — the full ingestion config
// the public API accepts. `provider_key_ref` is a label for ergonomics;
// dispatch resolves it to a `provider_key_id` and persists the ID in
// config_json so replays are unambiguous.

import { z } from 'zod';
import { ProviderName } from './provider-key.js';

export const EmbeddingConfig = z.object({
  provider: ProviderName,
  model: z.string().min(1),
  /** Provider-specific dimension override. OpenAI text-embedding-3-large
   *  defaults to 3072; we always pass `dimensions: 1536` to fit the
   *  Vectorize V2 cap. Required when the embedding profile declares a
   *  dimension override. */
  dimensions: z.number().int().positive().optional(),
  /** Either provider_key_ref (a label) or provider_key_id may be supplied;
   *  dispatch resolves the label to an ID. */
  provider_key_ref: z.string().optional(),
  provider_key_id: z.string().optional(),
});
export type EmbeddingConfig = z.infer<typeof EmbeddingConfig>;

export const ChunkingConfig = z.object({
  profile: z.string().default('generic'),
  target_tokens: z.number().int().positive().default(600),
  overlap_tokens: z.number().int().nonnegative().default(80),
  boundary_depth: z.number().int().nonnegative().default(2),
});
export type ChunkingConfig = z.infer<typeof ChunkingConfig>;

export const InferenceModelConfig = z.object({
  provider: ProviderName,
  model: z.string().min(1),
  provider_key_ref: z.string().optional(),
  provider_key_id: z.string().optional(),
});
export type InferenceModelConfig = z.infer<typeof InferenceModelConfig>;

export const EnrichmentPass = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  required: z.boolean().default(false),
  model: InferenceModelConfig.optional(),
});
export type EnrichmentPass = z.infer<typeof EnrichmentPass>;

export const EnrichmentConfig = z.object({
  enabled: z.boolean().default(false),
  default_model: InferenceModelConfig.optional(),
  passes: z.array(EnrichmentPass).default([]),
});
export type EnrichmentConfig = z.infer<typeof EnrichmentConfig>;

export const IndexingConfig = z.object({
  replace_existing_vectors: z.boolean().default(false),
  artifact_types: z.array(z.string()).default(['passage']),
});
export type IndexingConfig = z.infer<typeof IndexingConfig>;

export const IngestRequest = z.object({
  version_id: z.string().optional(),
  doc_type: z.string().optional(),
  embedding: EmbeddingConfig,
  chunking: ChunkingConfig.default({}),
  enrichment: EnrichmentConfig.default({}),
  indexing: IndexingConfig.default({}),
  mode: z.enum(['full', 'embed_only', 'enrichment_only']).default('full'),
  force_rebuild: z.boolean().default(false),
});
export type IngestRequest = z.infer<typeof IngestRequest>;

export const UploadCreate = z.object({
  content_type: z.string().min(1),
  size_bytes: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
});
export type UploadCreate = z.infer<typeof UploadCreate>;

export const UploadResponse = z.object({
  upload_id: z.string(),
  url: z.string().url(),
  key: z.string(),
  expires_at: z.number().int(),
});
export type UploadResponse = z.infer<typeof UploadResponse>;

export const FinalizeResponse = z.object({
  version_id: z.string(),
  content_hash: z.string(),
  source_r2_key: z.string(),
  size_bytes: z.number().int(),
  content_type: z.string(),
  deduplicated: z.boolean(),
});
export type FinalizeResponse = z.infer<typeof FinalizeResponse>;

export const DocumentCreate = z.object({
  title: z.string().optional(),
  doc_type: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type DocumentCreate = z.infer<typeof DocumentCreate>;

export const Document = z.object({
  id: z.string(),
  tenant_id: z.string(),
  namespace_id: z.string(),
  title: z.string().nullable(),
  doc_type: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  current_version_id: z.string().nullable(),
  created_at: z.number().int(),
});
export type Document = z.infer<typeof Document>;

export const IngestionJob = z.object({
  id: z.string(),
  tenant_id: z.string(),
  document_id: z.string(),
  version_id: z.string(),
  version_index_id: z.string(),
  mode: z.enum(['full', 'embed_only', 'enrichment_only']),
  status: z.enum(['pending', 'running', 'retrying', 'completed', 'failed']),
  current_stage: z.string().nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  attempt_count: z.number().int(),
  created_at: z.number().int(),
  completed_at: z.number().int().nullable(),
});
export type IngestionJob = z.infer<typeof IngestionJob>;

export const StageAttempt = z.object({
  job_id: z.string(),
  stage: z.string(),
  attempt: z.number().int(),
  status: z.enum(['started', 'completed', 'failed', 'skipped']),
  started_at: z.number().int(),
  completed_at: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
});
export type StageAttempt = z.infer<typeof StageAttempt>;

export const IngestionOutcome = z.enum(['full_success', 'partial_ingestion', 'fatal_failure']);
export type IngestionOutcome = z.infer<typeof IngestionOutcome>;
