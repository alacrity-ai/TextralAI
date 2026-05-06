// Validation factory — issues a minimal call against a provider key
// to confirm it is alive and authorized.
//
// Implementations:
//   openai     → POST /v1/embeddings, model=text-embedding-3-small,
//                input=['ping']  (1 input token, near-zero cost).
//   anthropic  → POST /v1/messages, model=claude-haiku-4-5,
//                max_tokens=1, message='hi'.
//   voyage     → small rerank with a single candidate.
//   cohere     → small rerank with a single candidate.
//   workers_ai → not validatable (no key); always returns ok.
//
// Validation calls go through `resolve(env, ...)` so AI Gateway tagging
// is consistent with the production path. The Cloudflare AI Gateway
// dashboard will surface validation calls tagged with `tenant_id` and
// `provider_key_id` — useful for auditing.

import type { Env } from '../types.js';
import { resolve } from './registry.js';
import type { ProviderError, ProviderResult } from './types.js';

export interface ValidationResult {
  ok: boolean;
  error_code?: string;
  error_message?: string;
}

export interface ValidateContext {
  tenant_id: string;
  provider_key_id: string;
}

export async function validateProviderKey(
  env: Env,
  provider: string,
  rawKey: string,
  ctx: ValidateContext,
): Promise<ValidationResult> {
  switch (provider) {
    case 'openai':
      return validateOpenAI(env, rawKey, ctx);
    case 'anthropic':
      return validateAnthropic(env, rawKey, ctx);
    case 'voyage':
      return validateVoyage(env, rawKey, ctx);
    case 'cohere':
      return validateCohere(env, rawKey, ctx);
    case 'workers_ai':
      return { ok: true };
    default:
      return {
        ok: false,
        error_code: 'PROVIDER_KEY_VALIDATION_FAILED',
        error_message: `Unknown provider: ${provider}`,
      };
  }
}

async function validateOpenAI(
  env: Env,
  rawKey: string,
  ctx: ValidateContext,
): Promise<ValidationResult> {
  const r = resolve(env, {
    provider: 'openai',
    api_key: rawKey,
    request_metadata: {
      tenant_id: ctx.tenant_id,
      provider_key_id: ctx.provider_key_id,
    },
  });
  const res = await r.embedding!.embed(
    { model: 'text-embedding-3-small', input: ['ping'] },
    r.options,
  );
  return classify(res);
}

async function validateAnthropic(
  env: Env,
  rawKey: string,
  ctx: ValidateContext,
): Promise<ValidationResult> {
  const r = resolve(env, {
    provider: 'anthropic',
    api_key: rawKey,
    request_metadata: {
      tenant_id: ctx.tenant_id,
      provider_key_id: ctx.provider_key_id,
    },
  });
  const res = await r.llm!.chat(
    {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    },
    r.options,
  );
  return classify(res);
}

async function validateVoyage(
  env: Env,
  rawKey: string,
  ctx: ValidateContext,
): Promise<ValidationResult> {
  const r = resolve(env, {
    provider: 'voyage',
    api_key: rawKey,
    request_metadata: {
      tenant_id: ctx.tenant_id,
      provider_key_id: ctx.provider_key_id,
    },
  });
  const res = await r.rerank!.rerank(
    { model: 'rerank-2', query: 'ping', documents: ['hello'] },
    r.options,
  );
  return classify(res);
}

async function validateCohere(
  env: Env,
  rawKey: string,
  ctx: ValidateContext,
): Promise<ValidationResult> {
  const r = resolve(env, {
    provider: 'cohere',
    api_key: rawKey,
    request_metadata: {
      tenant_id: ctx.tenant_id,
      provider_key_id: ctx.provider_key_id,
    },
  });
  const res = await r.rerank!.rerank(
    { model: 'rerank-english-v3.0', query: 'ping', documents: ['hello'] },
    r.options,
  );
  return classify(res);
}

function classify(res: ProviderResult<unknown>): ValidationResult {
  if (res.outcome === 'success' || res.outcome === 'degraded_success') {
    return { ok: true };
  }
  const err = res.error;
  return {
    ok: false,
    error_code: errorCodeFor(err),
    ...(err.safe_upstream_message ? { error_message: err.safe_upstream_message } : {}),
  };
}

function errorCodeFor(err: ProviderError): string {
  switch (err.type) {
    case 'invalid_api_key':
      return 'PROVIDER_KEY_INVALID';
    case 'insufficient_quota':
      return 'PROVIDER_QUOTA_EXHAUSTED';
    case 'rate_limit':
      return 'PROVIDER_RATE_LIMITED';
    case 'timeout':
      return 'PROVIDER_TIMEOUT';
    case 'server_error':
    case 'network':
      return 'PROVIDER_UNAVAILABLE';
    case 'unsupported_model':
      return 'PROVIDER_UNSUPPORTED_MODEL';
    case 'context_length_exceeded':
      return 'CONTEXT_LENGTH_EXCEEDED';
    case 'refusal':
      return 'PROVIDER_REFUSAL';
    case 'malformed_response':
    case 'schema_violation':
    case 'partial_batch':
      return 'PROVIDER_MALFORMED_RESPONSE';
    case 'bad_request':
    case 'unknown':
    default:
      return 'PROVIDER_KEY_VALIDATION_FAILED';
  }
}
