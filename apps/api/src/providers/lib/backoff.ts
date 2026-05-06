// Exponential backoff with jitter, capped. Used by ProviderHttpClient
// between retry attempts.
//
//   attempt 0  → ~500 ms  (base)
//   attempt 1  → ~1 s
//   attempt 2  → ~2 s
//   attempt 3+ → ~4 s     (capped)
//
// `retryAfterMs` (from a Retry-After header) is honored when present,
// up to 2× the cap. We never wait longer than 8 s on a single attempt.

const BASE_MS = 500;
const CAP_MS = 4_000;
const JITTER = 0.2;

export function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs != null) return Math.min(retryAfterMs, CAP_MS * 2);
  const exp = Math.min(BASE_MS * 2 ** attempt, CAP_MS);
  const jitter = exp * JITTER * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
