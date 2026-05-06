// Hand-typed contract subset for M1. Replaced by openapi-typescript output
// in Step 18 (`openapi.d.ts`); the names below match the generated module's
// re-exports so the swap is mechanical.

export type ProviderName = 'openai' | 'anthropic' | 'cohere' | 'voyage' | 'workers_ai';

export interface Tenant {
  id: string;
  display_name: string;
  plan: string;
  created_at: number;
}

export interface MeResponse {
  tenant: Tenant;
  api_key_id: string;
  // Step 23.2 backend follow-up — `runtime` field hints to the FE which
  // namespace defaults to use ('vectorize' on cf, 'qdrant' on node).
  runtime?: 'cf' | 'node';
}

export type VectorBackend = 'vectorize' | 'qdrant' | 'pinecone';

export interface Namespace {
  id: string;
  tenant_id: string;
  slug: string;
  corpus_profile: string;
  default_embedding_profile: string;
  default_inference_model: string | null;
  default_prompt_template_id: string | null;
  vector_backend: VectorBackend;
  vector_index_name: string | null;
  vector_namespace: string | null;
  created_at: number;
}

export interface NamespaceCreate {
  slug: string;
  corpus_profile?: string;
  default_embedding_profile?: string;
  default_inference_model?: string | null;
  default_prompt_template_id?: string | null;
  vector_backend?: VectorBackend;
  vector_index_name?: string;
  vector_namespace?: string;
}

export interface ProviderKey {
  id: string;
  provider: ProviderName;
  label: string;
  prefix: string;
  last_validated_at: number | null;
  last_error_code: string | null;
  created_at: number;
}

export interface ProviderKeyCreate {
  provider: ProviderName;
  label: string;
  key: string;
}

export interface ProviderKeyTestResponse {
  ok: boolean;
  error_code?: string;
  error_message?: string;
}

export interface Document {
  id: string;
  tenant_id: string;
  namespace_id: string;
  title: string | null;
  doc_type: string | null;
  metadata: Record<string, unknown> | null;
  current_version_id: string | null;
  created_at: number;
}

export interface UploadResponse {
  upload_id: string;
  url: string;
  key: string;
  expires_at: number;
}

export interface FinalizeResponse {
  version_id: string;
  content_hash: string;
  source_r2_key: string;
  size_bytes: number;
  content_type: string;
  deduplicated: boolean;
}

export interface IngestionJob {
  id: string;
  tenant_id: string;
  document_id: string;
  version_id: string;
  version_index_id: string;
  mode: 'full' | 'embed_only' | 'enrichment_only';
  status: 'pending' | 'running' | 'retrying' | 'completed' | 'failed';
  current_stage: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  created_at: number;
  completed_at: number | null;
}

export interface IngestionJobCreateResponse {
  job_id: string;
  status: string;
  version_index_id: string;
}

export interface Chunk {
  id: string;
  tenant_id: string;
  namespace_id: string;
  document_id: string;
  version_id: string;
  version_index_id: string;
  artifact_type: string;
  section_path: string | null;
  ord: number;
  text: string;
  metadata: Record<string, unknown> | null;
  embedding_profile: string;
  chunking_profile: string;
  embedding_status: 'pending' | 'embedded' | 'missing';
  embedding_dimensions: number | null;
  parent_chunk_id: string | null;
  enrichment_pass_id: string | null;
  created_at: number;
}

export interface StageAttempt {
  job_id: string;
  stage: string;
  attempt: number;
  status: 'started' | 'completed' | 'failed' | 'skipped';
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  metadata: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
}

export type DegradationLevel = 'full' | 'no_citations' | 'partial' | 'cannot_answer';
export type RetrievalStatus = 'full' | 'dense_only' | 'sparse_only' | 'empty';
export type CitationIntegrity = 'valid' | 'invalid_removed' | 'missing';
export type SynthesisStatus = 'success' | 'truncated' | 'failed';

export interface RerankerAudit {
  enabled: boolean;
  executed: boolean;
  provider?: string | null;
  model?: string | null;
  top_n?: number | null;
  latency_ms?: number | null;
  fallback_reason?: string | null;
  actionable?: boolean | null;
}

export interface TokenBreakdown {
  embedding_input: number;
  synthesis_input: number;
  synthesis_output: number;
  context: number;
}

export interface QueryAudit {
  embedding_profile: string;
  chunking_profile: string;
  inference_provider: string;
  inference_model: string;
  provider_key_id: string | null;
  retrieval_strategy: string;
  retrieval_status: RetrievalStatus;
  dense_candidates_returned: number;
  sparse_candidates_returned: number;
  embedding_missing_count: number;
  candidates_returned: number;
  reranker: RerankerAudit;
  citation_integrity: CitationIntegrity | null;
  synthesis_status: SynthesisStatus | null;
  dropped_citations: number[];
  tokens: TokenBreakdown;
  total_cost_usd_micros: number | null;
  latency_ms: number;
}

export interface Citation {
  n: number;
  chunk_id: string;
  section_path: string | null;
  quote?: string;
}

export type Answer =
  | { mode: 'text'; text: string }
  | { mode: 'structured'; object: unknown; raw?: string };

export interface QueryResponse {
  query_event_id: string;
  answer: Answer;
  citations: Citation[];
  degradation_level: DegradationLevel;
  audit: QueryAudit;
}

export interface QueryRequest {
  namespace: string;
  document_ids?: string[];
  query: string;
  embedding: {
    provider: ProviderName;
    model: string;
    dimensions?: number;
    provider_key_ref?: string;
    provider_key_id?: string;
  };
  inference: {
    provider: ProviderName;
    model: string;
    provider_key_ref?: string;
    provider_key_id?: string;
    max_output_tokens?: number;
    temperature?: number;
  };
  chunking?: { profile: string };
  retrieval?: {
    strategy?: 'hybrid_rrf';
    top_k_dense?: number;
    top_k_sparse?: number;
    rrf_k?: number;
    artifact_types?: string[];
    require_citations?: boolean;
  };
  context?: {
    max_context_tokens?: number;
    allow_compression?: boolean;
  };
  prompt?: {
    system?: string;
    developer?: string;
    template_id?: string;
  };
  output?: { mode: 'text' } | { mode: 'structured'; schema: Record<string, unknown> };
}

export interface QueryEvent {
  id: string;
  tenant_id: string;
  namespace_id: string;
  status:
    | 'received'
    | 'retrieval_started'
    | 'retrieval_completed'
    | 'synthesis_started'
    | 'completed'
    | 'failed';
  query_text: string;
  request_config: Record<string, unknown>;
  degradation_level: DegradationLevel | null;
  retrieval_status: string | null;
  citation_integrity: string | null;
  synthesis_status: string | null;
  candidates_returned: number | null;
  citations_returned: number | null;
  dropped_citations: number[] | null;
  latency_ms: number | null;
  answer_r2_key: string | null;
  mirror_error: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  completed_at: number | null;
}
