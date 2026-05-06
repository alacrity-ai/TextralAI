// Reranker invocation + audit-friendly fallback.
//
// Phase 4 emitted `audit.reranker = { enabled: false, ... }` always.
// Phase 5 lights this up: when the merged corpus profile says
// `enabled: true`, we call the configured rerank provider; on
// success the candidate order is replaced with the reranker's; on
// any provider failure we fall back to the RRF top-K and record
// `executed: false` + a `fallback_reason` in the audit.
//
// Fallback is not a degradation_level change — RRF top-K is a valid
// answer. Audit consumers who want to alert on quota exhaustion
// should look at `actionable: true`.

import {
  ACTIONABLE_FALLBACK_REASONS,
  type RerankerAudit,
  type RerankerFallbackReason,
} from '@textral/contracts';
import type { Resolved as ResolvedProvider } from '../providers/registry.js';

export type RerankProviderId = 'voyage' | 'cohere';

export interface RerankCandidate {
  chunk_id: string;
  text: string;
}

export interface RerankInput {
  query: string;
  candidates: RerankCandidate[];
  config: {
    enabled: boolean;
    provider?: RerankProviderId;
    model?: string;
    top_n: number;
  };
  /** Pre-resolved provider object (may be null when no key was
   *  available). The caller resolves the BYOK key before calling us;
   *  null + enabled means we fall back with reason `PROVIDER_KEY_NOT_FOUND`. */
  resolved_provider: ResolvedProvider | null;
}

export interface RerankOutcome {
  /** chunk_ids in the post-rerank order, top first. When we fell
   *  back, this is the original candidate order truncated to top_n. */
  reordered: string[];
  audit: RerankerAudit;
}

function audit(
  partial: Omit<RerankerAudit, 'enabled' | 'executed'>,
  enabled: boolean,
  executed: boolean,
): RerankerAudit {
  if (!executed && partial.fallback_reason) {
    const fr: RerankerFallbackReason = partial.fallback_reason;
    return {
      enabled,
      executed,
      ...partial,
      actionable: ACTIONABLE_FALLBACK_REASONS.has(fr),
    };
  }
  return { enabled, executed, ...partial };
}

export async function maybeRerank(input: RerankInput): Promise<RerankOutcome> {
  const start = Date.now();

  // Disabled: emit Phase 4-shaped audit unchanged.
  if (!input.config.enabled) {
    return {
      reordered: input.candidates.map((c) => c.chunk_id),
      audit: {
        enabled: false,
        executed: false,
        provider: null,
        model: null,
        top_n: null,
      },
    };
  }

  const provider = input.config.provider ?? null;
  const model = input.config.model ?? null;
  const topN = input.config.top_n;

  // Empty input — no rerank to do, but still record what was asked.
  if (input.candidates.length === 0) {
    return {
      reordered: [],
      audit: audit(
        {
          provider,
          model,
          top_n: topN,
          latency_ms: 0,
          fallback_reason: 'EMPTY_INPUT',
        },
        true,
        false,
      ),
    };
  }

  // No provider key resolved.
  if (!input.resolved_provider || !input.resolved_provider.rerank) {
    return {
      reordered: fallbackTopK(input.candidates, topN),
      audit: audit(
        {
          provider,
          model,
          top_n: topN,
          latency_ms: Date.now() - start,
          fallback_reason: 'PROVIDER_KEY_NOT_FOUND',
        },
        true,
        false,
      ),
    };
  }

  if (!model) {
    // Schema validation should catch this earlier; treat as
    // PROVIDER_UNAVAILABLE for safety.
    return {
      reordered: fallbackTopK(input.candidates, topN),
      audit: audit(
        {
          provider,
          model: null,
          top_n: topN,
          latency_ms: Date.now() - start,
          fallback_reason: 'PROVIDER_UNAVAILABLE',
        },
        true,
        false,
      ),
    };
  }

  // Invoke. The Phase-2 rerank providers wrap their own
  // retry/classification, so we just look at the outcome.
  const result = await input.resolved_provider.rerank.rerank(
    {
      model,
      query: input.query,
      documents: input.candidates.map((c) => c.text),
      top_n: topN,
    },
    input.resolved_provider.options,
  );

  if (result.outcome === 'success' || result.outcome === 'degraded_success') {
    const ordered: string[] = [];
    for (const r of result.value.results.slice(0, topN)) {
      const cand = input.candidates[r.index];
      if (cand) ordered.push(cand.chunk_id);
    }
    return {
      reordered: ordered.length > 0 ? ordered : fallbackTopK(input.candidates, topN),
      audit: audit(
        {
          provider,
          model,
          top_n: topN,
          latency_ms: Date.now() - start,
        },
        true,
        true,
      ),
    };
  }

  // fatal_error or retryable_error → fall back.
  const reason = mapErrorTypeToFallbackReason(result.error.type);
  return {
    reordered: fallbackTopK(input.candidates, topN),
    audit: audit(
      {
        provider,
        model,
        top_n: topN,
        latency_ms: Date.now() - start,
        fallback_reason: reason,
      },
      true,
      false,
    ),
  };
}

function fallbackTopK(candidates: RerankCandidate[], topN: number): string[] {
  return candidates.slice(0, topN).map((c) => c.chunk_id);
}

function mapErrorTypeToFallbackReason(errType: string): RerankerFallbackReason {
  switch (errType) {
    case 'insufficient_quota':
      return 'PROVIDER_QUOTA_EXHAUSTED';
    case 'invalid_api_key':
      return 'PROVIDER_KEY_NOT_FOUND';
    case 'timeout':
      return 'PROVIDER_TIMEOUT';
    case 'rate_limit':
    case 'server_error':
    case 'network':
    case 'malformed_response':
    case 'partial_batch':
    case 'unsupported_model':
    default:
      return 'PROVIDER_UNAVAILABLE';
  }
}

export type { ResolvedProvider };
