// Anthropic provider.
//
// A separate class from the OpenAI-compat path because Anthropic's
// request/response shape diverges enough that overloading the compat
// class would be misleading. Same `ProviderResult` discipline.
//
// Auth: x-api-key + anthropic-version (NOT Authorization: Bearer).
// Structured output: single forced tool call (Anthropic's canonical pattern).
// Streaming: native named-event SSE (`message_start`, `content_block_delta`,
// `message_stop`, etc.) — mapped to the normalized TokenEvent shape.
//
// CONTENT POLICY: for structured Anthropic responses, `parsed` (from the
// tool_use block) is authoritative. `content` may legitimately be empty
// when only a tool_use block is returned. Downstream code that treats
// `content === ''` as failure would be wrong here. Always check
// `parsed` first when a structured schema was requested.

import { ProviderHttpClient } from './lib/http-client.js';
import { readSseEvents } from './lib/sse.js';
import { classifyAnthropicError, parseRetryAfter } from './error-classification.js';
import { redact } from '../middleware/redaction.js';
import { buildAigMetadata, gatewayMetadataHeader } from './ai-gateway.js';
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ProviderError,
  ProviderOptions,
  ProviderResult,
  TokenEvent,
} from './types.js';

interface AnthropicSuccessBody {
  content?: Array<
    { type: 'text'; text: string } | { type: 'tool_use'; name?: string; input?: unknown }
  >;
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicProvider extends ProviderHttpClient implements LLMProvider {
  public override readonly name = 'anthropic';

  protected directBaseUrl(_model: string): string {
    return 'https://api.anthropic.com';
  }

  /** Anthropic auth + version live in headers other than Authorization. */
  protected override buildHeaders(opts: ProviderOptions): Headers {
    const h = new Headers({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    });
    if (opts.api_key) h.set('x-api-key', opts.api_key);
    if (opts.gateway && opts.request_metadata) {
      h.set(gatewayMetadataHeader(opts.gateway), buildAigMetadata(opts.request_metadata));
    }
    return h;
  }

  async chat(req: ChatRequest, opts: ProviderOptions): Promise<ProviderResult<ChatResponse>> {
    return this.withRetries<ChatResponse>({
      model: req.model,
      timeoutMs: 30_000,
      opts,
      call: () => this.post(req.model, 'v1/messages', this.buildBody(req), opts, 30_000),
      parseSuccess: (res, attempt) => this.parseChatResponse(req, res.body, attempt),
      classifyError: (res, attempt) => {
        const cls = classifyAnthropicError({
          status: res.status,
          body: res.body,
          text: res.text,
        });
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        return {
          type: cls.type,
          provider: this.name,
          model: req.model,
          status: res.status,
          retry_count: attempt,
          ...(cls.upstream_code ? { upstream_code: cls.upstream_code } : {}),
          ...(cls.upstream_message ? { safe_upstream_message: redact(cls.upstream_message) } : {}),
          ...(retryAfter !== undefined ? { retry_after_ms: retryAfter } : {}),
        };
      },
    });
  }

  async *stream(req: ChatRequest, opts: ProviderOptions): AsyncIterable<TokenEvent> {
    const { url } = this.resolveBaseUrl(req.model, opts);
    const headers = this.buildHeaders(opts);
    let res: Response;
    try {
      res = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...this.buildBody(req), stream: true }),
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
      const cls = classifyAnthropicError({ status: res.status, body: parsed, text });
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
      let chunk: {
        delta?: { type?: string; text?: string };
        usage?: { input_tokens?: number; output_tokens?: number };
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      };
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (ev.event === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        const text = chunk.delta.text;
        if (typeof text === 'string' && text.length > 0) {
          yield { type: 'token', delta: text };
        }
      } else if (ev.event === 'message_start' && chunk.message?.usage) {
        totalIn = chunk.message.usage.input_tokens ?? totalIn;
        totalOut = chunk.message.usage.output_tokens ?? totalOut;
      } else if (ev.event === 'message_delta' && chunk.usage) {
        totalIn = chunk.usage.input_tokens ?? totalIn;
        totalOut = chunk.usage.output_tokens ?? totalOut;
      } else if (ev.event === 'message_stop') {
        break;
      }
    }
    yield { type: 'usage', usage: { input_tokens: totalIn, output_tokens: totalOut } };
    yield { type: 'done' };
  }

  // ── Body building ─────────────────────────────────────────────────────

  private buildBody(req: ChatRequest): Record<string, unknown> {
    const sys = req.messages.find((m) => m.role === 'system');
    const turns = req.messages.filter((m) => m.role !== 'system' && m.role !== 'developer');

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.max_tokens ?? 1024,
      temperature: req.temperature ?? 0,
      messages: turns,
    };
    if (sys) body.system = sys.content;

    if (req.response_format?.type === 'json_schema') {
      const toolName = req.response_format.name ?? 'respond';
      body.tools = [
        {
          name: toolName,
          description: 'Respond with the structured object.',
          input_schema: req.response_format.schema,
        },
      ];
      body.tool_choice = { type: 'tool', name: toolName };
    } else if (req.response_format?.type === 'json_object') {
      // Anthropic has no native json_object mode; emulate via system suffix.
      const sysText = (body.system as string | undefined) ?? '';
      body.system = `${sysText}\n\nRespond ONLY with valid JSON. No prose.`.trim();
    }
    return body;
  }

  // ── Response parsing ──────────────────────────────────────────────────

  private parseChatResponse(
    req: ChatRequest,
    body: unknown,
    attempt: number,
  ):
    | { ok: true; value: ChatResponse; warning?: ProviderError }
    | { ok: false; error: ProviderError } {
    const b = body as AnthropicSuccessBody | null;
    const blocks = b?.content ?? [];
    let text = '';
    let parsed: unknown | undefined;
    for (const block of blocks) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') parsed = block.input;
    }
    if (req.response_format?.type === 'json_schema' && parsed === undefined) {
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
    if (req.response_format?.type === 'json_object' && parsed === undefined) {
      try {
        parsed = JSON.parse(text);
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
    const usageMissing = !usage || typeof usage.input_tokens !== 'number';
    const value: ChatResponse = {
      content: text,
      ...(parsed === undefined ? {} : { parsed }),
      usage: {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
      },
      model: b?.model ?? req.model,
      finish_reason: this.normalizeStop(b?.stop_reason),
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

  private normalizeStop(s: unknown): ChatResponse['finish_reason'] {
    switch (s) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_use';
      default:
        return 'other';
    }
  }
}

export const anthropic = new AnthropicProvider();
