// Provider registry — single source of truth for "given a provider name
// and a model, return the configured provider instance."
//
// Used by `/v1/provider-keys/:id/test` and (Phase 3+) the ingestion +
// query paths. AI Gateway routing lives here exclusively — concrete
// providers receive `opts.gateway` set by this resolver and never
// re-construct gateway state on their own.

import { TextralError } from '@textral/contracts';
import type { Env } from '../types.js';
import { openaiDirect } from './openai-compat.js';
import { anthropic } from './anthropic.js';
import { voyageRerank } from './voyage-rerank.js';
import { cohereRerank } from './cohere-rerank.js';
import { WorkersAIBindingProvider } from './workers-ai-binding.js';
import type {
  AigMetadataValue,
  EmbeddingProvider,
  GatewayConfig,
  LLMProvider,
  ProviderOptions,
  RerankProvider,
} from './types.js';

export type ProviderName = 'openai' | 'anthropic' | 'workers_ai' | 'voyage' | 'cohere';

export interface ResolveOptions {
  provider: ProviderName | string;
  /** Raw provider key (resolved from Secrets Store upstream). May be
   *  omitted for Workers AI binding tier. */
  api_key?: string;
  request_metadata?: Record<string, AigMetadataValue>;
}

export interface Resolved {
  llm?: LLMProvider;
  embedding?: EmbeddingProvider;
  rerank?: RerankProvider;
  options: ProviderOptions;
}

const SUPPORTED_PROVIDERS = new Set<ProviderName>([
  'openai',
  'anthropic',
  'workers_ai',
  'voyage',
  'cohere',
]);

export function resolve(env: Env, args: ResolveOptions): Resolved {
  if (!SUPPORTED_PROVIDERS.has(args.provider as ProviderName)) {
    throw new TextralError('PROVIDER_UNSUPPORTED_MODEL', 400, `Unknown provider: ${args.provider}`);
  }
  const gateway = computeGateway(env, args.provider);
  const opts: ProviderOptions = {
    ...(args.api_key !== undefined ? { api_key: args.api_key } : {}),
    ...(gateway ? { gateway } : {}),
    ...(args.request_metadata ? { request_metadata: args.request_metadata } : {}),
  };

  switch (args.provider as ProviderName) {
    case 'openai':
      return { llm: openaiDirect, embedding: openaiDirect, options: opts };
    case 'anthropic':
      return { llm: anthropic, options: opts };
    case 'workers_ai': {
      // V3 Phase 2: Workers AI is a CF-runtime-only binding. Self-host
      // deploys (`bindings.ai === undefined`) reject with a clean 501
      // and a remediation message — operators are BYOK for all
      // providers.
      if (!env.ai) {
        throw new TextralError(
          'PROVIDER_UNAVAILABLE',
          501,
          'Workers AI not available in this deploy. Self-hosted Textral ' +
            'requires BYOK for all providers.',
        );
      }
      const p = new WorkersAIBindingProvider(env.ai);
      return { llm: p, embedding: p, options: opts };
    }
    case 'voyage':
      return { rerank: voyageRerank, options: opts };
    case 'cohere':
      return { rerank: cohereRerank, options: opts };
  }
}

function computeGateway(env: Env, provider: string): GatewayConfig | undefined {
  // V3 Phase 2: gateway base URL + metadata-header prefix come from
  // `env.aiGateway` (built by the runtime adapter). When absent —
  // either because `AI_GATEWAY_BYPASS=true` on a CF deploy or
  // `AI_GATEWAY_BASE_URL` is unset on a Node deploy — providers
  // route direct.
  //
  // Note the snake/camel split: `env.aiGateway` (the `Bindings`
  // shape) uses `baseUrl`/`metadataHeaderPrefix` (camel — JS
  // convention), while `GatewayConfig` (consumed by providers,
  // including the metadata-header builder) uses
  // `base_url`/`metadata_header_prefix` (snake — matches the
  // wire-format conventions in providers/types.ts). The translation
  // here is intentional.
  if (!env.aiGateway) return undefined;
  return {
    base_url: env.aiGateway.baseUrl,
    metadata_header_prefix: env.aiGateway.metadataHeaderPrefix,
    provider: env.aiGateway.providerSegment(provider),
  };
}
