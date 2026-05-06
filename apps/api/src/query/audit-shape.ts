// Audit-row finalization for the query pipeline.
//
// Pulled out of routes/query.ts in the post-Phase-5 cleanup. Owns the
// boilerplate of mapping pipeline-stage outputs into the persisted
// query_events row + the response audit object.

import type { QueryAudit, RerankerAudit } from '@textral/contracts';
import type { Env } from '../types.js';
import { updateQueryEvent } from '../audit/query-events.js';

// Re-export the canonical contract type as the local alias the rest of
// the query pipeline imports. There is no duplicate inline declaration
// here — `audit-shape` returns `QueryAudit` directly.
export type QueryAuditResult = QueryAudit;

export interface FinalizeAuditArgs {
  retrieval: {
    retrieval_status: 'full' | 'dense_only' | 'sparse_only' | 'empty';
    candidates: { chunk_id: string }[];
    dense_count: number;
    sparse_count: number;
    embedding_missing_count: number;
  };
  ctx: { included: { chunk_id: string }[]; total_tokens: number };
  embeddingProfile: string;
  chunkingProfile: string;
  provider: string;
  model: string;
  providerKeyId: string | null;
  retrievalStrategy: string;
  embeddingInputTokens: number;
  synthInputTokens: number;
  synthOutputTokens: number;
  contextTokens: number;
  synthesisStatus: 'success' | 'truncated' | 'failed';
  citationIntegrity: 'valid' | 'invalid_removed' | 'missing';
  droppedCitations: number[];
  citationsReturned: number;
  degradation: 'full' | 'no_citations' | 'partial' | 'cannot_answer';
  startTs: number;
  rerankerAudit: RerankerAudit;
}

export async function finalizeAudit(
  env: Env,
  qevId: string,
  a: FinalizeAuditArgs,
): Promise<QueryAuditResult> {
  const latency = Date.now() - a.startTs;
  await updateQueryEvent(env, qevId, {
    status: 'completed',
    citations_returned: a.citationsReturned,
    citation_integrity: a.citationIntegrity,
    synthesis_status: a.synthesisStatus,
    dropped_citations: a.droppedCitations,
    degradation_level: a.degradation,
    embedding_input_tokens: a.embeddingInputTokens,
    synthesis_input_tokens: a.synthInputTokens,
    synthesis_output_tokens: a.synthOutputTokens,
    context_tokens: a.contextTokens,
    latency_ms: latency,
    inference_provider: a.provider,
    inference_model_used: a.model,
    provider_key_id: a.providerKeyId,
  });
  return {
    embedding_profile: a.embeddingProfile,
    chunking_profile: a.chunkingProfile,
    inference_provider: a.provider,
    inference_model: a.model,
    provider_key_id: a.providerKeyId,
    retrieval_strategy: a.retrievalStrategy,
    retrieval_status: a.retrieval.retrieval_status,
    dense_candidates_returned: a.retrieval.dense_count,
    sparse_candidates_returned: a.retrieval.sparse_count,
    embedding_missing_count: a.retrieval.embedding_missing_count,
    candidates_returned: a.retrieval.candidates.length,
    reranker: a.rerankerAudit,
    citation_integrity: a.citationIntegrity,
    synthesis_status: a.synthesisStatus,
    dropped_citations: a.droppedCitations,
    tokens: {
      embedding_input: a.embeddingInputTokens,
      synthesis_input: a.synthInputTokens,
      synthesis_output: a.synthOutputTokens,
      context: a.contextTokens,
    },
    total_cost_usd_micros: null,
    latency_ms: latency,
  };
}

export async function finalizeFailure(
  env: Env,
  qevId: string,
  degradation: 'full' | 'no_citations' | 'partial' | 'cannot_answer',
  retrievalStatus: string,
  reason: string,
  synthesisStatus: 'success' | 'truncated' | 'failed' | null = null,
): Promise<QueryAuditResult> {
  const now = Date.now();
  await updateQueryEvent(env, qevId, {
    status: 'failed',
    degradation_level: degradation,
    retrieval_status: retrievalStatus,
    synthesis_status: synthesisStatus,
    error_message: reason,
    latency_ms: now,
    citations_returned: 0,
    candidates_returned: 0,
  });
  return {
    embedding_profile: '',
    chunking_profile: '',
    inference_provider: '',
    inference_model: '',
    provider_key_id: null,
    retrieval_strategy: 'hybrid_rrf',
    retrieval_status: retrievalStatus as 'full' | 'dense_only' | 'sparse_only' | 'empty',
    dense_candidates_returned: 0,
    sparse_candidates_returned: 0,
    embedding_missing_count: 0,
    candidates_returned: 0,
    reranker: { enabled: false, executed: false, provider: null, model: null, top_n: null },
    citation_integrity: 'missing' as const,
    synthesis_status: (synthesisStatus ?? 'failed') as 'success' | 'truncated' | 'failed',
    dropped_citations: [],
    tokens: { embedding_input: 0, synthesis_input: 0, synthesis_output: 0, context: 0 },
    total_cost_usd_micros: null,
    latency_ms: now,
  };
}

export function emptyResponse(
  qevId: string,
  audit: QueryAuditResult,
  reason: string,
): {
  query_event_id: string;
  answer: { mode: 'text'; text: string };
  citations: [];
  degradation_level: 'cannot_answer';
  audit: QueryAuditResult;
} {
  return {
    query_event_id: qevId,
    answer: { mode: 'text', text: reason },
    citations: [],
    degradation_level: 'cannot_answer',
    audit,
  };
}
