// Shared HTTP client base. Every fetch-based provider extends this.
//
// The base class owns:
//   - URL resolution (gateway vs. direct, with the model in scope so
//     e.g. Workers AI compat can interpolate the account ID per call),
//   - Header construction (Authorization + AI Gateway metadata),
//   - Per-call timeout, composed correctly with caller-supplied
//     AbortSignals (EITHER expiring forces the underlying fetch to abort),
//   - The shared `withRetries<T>()` helper that owns the retry loop,
//     attempt counting, backoff sleeps, fatal-vs-retryable dispatch, and
//     telemetry emission. Concrete providers no longer write
//     `while (attempt < 3)` loops — they pass `call`, `parseSuccess`,
//     and `classifyError` callbacks.

import { backoffDelay, sleep } from './backoff.js';
import { gatewayBaseUrl, buildAigMetadata, gatewayMetadataHeader } from '../ai-gateway.js';
import { isFatal } from '../error-classification.js';
import { emitProviderTelemetry } from '../telemetry.js';
import type { ProviderError, ProviderResult, ProviderOptions, ProviderMeta } from '../types.js';

const MAX_ATTEMPTS = 3;

export interface PostResult {
  status: number;
  body: unknown; // already-parsed JSON or null
  text: string; // raw text fallback
  headers: Headers;
  latency_ms: number;
}

/**
 * Compose the per-call timeout AbortController with a caller-supplied
 * signal. EITHER expiring forces fetch to abort. We tag the timeout
 * abort reason with `Error('timeout')` so `classifyThrown` can
 * distinguish it from caller cancellation.
 */
export function composeAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onCallerAbort = (): void => {
    ctrl.abort(callerSignal?.reason ?? new Error('caller_aborted'));
  };
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

export interface WithRetriesArgs<T> {
  model: string;
  timeoutMs: number;
  opts: ProviderOptions;
  call: (attempt: number) => Promise<PostResult>;
  parseSuccess: (
    res: PostResult,
    attempt: number,
  ) => { ok: true; value: T; warning?: ProviderError } | { ok: false; error: ProviderError };
  classifyError: (res: PostResult, attempt: number) => ProviderError;
}

export abstract class ProviderHttpClient {
  /** Public, stable provider name — used in telemetry, gateway tags,
   *  and `ProviderError.provider`. Concrete classes assign with
   *  `public override readonly name = '...'`. */
  abstract readonly name: string;

  /** Direct base URL (gateway-bypass path). Receives the model so e.g.
   *  Workers AI compat can interpolate the account ID at call time. */
  protected abstract directBaseUrl(model: string): string;

  protected resolveBaseUrl(
    model: string,
    opts: ProviderOptions,
  ): { url: string; via_gateway: boolean } {
    if (opts.gateway) return { url: gatewayBaseUrl(opts.gateway), via_gateway: true };
    if (opts.base_url) return { url: opts.base_url, via_gateway: false };
    return { url: this.directBaseUrl(model), via_gateway: false };
  }

  protected buildHeaders(opts: ProviderOptions): Headers {
    const h = new Headers({ 'content-type': 'application/json' });
    if (opts.api_key) h.set('authorization', `Bearer ${opts.api_key}`);
    if (opts.gateway && opts.request_metadata) {
      h.set(gatewayMetadataHeader(opts.gateway), buildAigMetadata(opts.request_metadata));
    }
    return h;
  }

