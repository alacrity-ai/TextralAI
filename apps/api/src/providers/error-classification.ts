// Error classification — turns a raw upstream HTTP response (or a
// thrown error) into a `ProviderErrorType`.
//
// Two-stage triage:
//   1. By HTTP status (generic — `classifyByStatus`).
//   2. By upstream error.code / error.type (provider-specific —
//      `classifyOpenAIError` / `classifyAnthropicError`).
//
// Stage-2 overrides resolve the 429 ambiguity (transient throttle vs.
// permanent quota) and the 400/401 ambiguity (bad request vs. invalid
// key). The `insufficient_quota` and `invalid_api_key` regression cases
// from the v1 incident are pinned by tests in §2.10.1 and §2.4.2.
//
// REDACTION BOUNDARY: this module returns the raw `upstream_message`
// from the upstream provider — that's its job. Every CALL SITE that
// turns this into a `ProviderError` MUST pipe the message through
// Phase 1.6 `redact()` before assigning to `safe_upstream_message`.
// The renamed field on `ProviderError` makes the boundary obvious;
// tests in §2.10.3 prove that no provider key fragment ever leaks.

import type { ProviderErrorType } from './types.js';

export interface ClassificationContext {
  status: number;
  body: unknown; // already-parsed JSON or null
  text: string; // raw text fallback
  retry_after_header?: string | null;
}

export function classifyByStatus(ctx: ClassificationContext): ProviderErrorType {
  if (ctx.status === 401 || ctx.status === 403) return 'invalid_api_key';
  if (ctx.status === 408) return 'timeout';
  if (ctx.status === 429) return 'rate_limit';
  if (ctx.status >= 500 && ctx.status < 600) return 'server_error';
  if (ctx.status >= 400 && ctx.status < 500) return 'bad_request';
  return 'unknown';
}

/** Whether the error type should short-circuit the retry loop.
 *
 *  `bad_request` is fatal: HTTP 400 from OpenAI/Anthropic indicates a
 *  malformed request (unsupported parameter, missing required field,
 *  schema violation), and retrying will deterministically hit the same
 *  400. The only exception class would be transient validation
 *  (none currently observed); if one arises, route it to a more
 *  specific type via the OpenAI/Anthropic classifiers. */
export function isFatal(t: ProviderErrorType): boolean {
  switch (t) {
    case 'invalid_api_key':
    case 'insufficient_quota':
    case 'unsupported_model':
    case 'context_length_exceeded':
    case 'refusal':
    case 'bad_request':
      return true;
    case 'malformed_response':
    case 'schema_violation':
    case 'partial_batch':
    case 'rate_limit':
    case 'server_error':
    case 'timeout':
    case 'network':
    case 'unknown':
      return false;
  }
}

/**
 * Parse a Retry-After header (RFC 7231): either delta-seconds or an
 * HTTP-date. Returns milliseconds, or undefined when absent / malformed.
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

// ── OpenAI-shape classifier ─────────────────────────────────────────────
//
// OpenAI / OpenAI-compatible (Workers AI compat, OpenRouter, Together)
// return error bodies of the shape:
//   { error: { type, code, message, param } }

export interface ClassifiedError {
  type: ProviderErrorType;
  upstream_code?: string;
  upstream_message?: string;
}

interface OpenAIErrorBody {
  error?: { code?: string; message?: string; type?: string };
}

export function classifyOpenAIError(ctx: ClassificationContext): ClassifiedError {
  const errBody = (ctx.body as OpenAIErrorBody | null)?.error;
  const code = errBody?.code;
  const message = errBody?.message;

  // Stage 2: code-driven overrides win over the status default.
  if (code === 'insufficient_quota') {
    return { type: 'insufficient_quota', ...maybeCode(code), ...maybeMessage(message) };
  }
  if (
    code === 'invalid_api_key' ||
    (code === 'invalid_request_error' && /api key/i.test(message ?? ''))
  ) {
    return { type: 'invalid_api_key', ...maybeCode(code), ...maybeMessage(message) };
  }
  if (code === 'context_length_exceeded') {
    return { type: 'context_length_exceeded', ...maybeCode(code), ...maybeMessage(message) };
  }
  if (code === 'model_not_found') {
    return { type: 'unsupported_model', ...maybeCode(code), ...maybeMessage(message) };
  }

  // Stage 1: fall back to status.
  return { type: classifyByStatus(ctx), ...maybeCode(code), ...maybeMessage(message) };
}

// ── Anthropic-shape classifier ──────────────────────────────────────────
//
// Anthropic returns:
//   { type: "error", error: { type: <kind>, message } }
//
// where <kind> is one of: invalid_request_error | authentication_error |
// permission_error | not_found_error | request_too_large |
// rate_limit_error | api_error | overloaded_error.
//
// Note: Anthropic does not surface a distinct "insufficient quota" code.
// Over-quota requests come back as `rate_limit_error`. We map them as
// retryable, accepting that quota exhaustion will only be caught after
// retries exhaust. If consumer feedback flags this, add string-matching
// on the message body in a later phase.

interface AnthropicErrorBody {
  error?: { type?: string; message?: string };
}

export function classifyAnthropicError(ctx: ClassificationContext): ClassifiedError {
  const t = (ctx.body as AnthropicErrorBody | null)?.error?.type;
  const msg = (ctx.body as AnthropicErrorBody | null)?.error?.message;

  switch (t) {
    case 'authentication_error':
      return { type: 'invalid_api_key', ...maybeCode(t), ...maybeMessage(msg) };
    case 'permission_error':
      return { type: 'invalid_api_key', ...maybeCode(t), ...maybeMessage(msg) };
    case 'rate_limit_error':
      return { type: 'rate_limit', ...maybeCode(t), ...maybeMessage(msg) };
    case 'overloaded_error':
      return { type: 'server_error', ...maybeCode(t), ...maybeMessage(msg) };
    case 'request_too_large':
      return { type: 'context_length_exceeded', ...maybeCode(t), ...maybeMessage(msg) };
    case 'invalid_request_error':
      return { type: 'bad_request', ...maybeCode(t), ...maybeMessage(msg) };
    case 'api_error':
      return { type: 'server_error', ...maybeCode(t), ...maybeMessage(msg) };
    case 'not_found_error':
      return { type: 'unsupported_model', ...maybeCode(t), ...maybeMessage(msg) };
    default:
      return { type: classifyByStatus(ctx), ...maybeCode(t), ...maybeMessage(msg) };
  }
}

// `exactOptionalPropertyTypes: true` requires us to not include the key
// at all when the value is undefined.
function maybeCode(c: string | undefined): { upstream_code?: string } {
  return c === undefined ? {} : { upstream_code: c };
}
function maybeMessage(m: string | undefined): { upstream_message?: string } {
  return m === undefined ? {} : { upstream_message: m };
}
