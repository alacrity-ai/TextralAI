/**
 * 06-retry-and-cancel.ts — Retry policy + AbortSignal threading.
 *
 * Demonstrates: custom retry policy, onRetry telemetry hook,
 * AbortSignal cancellation, distinct error classes
 * (TextralRetryExhausted vs the underlying error).
 *
 * Env: same as 01-quick-start.ts.
 *
 * Run:
 *     npx tsx 06-retry-and-cancel.ts
 *
 * See also:
 *     SDK_COOKBOOK_OUTLINE.md §7
 */

import {
  TextralClient,
  TextralRetryExhausted,
  TextralApiError,
} from '@textral/sdk';

const profileName = process.env.TEXTRAL_PROFILE;
const namespace = process.env.TEXTRAL_NAMESPACE ?? 'cookbook';
const providerKeyRef = process.env.TEXTRAL_PROVIDER_KEY_REF ?? 'openai';

const client = profileName
  ? new TextralClient({
      profile: profileName,
      retry: {
        maxAttempts: 5,
        initialDelayMs: 500,
        maxDelayMs: 8_000,
        retryOn: [429, 502, 503, 504],
        onRetry: ({ attempt, status, delayMs }) => {
          console.error(
            `retry #${attempt}: status=${status ?? 'transport'} sleeping ${delayMs}ms`,
          );
        },
      },
    })
  : new TextralClient({
      baseUrl: process.env.TEXTRAL_BASE_URL ?? 'https://api.textral.alacrity.ai',
      apiKey: process.env.TEXTRAL_API_KEY ?? '',
      retry: {
        maxAttempts: 5,
        initialDelayMs: 500,
        maxDelayMs: 8_000,
        retryOn: [429, 502, 503, 504],
        onRetry: ({ attempt, status, delayMs }) => {
          console.error(
            `retry #${attempt}: status=${status ?? 'transport'} sleeping ${delayMs}ms`,
          );
        },
      },
    });

const ac = new AbortController();
// Cancel after 5s — beats anything but a fast-path success.
setTimeout(() => ac.abort(), 5_000).unref();

try {
  const r = await client.query(
    {
      namespace,
      query: 'What survived the Library of Alexandria?',
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 1536,
        provider_key_ref: providerKeyRef,
      },
      inference: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        provider_key_ref: providerKeyRef,
      },
    },
    { signal: ac.signal },
  );
  console.log(typeof r.answer === 'string' ? r.answer : JSON.stringify(r.answer, null, 2));
} catch (e) {
  if (e instanceof Error && e.name === 'AbortError') {
    console.error('cancelled');
    process.exit(2);
  }
  if (e instanceof TextralRetryExhausted) {
    const cause = e.cause instanceof TextralApiError ? `${e.cause.code}: ${e.cause.message}` : String(e.cause);
    console.error(`gave up after ${e.attempts} attempts — ${cause}`);
    process.exit(3);
  }
  throw e;
}
