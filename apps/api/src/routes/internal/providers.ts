// Worker-owned embedding + chat endpoints.
//
// Replaces the would-have-been /internal/secrets/resolve. Provider keys
// never leave the Worker; the Container POSTs here, and the Worker:
//   1. Loads the job + resolves the provider key.
//   2. Invokes the Phase 2 provider via resolve(env, ...).
//   3. Returns the result.
//
// /embed is consumed by the Container's chunk-embedding stage. /chat is
// consumed by enrichment passes via the runner's chat callable.

import { Hono } from 'hono';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../../types.js';
import { internalAuth } from '../../middleware/internal-auth.js';
import { getJobByIdAny } from '../../db/jobs.js';
import { resolveProviderKey } from '../../auth/provider-key-resolver.js';
import { resolve as resolveProvider } from '../../providers/registry.js';
import { providerKeySecretName } from '../../lib/secrets-store.js';
import { recordEmbeddingTokens } from '../../observability/usage.js';

export const internalProvidersRoute = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();
internalProvidersRoute.use('*', internalAuth);

internalProvidersRoute.onError((err, c) => {
  if (err instanceof TextralError) {
    return c.json(
      err.toEnvelope(c.get('request_id')),
      err.httpStatus as 400 | 401 | 403 | 404 | 500,
    );
  }
  console.error('internal_providers_unhandled_error', { message: err.message });
  return c.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, 500);
});

interface EmbedRequest {
  job_id: string;
  input: string[];
}

interface EmbedResponse {
  vectors: number[][];
  request_id: string | null;
  usage: { input_tokens: number };
  dimensions: number;
}

internalProvidersRoute.post('/embed', async (c) => {
  const body = (await c.req.json()) as EmbedRequest;
  const job = await getJobByIdAny(c.env.db, body.job_id);
  if (!job) throw new TextralError('NOT_FOUND', 404, 'Ingestion job not found');
  if (!Array.isArray(body.input) || body.input.length === 0) {
    throw new TextralError('BAD_REQUEST', 400, 'input must be a non-empty array');
  }

  const config = JSON.parse(job.config_json) as {
    embedding: { provider: string; model: string; dimensions: number; provider_key_id: string };
  };
  const { provider, model, dimensions, provider_key_id } = config.embedding;

  // Resolve raw key (workers_ai sentinel → no key).
  let rawKey: string | undefined;
  if (provider !== 'workers_ai') {
    const r = await resolveProviderKey(
      c.env,
      job.tenant_id,
      { kind: 'id', provider, id: provider_key_id },
      { include_raw: true },
    );
    rawKey = r?.raw_key;
  }

  // Embed via Phase 2 provider abstraction.
  const r = resolveProvider(c.env, {
    provider,
    ...(rawKey ? { api_key: rawKey } : {}),
    request_metadata: {
      tenant_id: job.tenant_id,
      provider_key_id: provider_key_id,
      job_id: job.id,
    },
  });
  if (!r.embedding) {
    throw new TextralError(
      'PROVIDER_UNSUPPORTED_MODEL',
      400,
      `Provider ${provider} has no embedding implementation`,
    );
  }
  const result = await r.embedding.embed(
    { model, input: body.input, dimensions },
    r.options,
  );

  if (result.outcome === 'fatal_error' || result.outcome === 'retryable_error') {
    return c.json(
      {
        error: {
          code: errorCodeFor(result.error.type),
          message: result.error.safe_upstream_message ?? `Provider error: ${result.error.type}`,
          details: {
            provider_error_type: result.error.type,
            outcome: result.outcome,
            upstream_status: result.error.status ?? null,
          },
        },
      },
      // Surface fatal as 422 (unprocessable; e.g. invalid_api_key,
      // insufficient_quota); transient as 503.
      result.outcome === 'fatal_error' ? 422 : 503,
    );
  }

  // success or degraded_success
  const value = result.value;
  // Verify declared dimensions match what we got.
  if (value.vectors.length > 0 && value.vectors[0]!.length !== dimensions) {
    throw new TextralError(
      'PROVIDER_MALFORMED_RESPONSE',
      400,
      `Embedding dimensions mismatch: declared ${dimensions}, got ${value.vectors[0]!.length}`,
    );
  }

  const response: EmbedResponse = {
    vectors: value.vectors,
    request_id: result.meta.request_id ?? null,
    usage: value.usage,
    dimensions,
  };

  // Phase 6.7 cost rollup — per-batch embedding token accumulation.
  // The job-completion transition adds the `ingestion_jobs+=1` bump.
  c.env.bg.spawn(
    recordEmbeddingTokens(c.env, job.tenant_id, {
      embedding_tokens: value.usage.input_tokens,
    }).catch((e: unknown) => {
      console.error('usage_record_embed_failed', { message: (e as Error).message });
    }),
  );

  return c.json(response, 200);
});

