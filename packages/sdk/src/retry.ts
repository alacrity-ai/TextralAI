// Retry / backoff policy for SDK requests.
//
// One chokepoint — every public client method goes through
// `withRetry(...)`. The policy:
//
//   * Up to N attempts (default 3, configurable per-client).
//   * Exponential backoff with ±25% jitter, capped at maxDelayMs.
//   * Retries 429 + 5xx (502/503/504 by default).
//   * Honors `Retry-After` header when present (seconds or HTTP-date).
//   * Idempotent methods (GET / DELETE) always retried; POSTs only
//     retried when the route is on the explicit allowlist below.
//   * Propagates AbortSignal — an in-flight backoff sleep aborts
//     immediately if the caller cancels.
//
// The retry/stream/cancel design lives in
// docs/development/sdks/NODE_SDK_IMPLEMENTATION.md §5.

import { TextralApiError, TextralRetryExhausted } from './errors.js';

export interface RetryInfo {
  /** 1-indexed. The first attempt is `1`; the first *retry* is `2`. */
  attempt: number;
  /** HTTP status when present (null for transport-level failures). */
  status: number | null;
  /** Computed sleep before the next attempt, in ms. */
  delayMs: number;
  /** The thrown value from the failed attempt. */
  error: unknown;
}

export interface RetryPolicy {
  /** Total attempts including the first. Default 3 = original + 2
   *  retries. Set to 1 to disable retries entirely. */
  maxAttempts: number;
  /** Base delay before the first retry. */
  initialDelayMs: number;
  /** Cap on the per-attempt sleep. */
  maxDelayMs: number;
  /** HTTP statuses that trigger a retry. Anything else falls
   *  straight through. */
  retryOn: number[];
  /** Optional telemetry hook. Fires on every retry-eligible failure
   *  *before* the backoff sleep. */
  onRetry?: (info: RetryInfo) => void;
  /** Allow specific POST routes to opt into retry. Format:
   *  "POST /v1/path". The default allowlist is the set of routes
   *  with server-side dedupe semantics — see DEFAULT_RETRY below. */
  retryOnPostMethods?: string[];
}

/** Routes whose POST handlers are idempotent server-side and
 *  therefore safe to retry on transient failure. Adding to this
 *  list requires the server-side guarantee — DON'T extend without
 *  checking the route handler. Each entry's reason:
 *
 *    /v1/auth/redeem
 *      Single-use token; consumed-token retry returns the same
 *      response. Safe.
 *
 *    /v1/auth/register, /v1/auth/recover
 *      Always return 202; safe to re-fire (worst case: two emails
 *      to the same user, which is already rate-limited server-side).
 *
 *    /v1/ingest/bulk
 *      Hashed by `client_request_id` for 24h. Safe when the caller
 *      passes one.
 *
 *    /v1/documents/{id}/uploads/{u}/finalize
 *      Server is idempotent on `(document_id, content_hash)`. Safe.
 *
 *    /v1/ingest/bulk/{id}/finalize
 *      Per-file finalize is idempotent. Safe to retry the whole call.
 */
// Patterns are matched against the route AFTER the client's
// `normalizePath()` has replaced ULID-shaped segments with `{id}`.
// Adding here requires server-side dedupe / no-op-on-duplicate
// semantics — see the comment block above.
const DEFAULT_IDEMPOTENT_POSTS = [
  'POST /v1/auth/redeem',
  'POST /v1/auth/register',
  'POST /v1/auth/recover',
  'POST /v1/ingest/bulk',
  'POST /v1/ingest/bulk/{id}/finalize',
  'POST /v1/documents/{id}/uploads/{id}/finalize',
] as const;

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 5_000,
  retryOn: [429, 502, 503, 504],
  retryOnPostMethods: [...DEFAULT_IDEMPOTENT_POSTS],
};

/** No retries. Pass this to a client's `retry:` field to opt out. */
export const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
  retryOn: [],
};

export interface RequestContext {
  /** HTTP method, uppercase. */
  method: string;
  /** Route path used for the idempotent-POST allowlist match. The
   *  caller normalizes path params (e.g. `/v1/documents/{id}/uploads/{u}/finalize`).
   *  Match is exact-string against `retryOnPostMethods`. */
  routePattern: string;
}

/** Run `fn` with retry semantics. Returns whatever `fn` returns;
 *  throws one of three things:
 *
 *    1. `fn`'s underlying error verbatim — when the error is NOT
 *       retryable (wrong status code, non-idempotent POST, abort).
 *    2. `TextralRetryExhausted` — when the error WAS retryable but
 *       we've used up the configured `maxAttempts`. Wraps the last
 *       error in `.cause`.
 *    3. `AbortError` — when the caller's signal aborts at any
 *       point (between attempts or during a backoff sleep).
 *
 *  These three are deliberately distinct so call sites can branch
 *  cleanly on intent. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  ctx: RequestContext,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Non-retryable → throw original error.
      if (!isRetryableError(err, policy, ctx)) throw err;
      // Retryable but out of attempts → throw exhausted wrapper.
      if (attempt >= policy.maxAttempts) {
        throw new TextralRetryExhausted(policy.maxAttempts, err);
      }
      // Otherwise: sleep with backoff, then loop.
      const status = extractStatus(err);
      const delayMs = computeDelay(attempt, policy, err);
      policy.onRetry?.({ attempt, status, delayMs, error: err });
      await sleep(delayMs, signal);
    }
  }
  // Unreachable — the loop body either returns or throws on every
  // iteration. Defensive throw keeps TS happy + catches a future
  // refactor that drops the throw.
  throw new TextralRetryExhausted(policy.maxAttempts, lastError);
}

function isRetryableError(
  err: unknown,
  policy: RetryPolicy,
  ctx: RequestContext,
): boolean {
  // Aborts are never retried — caller asked us to stop.
  if (err instanceof Error && err.name === 'AbortError') return false;

  // POST methods need to be on the idempotent allowlist.
  if (ctx.method === 'POST') {
    const allowlist = policy.retryOnPostMethods ?? [];
    const target = `${ctx.method} ${ctx.routePattern}`;
    if (!allowlist.includes(target)) return false;
  }

  if (err instanceof TextralApiError) {
    return policy.retryOn.includes(err.status);
  }
  // Transport-level failure (e.g., DNS, connection-reset) →
  // retryable by default.
  return true;
}

function extractStatus(err: unknown): number | null {
  if (err instanceof TextralApiError) return err.status;
  return null;
}

function computeDelay(
  attempt: number,
  policy: RetryPolicy,
  err: unknown,
): number {
  // Honor Retry-After when present (the server is telling us when
  // to come back; ignore our own backoff math in that case).
  if (err instanceof TextralApiError && err.retryAfter !== undefined) {
    return Math.min(err.retryAfter * 1000, policy.maxDelayMs);
  }
  // Exponential backoff with ±25% jitter.
  const base = Math.min(
    policy.initialDelayMs * Math.pow(2, attempt - 1),
    policy.maxDelayMs,
  );
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/** Cancellable sleep. Resolves after `ms`; rejects with AbortError
 *  if the signal aborts before then. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Parse a `Retry-After` header (seconds or HTTP-date) into a
 *  delay in seconds. Exported so the client's response handler
 *  can stash it on the TextralApiError it builds. Returns
 *  `undefined` when the header is missing or unparseable. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // Plain seconds.
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds;
  // HTTP-date.
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    const seconds = Math.max(0, Math.round((ts - Date.now()) / 1000));
    return seconds;
  }
  return undefined;
}
