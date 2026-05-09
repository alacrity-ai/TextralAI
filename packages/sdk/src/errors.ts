// SDK error hierarchy.
//
// `TextralApiError` mirrors the envelope shape emitted by every
// Textral REST route. The retry/stream/cancel features added in
// 0.2.x introduce two more concrete classes; all three extend a
// shared `TextralError` base so call sites can catch broadly when
// they want to ("any SDK-shaped failure") and narrowly when they
// don't.

export class TextralError extends Error {
  override readonly name: string = 'TextralError';
}

/** Server returned a non-2xx response that parsed into the canonical
 *  `{error: {code, message, request_id, details}}` envelope. The
 *  retry layer treats certain `status` codes as retryable; see
 *  retry.ts for the policy. */
export class TextralApiError extends TextralError {
  override readonly name = 'TextralApiError';
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** The retry policy gave up after `attempts` retries. The original
 *  failure (the last attempt's error) is in `cause`; downstream code
 *  can inspect it via `(err as TextralRetryExhausted).cause`. */
export class TextralRetryExhausted extends TextralError {
  override readonly name = 'TextralRetryExhausted';
  constructor(
    public readonly attempts: number,
    public override readonly cause: unknown,
  ) {
    super(
      `retries exhausted after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

/** A server-sent-events stream was interrupted before the canonical
 *  `[DONE]` frame. Streams are deliberately not retried by the SDK
 *  (per the design plan §4 Q7); this error surfaces the failure to
 *  the caller, who can decide whether to re-issue the whole query.
 *  `cause` carries the underlying network/decode error when present. */
export class TextralStreamInterrupted extends TextralError {
  override readonly name = 'TextralStreamInterrupted';
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
  }
}