  protected async post(
    model: string,
    path: string,
    body: unknown,
    opts: ProviderOptions,
    timeoutMs: number,
  ): Promise<PostResult> {
    const { url } = this.resolveBaseUrl(model, opts);
    const { signal, cancel } = composeAbort(opts.signal, timeoutMs);
    const start = Date.now();
    try {
      const res = await fetch(`${url}/${path}`, {
        method: 'POST',
        headers: this.buildHeaders(opts),
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // leave null
      }
      return {
        status: res.status,
        body: parsed,
        text,
        headers: res.headers,
        latency_ms: Date.now() - start,
      };
    } finally {
      cancel();
    }
  }

  /** Distinguishes timeout from caller cancellation. The `composeAbort`
   *  helper tags timeouts with `Error('timeout')`. */
  protected classifyThrown(e: unknown, model: string, attempt: number): ProviderError {
    const msg = String((e as { message?: unknown })?.message ?? e);
    const reason = (e as { reason?: { message?: unknown } })?.reason;
    const reasonMsg = String(reason?.message ?? '');
    const isTimeout = msg === 'timeout' || reasonMsg === 'timeout';
    const isCallerAbort = msg === 'caller_aborted' || reasonMsg === 'caller_aborted';
    return {
      type: isTimeout ? 'timeout' : isCallerAbort ? 'unknown' : 'network',
      provider: this.name,
      model,
      retry_count: attempt,
      safe_upstream_message: isCallerAbort ? 'caller cancelled' : msg,
    };
  }

  /**
   * Shared retry loop. Concrete providers pass:
   *   - `call(attempt)` — issues the fetch and returns a PostResult, or
   *     throws (timeout / network / caller abort).
   *   - `parseSuccess(res)` — turns a 2xx PostResult into either a
   *     successful `value` (with optional warning for degraded_success)
   *     or a synthesized `ProviderError` (e.g. malformed_response,
   *     schema_violation). Errors here flow through the same
   *     fatal-vs-retryable dispatch as upstream HTTP errors.
   *   - `classifyError(res)` — turns a non-2xx PostResult into a
   *     `ProviderError` (provider-specific second-stage triage).
   *
   * `withRetries` owns: attempt counting, backoff sleeps, fatal
   * short-circuit, Retry-After honoring, telemetry emission, and final
   * `ProviderResult` construction.
   */
  protected async withRetries<T>(args: WithRetriesArgs<T>): Promise<ProviderResult<T>> {
    let attempt = 0;
    let lastErr: ProviderError | undefined;
    let lastLatency = 0;

    while (attempt < MAX_ATTEMPTS) {
      let res: PostResult;
      try {
        res = await args.call(attempt);
        lastLatency = res.latency_ms;
      } catch (e) {
        const err = this.classifyThrown(e, args.model, attempt);
        if (isFatal(err.type)) {
          return this.finalize<T>('fatal_error', {
            error: err,
            meta: this.buildMeta(args, attempt, lastLatency),
          });
        }
        // Caller cancellation — never retry.
        if (err.safe_upstream_message === 'caller cancelled') {
          return this.finalize<T>('retryable_error', {
            error: err,
            meta: this.buildMeta(args, attempt, lastLatency),
          });
        }
        lastErr = err;
        attempt++;
        if (attempt >= MAX_ATTEMPTS) break;
        await sleep(backoffDelay(attempt - 1), args.opts.signal);
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        const parsed = args.parseSuccess(res, attempt);
        if (parsed.ok) {
          if (parsed.warning) {
            return this.finalize<T>('degraded_success', {
              value: parsed.value,
              warning: parsed.warning,
              meta: this.buildMeta(args, attempt, lastLatency),
            });
          }
          return this.finalize<T>('success', {
            value: parsed.value,
            meta: this.buildMeta(args, attempt, lastLatency),
          });
        }
        // parseSuccess produced an error — could be fatal (refusal) or
        // retryable (schema_violation). Same dispatch as HTTP errors.
        if (isFatal(parsed.error.type)) {
          return this.finalize<T>('fatal_error', {
            error: parsed.error,
            meta: this.buildMeta(args, attempt, lastLatency),
          });
        }
        lastErr = parsed.error;
        attempt++;
        if (attempt >= MAX_ATTEMPTS) break;
        await sleep(backoffDelay(attempt - 1), args.opts.signal);
        continue;
      }

      const err = args.classifyError(res, attempt);
      if (isFatal(err.type)) {
        return this.finalize<T>('fatal_error', {
          error: err,
          meta: this.buildMeta(args, attempt, lastLatency),
        });
      }
      lastErr = err;
      attempt++;
      if (attempt >= MAX_ATTEMPTS) break;
      await sleep(backoffDelay(attempt - 1, err.retry_after_ms), args.opts.signal);
    }

    return this.finalize<T>('retryable_error', {
      error: lastErr ?? {
        type: 'unknown',
        provider: this.name,
        model: args.model,
        retry_count: attempt,
      },
      meta: this.buildMeta(args, attempt, lastLatency),
    });
  }

  private buildMeta(
    args: { model: string; opts: ProviderOptions },
    attempt: number,
    latency: number,
  ): ProviderMeta {
    return {
      provider: this.name,
      model: args.model,
      latency_ms: latency,
      retry_count: attempt,
      via_gateway: Boolean(args.opts.gateway),
    };
  }

  private finalize<T>(
    outcome: ProviderResult<T>['outcome'],
    base:
      | { value: T; warning?: ProviderError; meta: ProviderMeta }
      | { error: ProviderError; meta: ProviderMeta },
  ): ProviderResult<T> {
    // Single emission point. Phase 6 swaps console.info → AE.
    emitProviderTelemetry({
      outcome,
      provider: base.meta.provider,
      model: base.meta.model,
      latency_ms: base.meta.latency_ms,
      retry_count: base.meta.retry_count,
      via_gateway: base.meta.via_gateway,
      ...('error' in base ? { error_type: base.error.type } : {}),
    });
    if (outcome === 'success' && 'value' in base) {
      return { outcome, value: base.value, meta: base.meta };
    }
    if (outcome === 'degraded_success' && 'value' in base && base.warning) {
      return { outcome, value: base.value, warning: base.warning, meta: base.meta };
    }
    if ('error' in base) {
      return {
        outcome: outcome as 'retryable_error' | 'fatal_error',
        error: base.error,
        meta: base.meta,
      };
    }
    throw new Error(`unreachable finalize variant: ${outcome}`);
  }
}
