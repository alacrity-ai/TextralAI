// OpenAI-compatible provider (OpenAI / Workers AI compat / OpenRouter).
//
// One class, parameterized by `direct_base_url`. The same instance type
// serves OpenAI-direct (`https://api.openai.com/v1`) and the Workers AI
// compat endpoint (`https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1`).
// Models are passed per-request — the class holds no per-model state.
//
// All fatal-vs-retryable dispatch + retry loop + telemetry emission is
// owned by the `ProviderHttpClient` base class. Concrete methods just
// describe `call`, `parseSuccess`, and `classifyError` callbacks.

import { ProviderHttpClient } from './lib/http-client.js';
import { readSseEvents } from './lib/sse.js';
import { classifyOpenAIError, parseRetryAfter } from './error-classification.js';
import { redact } from '../middleware/redaction.js';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
  LLMProvider,
  ProviderError,
  ProviderOptions,
  ProviderResult,
  ResponseFormat,
  TokenEvent,
} from './types.js';

export interface OpenAICompatConfig {
  /** Display name; e.g. 'openai', 'workers_ai_compat', 'openrouter'. */
  name: string;
  /** Direct base URL when AI Gateway is bypassed. May be a function so
   *  e.g. Workers AI compat can interpolate the account ID per call. */
  direct_base_url: string | ((model: string) => string);
}