interface ChatRequest {
  job_id: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'developer'; content: string }>;
  model_override: {
    provider: string;
    model: string;
    provider_key_ref?: string;
  };
  max_tokens?: number;
  temperature?: number;
  response_format?:
    | { type: 'text' }
    | { type: 'json_object' }
    | { type: 'json_schema'; schema: object; name?: string; strict?: boolean };
  stop?: string[];
}

interface ChatHttpResponse {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  finish_reason: string;
  request_id: string | null;
}

internalProvidersRoute.post('/chat', async (c) => {
  const body = (await c.req.json()) as ChatRequest;
  if (!body.job_id) {
    throw new TextralError('BAD_REQUEST', 400, 'job_id required');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new TextralError('BAD_REQUEST', 400, 'messages must be a non-empty array');
  }
  if (!body.model_override?.provider || !body.model_override?.model) {
    throw new TextralError('BAD_REQUEST', 400, 'model_override.provider and model required');
  }

  const job = await getJobByIdAny(c.env.db, body.job_id);
  if (!job) throw new TextralError('NOT_FOUND', 404, 'Ingestion job not found');

  const { provider, model, provider_key_ref } = body.model_override;

  // Resolve raw key. workers_ai short-circuits; for everything else the
  // runner is expected to pass a provider_key_ref (set by profile or
  // request override). No ref + non-workers_ai is a config error.
  let rawKey: string | undefined;
  let providerKeyId: string | undefined;
  if (provider !== 'workers_ai') {
    const r = await resolveProviderKey(
      c.env,
      job.tenant_id,
      { kind: 'optional_ref', provider, ref: provider_key_ref },
      { include_raw: true },
    );
    if (!r) {
      throw new TextralError(
        'BAD_REQUEST',
        400,
        `Provider ${provider} requires provider_key_ref in model_override`,
      );
    }
    rawKey = r.raw_key;
    providerKeyId = r.id;
  }

  const r = resolveProvider(c.env, {
    provider,
    ...(rawKey ? { api_key: rawKey } : {}),
    request_metadata: {
      tenant_id: job.tenant_id,
      ...(providerKeyId ? { provider_key_id: providerKeyId } : {}),
      job_id: job.id,
    },
  });
  if (!r.llm) {
    throw new TextralError(
      'PROVIDER_UNSUPPORTED_MODEL',
      400,
      `Provider ${provider} has no chat implementation`,
    );
  }
  const result = await r.llm.chat(
    {
      model,
      messages: body.messages,
      ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.response_format ? { response_format: body.response_format } : {}),
      ...(body.stop ? { stop: body.stop } : {}),
    },
    r.options,
  );

  if (result.outcome === 'fatal_error' || result.outcome === 'retryable_error') {
    return c.json(
      {
        error: {
          code: errorCodeFor(result.error.type),
          message: result.error.safe_upstream_message ?? `Provider error: ${result.error.type}`,
          details: {
            provider_error_type: result.error.type,
            outcome: result.outcome,
            upstream_status: result.error.status ?? null,
          },
        },
      },
      result.outcome === 'fatal_error' ? 422 : 503,
    );
  }

  const value = result.value;
  const response: ChatHttpResponse = {
    content: value.content,
    usage: value.usage,
    model: value.model,
    finish_reason: value.finish_reason,
    request_id: result.meta.request_id ?? null,
  };
  return c.json(response, 200);
});

function errorCodeFor(type: string): string {
  switch (type) {
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
    case 'malformed_response':
    case 'partial_batch':
      return 'PROVIDER_MALFORMED_RESPONSE';
    default:
      return 'PROVIDER_UNAVAILABLE';
  }
}

void providerKeySecretName; // referenced here for lint stability
