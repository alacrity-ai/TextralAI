// Standardized error envelope + error code catalog. The catalog is the
// single source of truth — no scattered string literals at call sites.
// Phase 6.1 expands this; Phase 0/1 covers the starter set.

import { z } from 'zod';

export const ErrorCode = z.enum([
  // generic
  'INTERNAL',
  'NOT_FOUND',
  'BAD_REQUEST',
  // auth (Phase 1.3+)
  'INVALID_API_KEY',
  // tenancy (Phase 1.4+)
  'TENANT_NOT_FOUND',
  'NAMESPACE_NOT_FOUND',
  'NAMESPACE_ALREADY_EXISTS',
  'NAMESPACE_DIMENSION_MISMATCH',
  // provider keys (Phase 1.5 / Phase 2.8)
  'PROVIDER_KEY_NOT_FOUND',
  'PROVIDER_KEY_INVALID',
  'PROVIDER_KEY_VALIDATION_FAILED',
  // provider abstraction (Phase 2)
  'PROVIDER_QUOTA_EXHAUSTED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REFUSAL',
  'PROVIDER_MALFORMED_RESPONSE',
  'PROVIDER_UNSUPPORTED_MODEL',
  'CONTEXT_LENGTH_EXCEEDED',
  // ingestion (Phase 3)
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_VERSION_NOT_FOUND',
  'UPLOAD_VALIDATION_FAILED',
  'UPLOAD_INTENT_NOT_FOUND',
  'INDEX_ALREADY_BUILT',
  'INGESTION_IN_PROGRESS',
  'INGESTION_FAILED',
  'JOB_NOT_RUNNING',
  'JOB_CANCELLED',
  'UNSUPPORTED_CHUNK_JSONL_SCHEMA',
  // retrieval / synthesis (Phase 4)
  'EMBEDDING_PROFILE_MISMATCH',
  'RETRIEVAL_FAILED',
  'SYNTHESIS_FAILED',
  'EMPTY_QUERY',
  // query-events response retrieval (Phase 2.1 follow-up — sandbox replay)
  'QUERY_RESPONSE_UNAVAILABLE',
  // corpus profiles + enrichment (Phase 5)
  'UNKNOWN_CORPUS_PROFILE',
  'ENRICHMENT_PASS_FAILED',
  'INPUT_TOO_LARGE_FOR_PASS',
  // internal back-channel (Phase 3.4)
  'INTERNAL_AUTH_REQUIRED',
  'INTERNAL_TIMESTAMP_OUT_OF_WINDOW',
  'INTERNAL_SIGNATURE_INVALID',
  'INTERNAL_OWNERSHIP_MISMATCH',
  // Phase 6 — DLQ admin + admin endpoints
  'DLQ_NOT_FOUND',
  'DLQ_NOT_DEAD_LETTERED',
  'ADMIN_RATE_LIMITED',
  'INSUFFICIENT_SCOPE',
  // Phase 6 — streaming
  'STREAM_INTERRUPTED',
  // Phase 7 — eval contract
  'EVAL_SET_NOT_FOUND',
  'EVAL_QUESTION_NOT_FOUND',
  'EVAL_RUN_NOT_FOUND',
  'EVAL_RUN_FAILED',
  'EVAL_JUDGE_FAILED',
  // not implemented (used by Phase 1.5 stubs that light up in Phase 2)
  'NOT_IMPLEMENTED',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    request_id: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** Throwable from any route or middleware. The global error handler
 *  (Phase 6.1) turns it into the standard envelope. */
export class TextralError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TextralError';
  }

  toEnvelope(requestId?: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(requestId ? { request_id: requestId } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