export class OpenAICompatProvider
  extends ProviderHttpClient
  implements LLMProvider, EmbeddingProvider
{
  public override readonly name: string;
  private readonly directUrl: string | ((model: string) => string);

  constructor(cfg: OpenAICompatConfig) {
    super();
    this.name = cfg.name;
    this.directUrl = cfg.direct_base_url;
  }

  protected directBaseUrl(model: string): string {
    return typeof this.directUrl === 'function' ? this.directUrl(model) : this.directUrl;
  }

  dimensions(model: string): number {
    switch (model) {
      case 'text-embedding-3-large':
        return 3072;
      case 'text-embedding-3-small':
        return 1536;
      case 'text-embedding-ada-002':
        return 1536;
      case '@cf/baai/bge-large-en-v1.5':
        return 1024;
      case '@cf/baai/bge-base-en-v1.5':
        return 768;
      default:
        throw new Error(`Unknown embedding dimensions for model: ${model}`);
    }
  }

  async chat(req: ChatRequest, opts: ProviderOptions): Promise<ProviderResult<ChatResponse>> {
    return this.withRetries<ChatResponse>({
      model: req.model,
      timeoutMs: 30_000,
      opts,
      call: () => this.post(req.model, 'chat/completions', this.buildChatBody(req), opts, 30_000),
      parseSuccess: (res, attempt) => this.parseChatResponse(req, res.body, attempt),
      classifyError: (res, attempt) => this.errFromResponse(req.model, res, attempt),
    });
  }

  async embed(
    req: EmbeddingRequest,
    opts: ProviderOptions,
  ): Promise<ProviderResult<EmbeddingResponse>> {
    return this.withRetries<EmbeddingResponse>({
      model: req.model,
      timeoutMs: 60_000,
      opts,
      call: () =>
        this.post(
          req.model,
          'embeddings',
          {
            model: req.model,
            input: req.input,
            ...(req.dimensions ? { dimensions: req.dimensions } : {}),
          },
          opts,
          60_000,
        ),
      parseSuccess: (res, attempt) => this.parseEmbeddingResponse(req, res.body, attempt),
      classifyError: (res, attempt) => this.errFromResponse(req.model, res, attempt),
    });
  }

  /** Streaming chat. Streaming does not retry — once we've started
   *  emitting tokens to a consumer, we cannot rewind. A mid-stream
   *  failure yields a single `'error'` TokenEvent and ends. */
  async *stream(req: ChatRequest, opts: ProviderOptions): AsyncIterable<TokenEvent> {
    const { url } = this.resolveBaseUrl(req.model, opts);
    const headers = this.buildHeaders(opts);
    let res: Response;
    try {
      res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...this.buildChatBody(req), stream: true }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      yield {
        type: 'error',
        error: {
          type: 'network',
          provider: this.name,
          model: req.model,
          retry_count: 0,
          safe_upstream_message: redact(String((e as Error)?.message ?? e)),
        },
      };
      return;
    }
    if (!res.ok || !res.body) {
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // leave null
      }
      const cls = classifyOpenAIError({ status: res.status, body: parsed, text });
      yield {
        type: 'error',
        error: {
          type: cls.type,
          provider: this.name,
          model: req.model,
          retry_count: 0,
          status: res.status,
          ...(cls.upstream_code ? { upstream_code: cls.upstream_code } : {}),
          ...(cls.upstream_message ? { safe_upstream_message: redact(cls.upstream_message) } : {}),
        },
      };
      return;
    }

    let totalIn = 0;
    let totalOut = 0;
    for await (const ev of readSseEvents(res.body)) {
      if (ev.data === '[DONE]') break;
      let chunk: {
        choices?: Array<{ delta?: { content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        yield { type: 'token', delta };
      }
      if (chunk.usage) {
        totalIn = chunk.usage.prompt_tokens ?? totalIn;
        totalOut = chunk.usage.completion_tokens ?? totalOut;
      }
    }
    yield { type: 'usage', usage: { input_tokens: totalIn, output_tokens: totalOut } };
    yield { type: 'done' };
  }

  // ── Body building ─────────────────────────────────────────────────────

  private buildChatBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0,
    };
    if (req.max_tokens != null) body.max_tokens = req.max_tokens;
    if (req.stop) body.stop = req.stop;
    if (req.response_format) {
      const encoded = this.encodeResponseFormat(req.response_format);
      if (encoded) body.response_format = encoded;
    }
    return body;
  }

  private encodeResponseFormat(rf: ResponseFormat): unknown | undefined {
    if (rf.type === 'text') return undefined;
    if (rf.type === 'json_object') return { type: 'json_object' };
    return {
      type: 'json_schema',
      json_schema: {
        name: rf.name ?? 'Response',
        strict: rf.strict ?? true,
        schema: rf.schema,
      },
    };
  }

  // ── Response parsing ──────────────────────────────────────────────────

  /** Returns either a successful `value` or a `ProviderError`. The base
   *  class decides retry-vs-fatal via `isFatal(error.type)`:
   *    - 'refusal' is FATAL (retrying is deterministic and wasteful).
   *    - 'schema_violation' is RETRYABLE (transient model variance).
   *    - 'malformed_response' (no `choices[0]`) is RETRYABLE.
   *    - Missing/malformed `usage` on a valid completion is a WARNING
   *      attached to a degraded_success. */
  private parseChatResponse(
    req: ChatRequest,
    body: unknown,
    attempt: number,
  ):
    | { ok: true; value: ChatResponse; warning?: ProviderError }
    | { ok: false; error: ProviderError } {
    const b = body as {
      choices?: Array<{
        message?: { content?: string; refusal?: unknown };
        finish_reason?: unknown;
      }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    const choice = b?.choices?.[0];
    if (!choice) {
      return {
        ok: false,
        error: {
          type: 'malformed_response',
          provider: this.name,
          model: req.model,
          retry_count: attempt,
        },
      };
    }
    if (choice.message?.refusal) {
      return {
        ok: false,
        error: {
          type: 'refusal',
          provider: this.name,
          model: req.model,
          retry_count: attempt,
          safe_upstream_message: redact(String(choice.message.refusal)),
        },
      };
    }
    const content = choice.message?.content ?? '';
    let parsed: unknown | undefined;
    if (req.response_format && req.response_format.type !== 'text') {
      try {
        parsed = JSON.parse(content);
      } catch {
        return {
          ok: false,
          error: {
            type: 'schema_violation',
            provider: this.name,
            model: req.model,
            retry_count: attempt,
          },
        };
      }
    }

    const usage = b?.usage;
    const usageMissing = !usage || typeof usage.prompt_tokens !== 'number';
    const value: ChatResponse = {
      content,
      ...(parsed === undefined ? {} : { parsed }),
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
      },
      model: b?.model ?? req.model,
      finish_reason: this.normalizeFinishReason(choice.finish_reason),
    };
    if (usageMissing) {
      return {
        ok: true,
        value,
        warning: {
          type: 'malformed_response',
          provider: this.name,
          model: req.model,
          retry_count: attempt,
          safe_upstream_message: 'usage missing on success response',
        },
      };
    }
    return { ok: true, value };
  }

  private parseEmbeddingResponse(
    req: EmbeddingRequest,
    body: unknown,
    attempt: number,
  ): { ok: true; value: EmbeddingResponse } | { ok: false; error: ProviderError } {
    const b = body as {
      data?: Array<{ embedding?: number[] }>;
      model?: string;
      usage?: { prompt_tokens?: number };
    } | null;
    const data = b?.data;
    if (!Array.isArray(data)) {
      return {
        ok: false,
        error: {
          type: 'malformed_response',
          provider: this.name,
          model: req.model,
          retry_count: attempt,
        },
      };
    }
    if (data.length !== req.input.length) {
      return {
        ok: false,
        error: {
          type: 'partial_batch',
          provider: this.name,
          model: req.model,
          retry_count: attempt,
          safe_upstream_message: `expected ${req.input.length}, got ${data.length}`,
        },
      };
    }
    const vectors: number[][] = [];
    for (const d of data) {
      if (!Array.isArray(d?.embedding)) {
        return {
          ok: false,
          error: {
            type: 'malformed_response',
            provider: this.name,
            model: req.model,
            retry_count: attempt,
            safe_upstream_message: 'embedding entry missing `embedding` array',
          },
        };
      }
      vectors.push(d.embedding);
    }
    return {
      ok: true,
      value: {
        vectors,
        model: b?.model ?? req.model,
        usage: { input_tokens: b?.usage?.prompt_tokens ?? 0 },
      },
    };
  }

  private errFromResponse(
    model: string,
    res: { status: number; body: unknown; text: string; headers: Headers },
    attempt: number,
  ): ProviderError {
    const cls = classifyOpenAIError({ status: res.status, body: res.body, text: res.text });
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    return {
      type: cls.type,
      provider: this.name,
      model,
      status: res.status,
      retry_count: attempt,
      ...(cls.upstream_code ? { upstream_code: cls.upstream_code } : {}),
      ...(cls.upstream_message ? { safe_upstream_message: redact(cls.upstream_message) } : {}),
      ...(retryAfter !== undefined ? { retry_after_ms: retryAfter } : {}),
    };
  }

  private normalizeFinishReason(r: unknown): ChatResponse['finish_reason'] {
    switch (r) {
      case 'stop':
      case 'length':
      case 'tool_use':
      case 'content_filter':
        return r;
      case 'tool_calls':
        return 'tool_use';
      default:
        return 'other';
    }
  }
}

/** Convenience instance for OpenAI-direct. */
export const openaiDirect = new OpenAICompatProvider({
  name: 'openai',
  direct_base_url: 'https://api.openai.com/v1',
});

/** Workers AI compat provider — interpolates the account ID at call time. */
export function makeWorkersAiCompat(accountId: string): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: 'workers_ai_compat',
    direct_base_url: () => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
  });
}
