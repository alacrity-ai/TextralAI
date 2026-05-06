// Provider abstraction — public types.
//
// Every external LLM/embedding/rerank call returns a `ProviderResult<T>`.
// Concrete provider implementations classify upstream errors into one of
// the four outcomes; the rest of the codebase pattern-matches on
// `result.outcome` and never sees a raw thrown exception from fetch.

/** The four-outcome model. Every provider call produces exactly one. */
export type ProviderResult<T> =
  | { outcome: 'success'; value: T; meta: ProviderMeta }
  | { outcome: 'degraded_success'; value: T; warning: ProviderError; meta: ProviderMeta }
  | { outcome: 'retryable_error'; error: ProviderError; meta: ProviderMeta }
  | { outcome: 'fatal_error'; error: ProviderError; meta: ProviderMeta };

export type ProviderErrorType =
  // 401 / auth
  | 'invalid_api_key'
  // 429
  | 'rate_limit' // transient, retryable
  | 'insufficient_quota' // permanent, fatal
  // 4xx
  | 'bad_request'
  | 'context_length_exceeded'
  | 'unsupported_model'
  // 5xx / network
  | 'server_error'
  | 'timeout'
  | 'network'
  // shape problems
  | 'malformed_response'
  | 'schema_violation'
  | 'partial_batch'
  | 'refusal'
  // catch-all
  | 'unknown';

export interface ProviderError {
  type: ProviderErrorType;
  provider: string; // 'openai' | 'anthropic' | 'workers_ai' | ...
  model: string;
  status?: number; // upstream HTTP status if any
  upstream_code?: string; // upstream error.code (e.g., 'insufficient_quota')
  /** Sanitized upstream message. Concrete providers MUST pipe upstream
   *  body strings through Phase 1.6 `redact()` before assigning. The
   *  renamed field makes the contract obvious at every read site —
   *  never echo provider keys / Authorization / x-api-key. */
  safe_upstream_message?: string;
  retry_count: number;
  retry_after_ms?: number; // honored when present (Retry-After header)
}

export interface ProviderMeta {
  provider: string;
  model: string;
  latency_ms: number;
  retry_count: number;
  via_gateway: boolean;
  request_id?: string; // upstream's id, if any
  tokens?: { input: number; output: number };
}

// ── Inputs ──────────────────────────────────────────────────────────────

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: ResponseFormat;
  stop?: string[];
}

export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'developer'; content: string }; // OpenAI-style developer prompt

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; schema: object; name?: string; strict?: boolean };

export interface EmbeddingRequest {
  model: string;
  input: string[];
  /** Optional output-dimension override. OpenAI text-embedding-3-* and
   *  Voyage support this. The Worker requires the resulting vectors to
   *  match the deploy's Vectorize index width (1536 for openai-large). */
  dimensions?: number;
}

export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;
}

// ── Outputs ─────────────────────────────────────────────────────────────

export interface ChatResponse {
  content: string;
  parsed?: unknown; // when response_format is json_*
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  finish_reason: 'stop' | 'length' | 'tool_use' | 'content_filter' | 'other';
}

export interface EmbeddingResponse {
  vectors: number[][];
  model: string;
  usage: { input_tokens: number };
}

export interface RerankResponse {
  results: { index: number; score: number }[];
  model: string;
}

export interface TokenEvent {
  type: 'token' | 'usage' | 'done' | 'error';
  delta?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: ProviderError;
}

// ── Provider call options ───────────────────────────────────────────────

/** Allowed value shapes for AI Gateway metadata. Coerced to strings via
 *  `String(v)` at emission time; only allowlisted keys are forwarded. */
export type AigMetadataValue = string | number | boolean | null;

export interface GatewayConfig {
  /** Pre-built base URL up to but not including the provider segment.
   *  CF runtime: `https://gateway.ai.cloudflare.com/v1/{acct}/{gw}`.
   *  Node runtime: whatever `AI_GATEWAY_BASE_URL` provides (e.g. a
   *  LiteLLM / Helicone / Helicone-compatible proxy URL). */
  base_url: string;
  /** Header prefix for tagging per-request metadata. CF: `cf-aig-`
   *  (Cloudflare AI Gateway's contract). Node: `x-aig-` (generic). */
  metadata_header_prefix: 'cf-aig-' | 'x-aig-';
  // Provider segment in URL form. The CF runtime dash-cases
  // (`workers_ai → workers-ai`) because Cloudflare's AI Gateway path
  // expects dashes; the Node runtime is generally permissive. The
  // type stays string-typed (was a literal union pre-Phase-2)
  // because non-CF proxies may accept arbitrary provider segments.
  provider: string;
}

/**
 * Per-call options.
 *
 * - `api_key` is OPTIONAL. The Workers AI binding tier has no key, and
 *   the resolver returns `api_key` explicitly omitted there. External
 *   providers throw at call time if the key is missing, surfacing as
 *   `invalid_api_key` via `classifyByStatus(401)`.
 * - `request_metadata` accepts coercible primitives; only allowlisted
 *   keys flow into the `cf-aig-metadata` header.
 */
export interface ProviderOptions {
  api_key?: string;
  base_url?: string; // overridden by AI Gateway routing
  gateway?: GatewayConfig;
  request_metadata?: Record<string, AigMetadataValue>;
  signal?: AbortSignal;
}

// ── The interfaces themselves ───────────────────────────────────────────

export interface LLMProvider {
  /** Public — display name used in telemetry + logs + AI Gateway tags. */
  readonly name: string;
  chat(req: ChatRequest, opts: ProviderOptions): Promise<ProviderResult<ChatResponse>>;
  stream(req: ChatRequest, opts: ProviderOptions): AsyncIterable<TokenEvent>;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(req: EmbeddingRequest, opts: ProviderOptions): Promise<ProviderResult<EmbeddingResponse>>;
  dimensions(model: string): number;
}

export interface RerankProvider {
  readonly name: string;
  rerank(req: RerankRequest, opts: ProviderOptions): Promise<ProviderResult<RerankResponse>>;
}

// ── Telemetry event ─────────────────────────────────────────────────────

export interface ProviderTelemetryEvent {
  outcome: ProviderResult<unknown>['outcome'];
  provider: string;
  model: string;
  latency_ms: number;
  retry_count: number;
  via_gateway: boolean;
  error_type?: ProviderErrorType;
  tenant_id?: string; // resolved upstream from cf-aig-metadata, if present
  query_event_id?: string;
  request_id?: string;
}
