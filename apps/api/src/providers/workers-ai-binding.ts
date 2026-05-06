// Workers AI binding provider — the no-key tier.
//
// Calls `env.AI.run(...)` directly. No HTTP, no AI Gateway, no provider
// key required. The binding tier is rate-limited and metered against
// the platform account, not against a tenant-supplied key.
//
// Streaming through the binding is not implemented in MVP; consumers
// who need streaming should be routed through the Workers AI compat
// HTTP endpoint via `OpenAICompatProvider`.

import { redact } from '../middleware/redaction.js';
import type { WorkersAiBinding } from '../runtime/shared/interfaces.js';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
  LLMProvider,
  ProviderError,
  ProviderMeta,
  ProviderOptions,
  ProviderResult,
  TokenEvent,
} from './types.js';

interface WorkersAiChatResponse {
  response?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface WorkersAiEmbeddingResponse {
  data?: number[][];
  shape?: number[];
}

export class WorkersAIBindingProvider implements LLMProvider, EmbeddingProvider {
  public readonly name = 'workers_ai';

  constructor(private readonly ai: WorkersAiBinding) {}

  async chat(req: ChatRequest, _opts: ProviderOptions): Promise<ProviderResult<ChatResponse>> {
    const start = Date.now();
    try {
      const out = (await this.ai.run(req.model, {
        messages: req.messages,
        ...(req.max_tokens != null ? { max_tokens: req.max_tokens } : {}),
        temperature: req.temperature ?? 0,
        ...(req.response_format && req.response_format.type !== 'text'
          ? { response_format: req.response_format }
          : {}),
      })) as WorkersAiChatResponse;

      const content = out.response ?? out.choices?.[0]?.message?.content ?? '';
      let parsed: unknown | undefined;
      if (req.response_format && req.response_format.type !== 'text') {
        try {
          parsed = JSON.parse(content);
        } catch {
          return this.failure(
            req.model,
            {
              type: 'schema_violation',
              provider: this.name,
              model: req.model,
              retry_count: 0,
            },
            start,
          );
        }
      }
      const usage = out.usage;
      return {
        outcome: 'success',
        value: {
          content,
          ...(parsed === undefined ? {} : { parsed }),
          usage: {
            input_tokens: usage?.prompt_tokens ?? 0,
            output_tokens: usage?.completion_tokens ?? 0,
          },
          model: req.model,
          finish_reason: 'stop',
        },
        meta: this.buildMeta(req.model, start),
      };
    } catch (e) {
      return this.failure(
        req.model,
        {
          type: 'server_error',
          provider: this.name,
          model: req.model,
          retry_count: 0,
          safe_upstream_message: redact(String((e as Error)?.message ?? e)),
        },
        start,
      );
    }
  }

  async embed(
    req: EmbeddingRequest,
    _opts: ProviderOptions,
  ): Promise<ProviderResult<EmbeddingResponse>> {
    const start = Date.now();
    try {
      const out = (await this.ai.run(req.model, {
        text: req.input,
      })) as WorkersAiEmbeddingResponse;

      const vectors = out.data ?? [];
      if (!Array.isArray(vectors) || vectors.length !== req.input.length) {
        return this.failure(
          req.model,
          {
            type: 'partial_batch',
            provider: this.name,
            model: req.model,
            retry_count: 0,
            safe_upstream_message: `expected ${req.input.length}, got ${vectors.length}`,
          },
          start,
        );
      }
      return {
        outcome: 'success',
        value: { vectors, model: req.model, usage: { input_tokens: 0 } },
        meta: this.buildMeta(req.model, start),
      };
    } catch (e) {
      return this.failure(
        req.model,
        {
          type: 'server_error',
          provider: this.name,
          model: req.model,
          retry_count: 0,
          safe_upstream_message: redact(String((e as Error)?.message ?? e)),
        },
        start,
      );
    }
  }

  // Streaming via the binding is not implemented; route through the
  // OpenAI-compat HTTP endpoint instead.
  async *stream(req: ChatRequest, _opts: ProviderOptions): AsyncIterable<TokenEvent> {
    yield {
      type: 'error',
      error: {
        type: 'unknown',
        provider: this.name,
        model: req.model,
        retry_count: 0,
        safe_upstream_message:
          'Streaming via the Workers AI binding is not implemented. Use the OpenAI-compat HTTP path.',
      },
    };
  }

  dimensions(model: string): number {
    switch (model) {
      case '@cf/baai/bge-large-en-v1.5':
        return 1024;
      case '@cf/baai/bge-base-en-v1.5':
        return 768;
      case '@cf/baai/bge-small-en-v1.5':
        return 384;
      default:
        throw new Error(`Unknown Workers AI embedding dimensions: ${model}`);
    }
  }

  private buildMeta(model: string, start: number): ProviderMeta {
    return {
      provider: this.name,
      model,
      latency_ms: Date.now() - start,
      retry_count: 0,
      via_gateway: false,
    };
  }

  private failure(model: string, error: ProviderError, start: number): ProviderResult<never> {
    const meta = this.buildMeta(model, start);
    // The binding tier doesn't classify errors as fatal — a transient
    // platform issue can succeed on retry. Always surface as retryable
    // so the upstream caller can decide.
    return { outcome: 'retryable_error', error, meta };
  }
}
