# Phase 2 — Implementation Steps

> Companion to `docs/2-PHASES.md` Phase 2. Concrete, ordered steps for
> the provider abstraction layer.
>
> A dev should be able to follow this document end-to-end and finish
> Phase 2 without making design decisions or asking questions. Where
> the design left a choice open, this document picks one.

---

## Revisions applied per `PHASE_2_IMPLEMENTATION_FEEDBACK.md`

This doc has been revised to address every item in the feedback file.
Summary of accepted changes (the body has been edited in-line):

1. **Shared retry helper.** A `withRetries<T>()` method on
   `ProviderHttpClient` owns the retry loop, attempt counting, backoff,
   and fatal-vs-retryable dispatch. Concrete providers no longer
   duplicate `while (attempt < 3)` — they pass `call`, `classifyError`,
   and `parseSuccess` callbacks. (§2.3.3, applied across §2.4 / §2.6 / §2.7.)
2. **`resolveBaseUrl(model, opts)`** takes the model explicitly. The
   `'unused'` sentinel is gone. Workers AI compat URL interpolation
   becomes trivial. (§2.3.3.)
3. **Timeout + caller signal compose correctly.** The internal
   AbortController is always honored AND a caller-supplied
   `opts.signal` aborts it via an `'abort'` listener. `classifyThrown`
   distinguishes `'timeout'` vs caller cancellation. (§2.3.3.)
4. **Schema violations are `retryable_error`, not `fatal_error`.** A
   strict-mode JSON parse failure is usually transient model variance,
   not a permanent contract break. The provider's `withRetries` will
   re-attempt; only after exhausting retries do we surface the
   `retryable_error`. (§2.4.2.)
5. **`degraded_success` has explicit producer cases.** Listed in §2.1.1
   so reviewers see when the variant is allowed: missing `usage`
   on a valid completion, rerank returning fewer than `top_n` but ≥1,
   streaming completing without a final `usage` event.
6. **AI Gateway metadata accepts `string | number | boolean | null`** with
   coercion + an explicit allowlist of keys. No arbitrary metadata
   flows into gateway logs. (§2.3.2.)
7. **`name` is `public readonly`** on every provider, satisfying the
   public interface property. No `protected` overrides, no awkward
   casts. (§2.1.2 / all concrete providers.)
8. **`ProviderOptions.api_key` is optional**, and Workers AI binding
   docs the no-key path explicitly. (§2.1.2.)
9. **`gateway_provider` removed from `OpenAICompatConfig`.** Gateway
   routing lives in the registry only — single source of truth. (§2.4.1.)
10. **Anthropic structured-output content policy** documented:
    `parsed` is authoritative; `content` may be empty when only a
    `tool_use` block is returned. (§2.6.1.)
11. **Rerank response validation hardened.** Voyage / Cohere adapters
    reject malformed bodies (missing `data`, non-integer indexes,
    out-of-range indexes, duplicates). Adapters enforce score-order
    sort, not the test. (§2.7.)
12. **`/v1/provider-keys/:id/test` resolves by ID**, not by
    `(provider, label)`. Added `resolveProviderKeyById(env, tenantId, id)`
    helper. (§2.8.2.)
13. **`upstream_message` renamed to `safe_upstream_message`** to make
    the sanitization contract obvious at every read site. New tests
    (§2.10.4) verify provider keys / Authorization headers / x-api-key
    never appear in `ProviderError` or any log sink.
14. **`ProviderTelemetryEvent` shape and emission point defined**, even
    if Phase 2 only logs (Phase 6 dashboards consume the same shape). (§2.1.4.)
15. **Live-test latency assertions softened** to "successful response
    + recorded latency." p95 latency belongs in a nightly benchmark
    job, not in PR-blocking acceptance. (§2.10.2.)

---

**At completion, you will have:** a unified provider interface that
classifies every external LLM/embedding/rerank call into one of four
outcomes; concrete implementations for OpenAI-compatible, Workers AI
binding, Anthropic, Voyage rerank, and Cohere rerank providers; AI
Gateway routing wired into every external call with per-tenant
metadata tagging; a working `POST /v1/provider-keys/:id/test`
endpoint (the Phase 1.5 stub, finally lit up); and regression tests
that prove `insufficient_quota` and `invalid_api_key` never trigger
retry loops.

---

## Prerequisites

Phase 1 is closed. Specifically:
- Phase 1.5 is shipped with the `POST /v1/provider-keys/:id/test`
  endpoint stubbed at 501 — we light it up in Step 2.8.
- Phase 1.6 redaction middleware is wired in front of every route.
- `apps/api/src/auth/provider-keys.ts` exposes `resolveProviderKey()`
  but only the read side has been exercised so far.

You'll also need:
- An OpenAI API key registered in dev as a `provider_keys` row with
  `label='prod'`. (Use the seeded admin key + the routes from 1.5.3
  to register it.) Phase 2 tests reuse this registration.
- An Anthropic API key registered the same way (label='prod') for the
  Anthropic provider tests. Optional if you want to skip live
  Anthropic tests.
- A Voyage API key registered (label='prod') for rerank tests.
  Optional.

---

## Locked-in technology choices

These were left open in the phases doc; locking them now.

| Concern | Choice | Rationale |
|---------|--------|-----------|
| HTTP client | **`fetch` directly**, not `openai-node` | Smaller bundle, transparent error surface, easier to wrap with our retry/classification layer. Works in Workers natively. |
| SSE parser | **In-house, ~50 lines** | The provider SSE shapes are simple; a dependency would dwarf the parser. Lives in `src/providers/lib/sse.ts`. |
| Structured-output strategy (OpenAI) | **`response_format: json_schema` with `strict: true`** | The modern OpenAI structured-output path. Falls back to a one-shot parse retry on schema violation. |
| Structured-output strategy (Anthropic) | **Single forced tool call** | Anthropic's canonical structured-output pattern. |
| Structured-output strategy (Workers AI) | **JSON mode** via `response_format: { type: 'json_object' }` | The supported path on the Workers AI compat endpoint. |
| Streaming format | **OpenAI-style SSE** for OpenAI/Workers AI/OpenRouter, **native Anthropic event stream** for Anthropic | Each provider speaks its native protocol; we normalize at the `TokenEvent` interface boundary. |
| Retry policy | **3 attempts, exponential backoff base 500 ms (cap 4 s), jitter ±20%** | Sane defaults for retryable errors only — fatal errors never retry. |
| Per-call timeout | **30 s for chat, 60 s for embeddings batches, 8 s for rerank** | Embeddings batches can be large; rerank is fast. |
| AI Gateway header | **`cf-aig-metadata`** (JSON-encoded) | Cloudflare's standard tag-passing header. |
| Test mocking | **`vi.stubGlobal('fetch', ...)`** for outbound HTTP (Vitest 3.2.4) | Vitest native; no MSW dep. We pin Vitest 3.2.4 + `@cloudflare/vitest-pool-workers` 0.8.55 (per Phase 0.2.4). Vitest 4 + pool 0.15 don't compose. |
| Test scaffolding | **Reuse `test/helpers/fetch.ts`** + the `[env.test]` wrangler block + `test/setup.ts` from Phase 0.2.4 / 1.3 | Same patterns that lit up Phase 1. Phase 2 adds **per-suite stubs of `globalThis.fetch`** for outbound provider calls; the in-process Secrets Store helper (Phase 1.5) supplies the resolved provider key so the call stack is identical to production. |
| Live integration tests | **Gated by `RUN_LIVE_TESTS=1`** env var | Off by default in CI; on for nightly. |

---

## Naming and locations

```
apps/api/src/providers/
    types.ts              — ProviderResult, ProviderError, TokenEvent, etc.
    error-classification.ts
    lib/
        http-client.ts    — base class shared by every fetch-based provider
        sse.ts            — minimal SSE event reader
        backoff.ts        — exponential backoff + jitter
    ai-gateway.ts         — gateway URL builder + tag construction
    openai-compat.ts      — OpenAI / Workers AI compat / OpenRouter
    workers-ai-binding.ts — env.AI direct (no-key tier)
    anthropic.ts
    voyage-rerank.ts
    cohere-rerank.ts

packages/contracts/src/
    provider.ts           — Zod schemas for ChatRequest, EmbeddingRequest, RerankRequest
    error-codes.ts        — extended with PROVIDER_* codes
```

---

# Step 2.1 — Provider Result Type + Interfaces

**Goal:** Every provider call produces a `ProviderResult<T>`. No raw
`try/catch` around fetch in the rest of the codebase.

## 2.1.1 Provider result discriminated union

**Files**
- `apps/api/src/providers/types.ts`

**Contents**

```ts
// apps/api/src/providers/types.ts

/** The four-outcome model. Every provider call produces exactly one. */
export type ProviderResult<T> =
  | { outcome: 'success';          value: T;          meta: ProviderMeta }
  | { outcome: 'degraded_success'; value: T;          warning: ProviderError; meta: ProviderMeta }
  | { outcome: 'retryable_error';  error: ProviderError; meta: ProviderMeta }
  | { outcome: 'fatal_error';      error: ProviderError; meta: ProviderMeta };

export type ProviderErrorType =
  // 401 / auth
  | 'invalid_api_key'
  // 429
  | 'rate_limit'              // transient, retryable
  | 'insufficient_quota'      // permanent, fatal
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
  type:                   ProviderErrorType;
  provider:               string;        // 'openai' | 'anthropic' | 'workers_ai' | ...
  model:                  string;
  status?:                number;        // upstream HTTP status if any
  upstream_code?:         string;        // upstream error.code (e.g., 'insufficient_quota')
  /** Sanitized upstream message. Concrete providers MUST pipe upstream
   *  body strings through Phase 1.6 `redact()` before assigning. The
   *  renamed field makes the contract obvious at every read site (see
   *  feedback item 13 — never echo provider keys / Authorization /
   *  x-api-key). */
  safe_upstream_message?: string;
  retry_count:            number;
  retry_after_ms?:        number;        // honored when present (Retry-After header)
}

export interface ProviderMeta {
  provider:    string;
  model:       string;
  latency_ms:  number;
  retry_count: number;
  via_gateway: boolean;
  request_id?: string;                 // upstream's id, if any
  tokens?:     { input: number; output: number };
}
```

**Acceptance**
- `apps/api/src/providers/types.ts` compiles in isolation.
- A unit-test fixture builds each of the four `ProviderResult` variants
  and TypeScript narrows correctly inside an `if (result.outcome === ...)`
  branch.

---

## 2.1.2 Provider interfaces

**Files**
- `apps/api/src/providers/types.ts` (extended)

**Contents (high level)**

```ts
// — Inputs —
export interface ChatRequest {
  model:           string;
  messages:        ChatMessage[];
  max_tokens?:     number;
  temperature?:    number;
  response_format?: ResponseFormat;
  stop?:           string[];
}

export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'developer'; content: string };  // OpenAI-style developer prompt

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; schema: object; name?: string; strict?: boolean };

export interface EmbeddingRequest {
  model: string;
  input: string[];
}

export interface RerankRequest {
  model:     string;
  query:     string;
  documents: string[];
  top_n?:    number;
}

// — Outputs —
export interface ChatResponse {
  content:   string;
  parsed?:   unknown;            // when response_format is json_*
  usage:     { input_tokens: number; output_tokens: number };
  model:     string;
  finish_reason: 'stop' | 'length' | 'tool_use' | 'content_filter' | 'other';
}

export interface EmbeddingResponse {
  vectors: number[][];
  model:   string;
  usage:   { input_tokens: number };
}

export interface RerankResponse {
  results: { index: number; score: number }[];
  model:   string;
}

export interface TokenEvent {
  type: 'token' | 'usage' | 'done' | 'error';
  delta?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: ProviderError;
}

// — Provider call options —
//
// `api_key` is OPTIONAL: Workers AI (binding tier) has no key, and the
// resolver returns it explicitly omitted. External providers throw at
// call time if the key is missing, surfacing as `invalid_api_key`. See
// feedback item 8.
//
// `request_metadata` accepts coercible primitives (item 6); the
// constructor `buildAigMetadata` whitelists the keys it forwards.
export interface ProviderOptions {
  api_key?:          string;            // raw key, resolved upstream (omitted for binding tier)
  base_url?:         string;            // overridden by AI Gateway routing
  gateway?:          GatewayConfig;
  request_metadata?: Record<string, AigMetadataValue>;
  signal?:           AbortSignal;
}

export type AigMetadataValue = string | number | boolean | null;

export interface GatewayConfig {
  account_id: string;
  gateway_id: string;
  provider:   'openai' | 'anthropic' | 'workers-ai' | 'voyage' | 'cohere';
}

// — The interfaces themselves —
export interface LLMProvider {
  readonly name: string;     // public — feedback item 7
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
```

**Acceptance**
- All three interfaces declared.
- A no-op test creates a stub `LLMProvider` and TS infers correctly.

---

## 2.1.3 `degraded_success` — when each producer emits it

Per feedback item 5, `degraded_success` was defined but never produced
by any concrete provider. Phase 2 emits it in exactly these cases (and
no others):

| Producer | Condition |
|----------|-----------|
| OpenAICompatProvider.chat | response is valid + content is present, but `usage` field is missing or malformed. The text is returned; `usage` defaults to `{0, 0}`; warning carries `type: 'malformed_response'`. |
| OpenAICompatProvider.stream | stream completes without a final `usage` event. We yield `'usage'` with `{0, 0}` and emit a warning via the surrounding caller (Phase 4 query path picks it up). |
| VoyageRerankProvider / CohereRerankProvider | provider returned at least one result but fewer than `top_n`. |
| EmbeddingProvider | (none — partial batches stay `retryable_error`). |

Treat `degraded_success` as "use the result, log the warning,
surface the degradation in the response audit trail." Never retry on
`degraded_success`.

---

## 2.1.4 Provider telemetry event

Per feedback item 14. Every provider call — success, degraded, retryable,
fatal — emits one telemetry event. Phase 2 logs the event via
`console.info` (intercepted by the Phase 1.6 redaction layer); Phase 6
attaches it to Workers Analytics Engine.

```ts
export interface ProviderTelemetryEvent {
  outcome:        ProviderResult<unknown>['outcome'];
  provider:       string;
  model:          string;
  latency_ms:     number;
  retry_count:    number;
  via_gateway:    boolean;
  error_type?:    ProviderErrorType;
  tenant_id?:     string;     // resolved upstream from cf-aig-metadata, if present
  query_event_id?: string;
  request_id?:    string;
}

export function emitProviderTelemetry(ev: ProviderTelemetryEvent): void {
  // Single emission point. Phase 6 swaps to AE; redaction middleware
  // ensures no upstream key fragments leak.
  console.info('provider_call', ev);
}
```

`ProviderHttpClient.withRetries` (defined in §2.3.3) emits exactly one
event per call, **after** the result is finalized.

**Acceptance**
- Unit test asserts emission is called exactly once per successful call,
  exactly once per fatal_error (no per-attempt spam), exactly once per
  retries-exhausted retryable_error.

---

## 2.1.5 Contracts package additions

**Files**
- `packages/contracts/src/provider.ts`
- `packages/contracts/src/error-codes.ts` (extended)

**Contents (high level)**
- Zod schemas matching `ChatRequest`, `EmbeddingRequest`, `RerankRequest`,
  `ChatResponse`, `EmbeddingResponse`, `RerankResponse`. These are the
  forms the public API will accept and emit.
- Extended error code enum:

```ts
// packages/contracts/src/error-codes.ts (extended)
export const ErrorCode = z.enum([
  // … Phase 0/1 codes …
  'PROVIDER_KEY_INVALID',
  'PROVIDER_QUOTA_EXHAUSTED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REFUSAL',
  'PROVIDER_MALFORMED_RESPONSE',
  'PROVIDER_UNSUPPORTED_MODEL',
  'CONTEXT_LENGTH_EXCEEDED',
]);
```

**Acceptance**
```bash
pnpm --filter @textral/contracts typecheck
pnpm --filter @textral/contracts test     # provider schema parse round-trip tests
```

---

# Step 2.2 — Error Classification

**Goal:** A pure function turns any upstream HTTP response (or thrown
error) into a `ProviderError` with the correct `type`. The
`insufficient_quota` and `invalid_api_key` lessons from v1 are
encoded here as regression tests.

## 2.2.1 Generic classification helpers

**Files**
- `apps/api/src/providers/error-classification.ts`

**Contents (high level)**

```ts
// Two-stage classification:
//   1. By HTTP status (Phase 1 of triage)
//   2. By upstream error.code / error.type (Phase 2 — provider-specific)
//
// Each provider supplies its own provider-specific second-stage
// classifier. The first stage is generic.

export interface ClassificationContext {
  status: number;
  body:   unknown;     // already-parsed JSON or null
  text:   string;      // raw text fallback
  retry_after_header?: string | null;
}

export function classifyByStatus(ctx: ClassificationContext): ProviderErrorType {
  if (ctx.status === 401 || ctx.status === 403) return 'invalid_api_key';
  if (ctx.status === 408)                       return 'timeout';
  if (ctx.status === 429)                       return 'rate_limit';
  if (ctx.status >= 500 && ctx.status < 600)    return 'server_error';
  if (ctx.status >= 400 && ctx.status < 500)    return 'bad_request';
  return 'unknown';
}

export function isFatal(t: ProviderErrorType): boolean {
  switch (t) {
    case 'invalid_api_key':
    case 'insufficient_quota':
    case 'unsupported_model':
    case 'context_length_exceeded':
    case 'refusal':
      return true;
    case 'bad_request':
    case 'malformed_response':
    case 'schema_violation':
    case 'partial_batch':
    case 'rate_limit':
    case 'server_error':
    case 'timeout':
    case 'network':
    case 'unknown':
      return false;
  }
}

export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return;
  const n = Number(header);
  if (Number.isFinite(n)) return n * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return;
}
```

**Acceptance**
- Unit tests exhaustively assert the table:
  - `classifyByStatus({ status: 401, ... })` → `'invalid_api_key'`
  - `classifyByStatus({ status: 429, ... })` → `'rate_limit'`
  - `classifyByStatus({ status: 503, ... })` → `'server_error'`
  - `classifyByStatus({ status: 200, ... })` → `'unknown'` (caller
    should never call this on a 2xx).
- `isFatal('insufficient_quota')` → `true`; `isFatal('rate_limit')`
  → `false`; `isFatal('invalid_api_key')` → `true`.

---

## 2.2.2 OpenAI-shape classifier

**Files**
- `apps/api/src/providers/error-classification.ts` (extended)

**Contents (high level)**

```ts
// OpenAI / OpenAI-compatible (Workers AI compat, OpenRouter, Together).
// All return error bodies of the shape:
//   { error: { type, code, message, param } }
//
// The 429 ambiguity (transient throttle vs permanent quota) is
// resolved by inspecting `error.code`.
//
// REDACTION BOUNDARY: this helper returns the raw `upstream_message`
// from the upstream provider — that's its job. Every CALL SITE that
// turns this into a `ProviderError` MUST pipe `upstream_message`
// through Phase 1.6 `redact()` before assigning it to
// `safe_upstream_message`. The renamed field on ProviderError makes
// the boundary obvious. See §2.10.3 for the test that pins this.

export function classifyOpenAIError(ctx: ClassificationContext): {
  type: ProviderErrorType;
  upstream_code?: string;
  upstream_message?: string;
} {
  const errBody = (ctx.body as any)?.error;
  const code: string | undefined    = errBody?.code;
  const message: string | undefined = errBody?.message;

  // Stage 2: code-driven overrides over the status default.
  if (code === 'insufficient_quota') {
    return { type: 'insufficient_quota', upstream_code: code, upstream_message: message };
  }
  if (code === 'invalid_api_key' || code === 'invalid_request_error' && /api key/i.test(message ?? '')) {
    return { type: 'invalid_api_key', upstream_code: code, upstream_message: message };
  }
  if (code === 'context_length_exceeded') {
    return { type: 'context_length_exceeded', upstream_code: code, upstream_message: message };
  }
  if (code === 'model_not_found') {
    return { type: 'unsupported_model', upstream_code: code, upstream_message: message };
  }

  // Stage 1: fall back to status.
  return { type: classifyByStatus(ctx), upstream_code: code, upstream_message: message };
}
```

**Acceptance**
- Regression tests for the v1 incident:
  ```ts
  it('classifies HTTP 429 with code insufficient_quota as fatal, not retryable', () => {
    const r = classifyOpenAIError({
      status: 429,
      body: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota...' } },
      text: '',
    });
    expect(r.type).toBe('insufficient_quota');
    expect(isFatal(r.type)).toBe(true);
  });
  ```
- Same for `invalid_api_key` (HTTP 401 with `code: 'invalid_api_key'`).
- A plain HTTP 429 with no code falls through to `'rate_limit'`
  (retryable).

---

## 2.2.3 Anthropic-shape classifier

**Files**
- `apps/api/src/providers/error-classification.ts` (extended)

**Contents (high level)**

```ts
// Anthropic returns:
//   { type: "error", error: { type: "invalid_request_error" | "authentication_error" | "permission_error" | "not_found_error" | "request_too_large" | "rate_limit_error" | "api_error" | "overloaded_error", message } }

export function classifyAnthropicError(ctx: ClassificationContext): {
  type: ProviderErrorType;
  upstream_code?: string;
  upstream_message?: string;
} {
  const t  = (ctx.body as any)?.error?.type;
  const msg = (ctx.body as any)?.error?.message;

  switch (t) {
    case 'authentication_error': return { type: 'invalid_api_key',          upstream_code: t, upstream_message: msg };
    case 'permission_error':     return { type: 'invalid_api_key',          upstream_code: t, upstream_message: msg };
    case 'rate_limit_error':     return { type: 'rate_limit',               upstream_code: t, upstream_message: msg };
    case 'overloaded_error':     return { type: 'server_error',             upstream_code: t, upstream_message: msg };
    case 'request_too_large':    return { type: 'context_length_exceeded',  upstream_code: t, upstream_message: msg };
    case 'invalid_request_error': return { type: 'bad_request',             upstream_code: t, upstream_message: msg };
    case 'api_error':            return { type: 'server_error',             upstream_code: t, upstream_message: msg };
    case 'not_found_error':      return { type: 'unsupported_model',        upstream_code: t, upstream_message: msg };
    default:                     return { type: classifyByStatus(ctx),      upstream_code: t, upstream_message: msg };
  }
}
```

> Note: Anthropic does not surface a distinct "insufficient quota"
> code; over-quota requests come back as `rate_limit_error`. We map
> them as retryable, accepting that quota exhaustion will only be
> caught after retries exhaust. If consumer feedback flags this, we
> add string-matching on the message body in a later phase.

**Acceptance**
- Unit tests cover each Anthropic error type.

---

# Step 2.3 — Shared HTTP Client + AI Gateway Routing

**Goal:** A single base class every fetch-based provider extends.
Wraps fetch with retries + classification + AI Gateway routing.

## 2.3.1 Backoff helper

**Files**
- `apps/api/src/providers/lib/backoff.ts`

**Contents**

```ts
const BASE_MS = 500;
const CAP_MS  = 4_000;
const JITTER  = 0.20;

export function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs != null) return Math.min(retryAfterMs, CAP_MS * 2);
  const exp = Math.min(BASE_MS * 2 ** attempt, CAP_MS);
  const jitter = exp * JITTER * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); });
  });
}
```

**Acceptance**
- `backoffDelay(0)` returns 400-600 ms.
- `backoffDelay(10)` is capped at ≤ 4800 ms.
- `backoffDelay(0, 1500)` returns ≤ 8000 ms (= 2× cap, the only time
  we exceed the normal cap).

---

## 2.3.2 AI Gateway URL builder + metadata header

**Files**
- `apps/api/src/providers/ai-gateway.ts`

**Contents**

```ts
// AI Gateway base URL pattern:
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{provider}/{path...}
//
// Each provider's "path" is its native endpoint path, e.g.
// 'chat/completions' for OpenAI, 'v1/messages' for Anthropic.

export interface GatewayConfig {
  account_id: string;
  gateway_id: string;
  provider:   'openai' | 'anthropic' | 'workers-ai' | 'voyage' | 'cohere';
}

export function gatewayBaseUrl(cfg: GatewayConfig): string {
  return `https://gateway.ai.cloudflare.com/v1/${cfg.account_id}/${cfg.gateway_id}/${cfg.provider}`;
}

// Builds a per-tenant metadata header.
//
// Values are coerced to strings via `String(v)` so callers can pass
// numbers / booleans / null. Only allowlisted keys are forwarded —
// arbitrary metadata MUST NOT flow into gateway logs (feedback item 6).
const AIG_METADATA_ALLOWLIST = new Set([
  'tenant_id',
  'namespace_id',
  'document_id',
  'version_id',
  'query_event_id',
  'job_id',
  'request_id',
  'provider_key_id',
]);

import type { AigMetadataValue } from './types.js';

export function buildAigMetadata(parts: Record<string, AigMetadataValue>): string {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(parts)) {
    if (!AIG_METADATA_ALLOWLIST.has(k)) continue;
    if (v === null || v === undefined) continue;
    filtered[k] = String(v);
  }
  return JSON.stringify(filtered);
}
```

**Acceptance**
- `gatewayBaseUrl({ account_id: 'a', gateway_id: 'g', provider: 'openai' })`
  → `https://gateway.ai.cloudflare.com/v1/a/g/openai`
- `buildAigMetadata({ tenant_id: 'ten_x', namespace_id: 'ns_y' })`
  → `'{"tenant_id":"ten_x","namespace_id":"ns_y"}'`
- `buildAigMetadata({ tenant_id: 'ten_x', secret: 'shhh' })`
  → `'{"tenant_id":"ten_x"}'` (non-allowlisted keys dropped)
- `buildAigMetadata({ tenant_id: 42, debug: true })`
  → `'{"tenant_id":"42"}'` (booleans coerced; non-allowlisted dropped)

---

## 2.3.3 HTTP client base class — `post`, `withRetries`, signal composition

**Files**
- `apps/api/src/providers/lib/http-client.ts`

The base class owns:
- URL resolution (with the model in scope — feedback item 2),
- Header construction (Authorization + AI Gateway metadata),
- A `post()` that composes timeout + caller abort signals correctly
  (feedback item 3),
- A `withRetries<T>()` helper that owns the retry loop, attempt count,
  backoff, fatal-vs-retryable dispatch, AND the single
  `emitProviderTelemetry(...)` emission point (feedback items 1 + 14).

Concrete providers no longer write `while (attempt < 3)` loops — they
pass `call`, `parseSuccess`, and `classifyError` callbacks.

**Contents (full sketch)**

```ts
// apps/api/src/providers/lib/http-client.ts
import { backoffDelay, sleep } from './backoff.js';
import { gatewayBaseUrl, buildAigMetadata } from '../ai-gateway.js';
import { isFatal } from '../error-classification.js';
import { emitProviderTelemetry } from '../telemetry.js';
import type {
  ProviderError,
  ProviderResult,
  ProviderOptions,
  ProviderMeta,
} from '../types.js';

const MAX_ATTEMPTS = 3;

export interface PostResult {
  status:    number;
  body:      unknown;        // already-parsed JSON or null
  text:      string;         // raw text fallback
  headers:   Headers;
  latency_ms: number;
}

/** Compose the per-call timeout AbortController with a caller-supplied
 *  signal. EITHER expiring forces fetch to abort. We tag the timeout
 *  abort reason so `classifyThrown` can distinguish it from caller
 *  cancellation (feedback item 3). */
export function composeAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onCallerAbort = () => ctrl.abort(callerSignal?.reason ?? new Error('caller_aborted'));
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

export abstract class ProviderHttpClient {
  /** Public, per feedback item 7. Concrete classes set this with
   *  `public override readonly name = '...'`. */
  abstract readonly name: string;

  /** Receives the model so e.g. Workers AI compat can interpolate the
   *  account ID at call time. No `'unused'` sentinel (feedback item 2). */
  protected abstract directBaseUrl(model: string): string;

  protected resolveBaseUrl(
    model: string,
    opts: ProviderOptions,
  ): { url: string; via_gateway: boolean } {
    if (opts.gateway)  return { url: gatewayBaseUrl(opts.gateway),    via_gateway: true };
    if (opts.base_url) return { url: opts.base_url,                   via_gateway: false };
    return { url: this.directBaseUrl(model), via_gateway: false };
  }

  protected buildHeaders(opts: ProviderOptions): Headers {
    const h = new Headers({ 'content-type': 'application/json' });
    if (opts.api_key) h.set('authorization', `Bearer ${opts.api_key}`);
    if (opts.gateway && opts.request_metadata) {
      h.set('cf-aig-metadata', buildAigMetadata(opts.request_metadata));
    }
    return h;
  }

  protected async post(
    model: string,
    path: string,
    body: unknown,
    opts: ProviderOptions,
    timeoutMs: number,
  ): Promise<PostResult> {
    const { url } = this.resolveBaseUrl(model, opts);
    const { signal, cancel } = composeAbort(opts.signal, timeoutMs);
    const start = Date.now();
    try {
      const res = await fetch(`${url}/${path}`, {
        method: 'POST',
        headers: this.buildHeaders(opts),
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* leave null */ }
      return { status: res.status, body: parsed, text, headers: res.headers, latency_ms: Date.now() - start };
    } finally {
      cancel();
    }
  }

  /** Distinguishes timeout from caller cancellation. Concrete providers
   *  call this from their `withRetries(call=...)` thunk. */
  protected classifyThrown(e: unknown, model: string, attempt: number): ProviderError {
    const msg = String((e as { message?: unknown })?.message ?? e);
    const reason = (e as { reason?: { message?: unknown } })?.reason;
    const reasonMsg = String(reason?.message ?? '');
    const isTimeout = msg === 'timeout' || reasonMsg === 'timeout';
    const isCallerAbort = msg === 'caller_aborted' || reasonMsg === 'caller_aborted';
    return {
      type: isTimeout ? 'timeout' : isCallerAbort ? 'unknown' : 'network',
      provider: this.name, model, retry_count: attempt,
      safe_upstream_message: isCallerAbort ? 'caller cancelled' : msg,
    };
  }

  /**
   * Shared retry loop. Concrete providers pass:
   *   - `call(attempt)` — the actual fetch call (returns a PostResult or
   *     throws),
   *   - `parseSuccess(res)` — turns a 2xx PostResult into either a
   *     successful `value` or a synthesized `ProviderError` (e.g. malformed
   *     response, schema_violation). Errors here flow through the same
   *     fatal-vs-retryable dispatch as upstream HTTP errors.
   *   - `classifyError(res)` — turns a non-2xx PostResult into a
   *     ProviderError (provider-specific second-stage triage).
   *
   * `withRetries` owns: attempt counting, backoff sleeps, fatal short-circuit,
   * Retry-After honoring, telemetry emission, and the final ProviderResult
   * construction.
   */
  protected async withRetries<T>(args: {
    model: string;
    timeoutMs: number;
    opts: ProviderOptions;
    call: (attempt: number) => Promise<PostResult>;
    parseSuccess: (res: PostResult, attempt: number) => { ok: true; value: T; warning?: ProviderError } | { ok: false; error: ProviderError };
    classifyError: (res: PostResult, attempt: number) => ProviderError;
  }): Promise<ProviderResult<T>> {
    let attempt = 0;
    let lastErr: ProviderError | undefined;
    let lastLatency = 0;
    const startedAt = Date.now();

    while (attempt < MAX_ATTEMPTS) {
      let res: PostResult;
      try {
        res = await args.call(attempt);
        lastLatency = res.latency_ms;
      } catch (e) {
        const err = this.classifyThrown(e, args.model, attempt);
        if (isFatal(err.type)) return this.finalize<T>('fatal_error', { error: err, meta: this.buildMeta(args, attempt, lastLatency, false) });
        lastErr = err;
        attempt++;
        if (attempt >= MAX_ATTEMPTS) break;
        await sleep(backoffDelay(attempt - 1), args.opts.signal);
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        const parsed = args.parseSuccess(res, attempt);
        if (parsed.ok) {
          if (parsed.warning) {
            return this.finalize<T>('degraded_success', {
              value: parsed.value, warning: parsed.warning,
              meta: this.buildMeta(args, attempt, lastLatency, true),
            });
          }
          return this.finalize<T>('success', {
            value: parsed.value,
            meta: this.buildMeta(args, attempt, lastLatency, true),
          });
        }
        // parseSuccess produced an error — could be fatal (refusal) or
        // retryable (schema_violation). Same dispatch as HTTP errors.
        if (isFatal(parsed.error.type)) return this.finalize<T>('fatal_error', { error: parsed.error, meta: this.buildMeta(args, attempt, lastLatency, true) });
        lastErr = parsed.error;
        attempt++;
        if (attempt >= MAX_ATTEMPTS) break;
        await sleep(backoffDelay(attempt - 1), args.opts.signal);
        continue;
      }

      const err = args.classifyError(res, attempt);
      if (isFatal(err.type)) return this.finalize<T>('fatal_error', { error: err, meta: this.buildMeta(args, attempt, lastLatency, true) });
      lastErr = err;
      attempt++;
      if (attempt >= MAX_ATTEMPTS) break;
      await sleep(backoffDelay(attempt - 1, err.retry_after_ms), args.opts.signal);
    }

    void startedAt; // (kept for future "total elapsed including backoff" telemetry)
    return this.finalize<T>('retryable_error', {
      error: lastErr ?? { type: 'unknown', provider: this.name, model: args.model, retry_count: attempt },
      meta:  this.buildMeta(args, attempt, lastLatency, true),
    });
  }

  private buildMeta(
    args: { model: string; opts: ProviderOptions },
    attempt: number,
    latency: number,
    viaFetch: boolean,
  ): ProviderMeta {
    return {
      provider:    this.name,
      model:       args.model,
      latency_ms:  latency,
      retry_count: attempt,
      via_gateway: viaFetch && Boolean(args.opts.gateway),
    };
  }

  private finalize<T>(
    outcome: ProviderResult<T>['outcome'],
    base:
      | { value: T; warning?: ProviderError; meta: ProviderMeta }
      | { error: ProviderError; meta: ProviderMeta },
  ): ProviderResult<T> {
    // Single emission point — Phase 2.1.4. Subsequent phases attach to AE.
    emitProviderTelemetry({
      outcome,
      provider:    base.meta.provider,
      model:       base.meta.model,
      latency_ms:  base.meta.latency_ms,
      retry_count: base.meta.retry_count,
      via_gateway: base.meta.via_gateway,
      error_type:  'error' in base ? base.error.type : undefined,
    });
    if (outcome === 'success' && 'value' in base) {
      return { outcome, value: base.value, meta: base.meta };
    }
    if (outcome === 'degraded_success' && 'value' in base && base.warning) {
      return { outcome, value: base.value, warning: base.warning, meta: base.meta };
    }
    if ('error' in base) {
      return { outcome: outcome as 'retryable_error' | 'fatal_error', error: base.error, meta: base.meta };
    }
    throw new Error(`unreachable finalize variant: ${outcome}`);
  }
}
```

**Acceptance**
- Unit tests with mocked `globalThis.fetch`:
  - Posts to direct URL when no gateway given; `directBaseUrl(model)`
    receives the actual model.
  - Posts to gateway URL when gateway given; includes `cf-aig-metadata`.
  - Includes `Authorization: Bearer <key>` only when `api_key` is set
    (binding tier omits it).
  - **Caller cancellation aborts the in-flight fetch** — set
    `opts.signal` on a controller, abort it mid-call, observe fetch
    receives an aborted signal AND `classifyThrown` produces type `'unknown'`,
    not `'timeout'`.
  - **Timeout fires when caller signal is held open**: pass an
    unaborted caller signal + a 50 ms timeout, fetch a slow endpoint,
    observe `'timeout'` classification.
  - `withRetries` retries up to 3 times on retryable, short-circuits on
    fatal, emits exactly one telemetry event per call.

---

# Step 2.4 — OpenAI-Compatible Provider

**Goal:** One provider class (`OpenAICompatProvider`) handles OpenAI
direct, Workers AI compat endpoint, OpenRouter, and any future
OpenAI-shape provider. Supports chat (sync + streaming),
embeddings, and structured output.

## 2.4.1 Provider scaffold

**Files**
- `apps/api/src/providers/openai-compat.ts`

**Contents (high level)**

```ts
// One class, parameterized by directBaseUrl. The same class instance
// serves OpenAI-direct (https://api.openai.com/v1) and the Workers
// AI compat endpoint (https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1).
//
// Models are passed per-request. The class is stateless apart from
// configuration.

export interface OpenAICompatConfig {
  /** Display name; e.g. 'openai', 'workers_ai_compat', 'openrouter'. */
  name: string;
  /** Direct base URL when AI Gateway is bypassed (dev only). May be a
   *  function so e.g. Workers AI compat can interpolate the account ID
   *  per call (feedback item 2). */
  direct_base_url: string | ((model: string) => string);
  // `gateway_provider` removed (feedback item 9): gateway routing lives
  // in the registry only — single source of truth.
}

export class OpenAICompatProvider extends ProviderHttpClient implements LLMProvider, EmbeddingProvider {
  // Public + readonly, so concrete classes satisfy the public LLMProvider
  // interface without casts (feedback item 7).
  public override readonly name: string;
  private readonly directUrl: string | ((model: string) => string);

  constructor(cfg: OpenAICompatConfig) {
    super();
    this.name      = cfg.name;
    this.directUrl = cfg.direct_base_url;
  }

  protected directBaseUrl(model: string) {
    return typeof this.directUrl === 'function' ? this.directUrl(model) : this.directUrl;
  }

  // Embedding dimensions per model — kept minimal; extended in Phase 3.
  dimensions(model: string): number {
    switch (model) {
      case 'text-embedding-3-large':       return 3072;
      case 'text-embedding-3-small':       return 1536;
      case '@cf/baai/bge-large-en-v1.5':   return 1024;
      case '@cf/baai/bge-base-en-v1.5':    return 768;
      default: throw new Error(`Unknown embedding dimensions for model: ${model}`);
    }
  }

  // Methods chat, stream, embed implemented in 2.4.2 / 2.4.3 / 2.4.4.
}

// Convenience constructors. The Workers AI compat variant uses a
// function `direct_base_url` so the account ID is interpolated at call
// time — no `'unused'` sentinel anywhere.
export const openaiDirect = new OpenAICompatProvider({
  name: 'openai',
  direct_base_url: 'https://api.openai.com/v1',
});

export function makeWorkersAiCompat(accountId: string): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: 'workers_ai_compat',
    direct_base_url: () => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
  });
}
```

**Acceptance**
- Provider instances construct without errors.
- `dimensions('text-embedding-3-large')` returns `3072`.

---

## 2.4.2 Chat (sync) + structured output

**Files**
- `apps/api/src/providers/openai-compat.ts` (extended)

**Contents (high level)**

The retry loop is gone. `chat()` is now a thin wrapper around the base
class's `withRetries`. Schema violations classify as `retryable_error`
(feedback item 4); the base loop handles re-attempts automatically.
Refusals classify as `fatal_error`.

```ts
async chat(req: ChatRequest, opts: ProviderOptions): Promise<ProviderResult<ChatResponse>> {
  return this.withRetries<ChatResponse>({
    model: req.model,
    timeoutMs: 30_000,
    opts,
    call: () => this.post(req.model, 'chat/completions', this.buildChatBody(req), opts, 30_000),
    parseSuccess: (res, attempt) => this.parseChatResponse(req, res.body, attempt),
    classifyError: (res, attempt) => {
      const cls = classifyOpenAIError(res);
      return {
        type: cls.type, provider: this.name, model: req.model,
        status: res.status,
        upstream_code: cls.upstream_code,
        safe_upstream_message: redact(cls.upstream_message ?? ''),
        retry_count: attempt,
        retry_after_ms: parseRetryAfter(res.headers.get('retry-after')),
      };
    },
  });
}

private buildChatBody(req: ChatRequest): unknown {
  const body: any = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0,
  };
  if (req.max_tokens != null) body.max_tokens = req.max_tokens;
  if (req.stop) body.stop = req.stop;
  if (req.response_format) body.response_format = this.encodeResponseFormat(req.response_format);
  return body;
}

private encodeResponseFormat(rf: ResponseFormat): unknown {
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

/** Returns either a successful `value` or a `ProviderError`. The base
 *  class decides retry-vs-fatal via `isFatal(error.type)` — so:
 *    - 'refusal' is FATAL (no retry; refusals are deterministic).
 *    - 'schema_violation' is RETRYABLE (transient model variance — see
 *       feedback item 4 + isFatal table in error-classification.ts).
 *    - 'malformed_response' (no `choices[0]`) is RETRYABLE.
 *    - Missing/malformed `usage` on a valid completion is a WARNING
 *       attached to a degraded_success.
 */
private parseChatResponse(req: ChatRequest, body: any, attempt: number):
  | { ok: true; value: ChatResponse; warning?: ProviderError }
  | { ok: false; error: ProviderError } {
  const choice = body?.choices?.[0];
  if (!choice) {
    return { ok: false, error: {
      type: 'malformed_response', provider: this.name, model: req.model, retry_count: attempt,
    }};
  }
  if (choice.message?.refusal) {
    return { ok: false, error: {
      type: 'refusal', provider: this.name, model: req.model, retry_count: attempt,
      safe_upstream_message: redact(String(choice.message.refusal)),
    }};
  }
  const content = choice.message?.content ?? '';
  let parsed: unknown | undefined;
  if (req.response_format && req.response_format.type !== 'text') {
    try { parsed = JSON.parse(content); }
    catch {
      return { ok: false, error: {
        type: 'schema_violation', provider: this.name, model: req.model, retry_count: attempt,
      }};
    }
  }

  // degraded_success producer: usage is missing/malformed on an otherwise
  // valid response (feedback item 5).
  const usage = body.usage;
  const usageMissing = !usage || typeof usage.prompt_tokens !== 'number';
  const value: ChatResponse = {
    content, parsed,
    usage: {
      input_tokens:  usage?.prompt_tokens     ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
    model: body.model ?? req.model,
    finish_reason: this.normalizeFinishReason(choice.finish_reason),
  };
  if (usageMissing) {
    return { ok: true, value, warning: {
      type: 'malformed_response', provider: this.name, model: req.model,
      retry_count: attempt, safe_upstream_message: 'usage missing on success response',
    }};
  }
  return { ok: true, value };
}
```

> The `redact` import is the Phase 1.6 helper. EVERY upstream string
> that becomes `safe_upstream_message` MUST flow through it. Tests in
> §2.10.4 enforce this.

**Acceptance**
- Fixture-based unit tests for each path:
  - 200 with valid JSON content + `json_schema` → `success`, `parsed`
    matches the schema.
  - 200 with `message.refusal` → `fatal_error`, type `refusal`.
  - 200 with malformed JSON content → `fatal_error`, type
    `schema_violation`.
  - 429 with `code: 'insufficient_quota'` → `fatal_error`, type
    `insufficient_quota`. **No retries fired.** (regression test for
    the v1 bug).
  - 429 transient → retried up to 3 times → `retryable_error`.
  - 401 → `fatal_error`, type `invalid_api_key`. **No retries fired.**
  - 503 → retried up to 3 times → `retryable_error`.

---

## 2.4.3 Embeddings

**Files**
- `apps/api/src/providers/openai-compat.ts` (extended)

**Contents (high level)**

Same pattern as `chat()` — thin wrapper around `withRetries`. The
`parseSuccess` callback handles partial-batch detection (returns a
retryable error so the loop re-attempts).

```ts
async embed(req: EmbeddingRequest, opts: ProviderOptions): Promise<ProviderResult<EmbeddingResponse>> {
  return this.withRetries<EmbeddingResponse>({
    model: req.model,
    timeoutMs: 60_000,
    opts,
    call: () => this.post(req.model, 'embeddings',
      { model: req.model, input: req.input }, opts, 60_000),
    parseSuccess: (res, attempt) => {
      const data = (res.body as any)?.data;
      if (!Array.isArray(data)) {
        return { ok: false, error: {
          type: 'malformed_response', provider: this.name, model: req.model, retry_count: attempt,
        }};
      }
      if (data.length !== req.input.length) {
        return { ok: false, error: {
          type: 'partial_batch', provider: this.name, model: req.model, retry_count: attempt,
          safe_upstream_message: `expected ${req.input.length}, got ${data.length}`,
        }};
      }
      return { ok: true, value: {
        vectors: data.map((d: any) => d.embedding as number[]),
        model: (res.body as any).model ?? req.model,
        usage: { input_tokens: (res.body as any).usage?.prompt_tokens ?? 0 },
      }};
    },
    classifyError: (res, attempt) => {
      const cls = classifyOpenAIError(res);
      return {
        type: cls.type, provider: this.name, model: req.model,
        status: res.status,
        upstream_code: cls.upstream_code,
        safe_upstream_message: redact(cls.upstream_message ?? ''),
        retry_count: attempt,
        retry_after_ms: parseRetryAfter(res.headers.get('retry-after')),
      };
    },
  });
}
```

**Acceptance**
- Embedding 100 short texts via OpenAI returns 100 3072-dim vectors.
- A simulated partial-batch response (99 of 100) is retried; if both
  retries also return 99, the result is `retryable_error` with
  `partial_batch` type.
- A 429 `insufficient_quota` produces `fatal_error` with **zero
  retries**, regression-tested.

---

## 2.4.4 Streaming chat

**Files**
- `apps/api/src/providers/lib/sse.ts`
- `apps/api/src/providers/openai-compat.ts` (extended)

**Contents (high level)**

```ts
// apps/api/src/providers/lib/sse.ts
//
// Minimal SSE event stream reader. Produces { event?, data } objects
// from a stream of bytes.
//
// Not a generic SSE library — it handles only the fields we consume:
//   event: <name>
//   data: <json>
//   data: [DONE]    (OpenAI terminator)
//
// Ignores comments (lines starting with ':') and unknown fields.

export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<{ event?: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev: { event?: string; data: string } = { data: '' };
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const val = line.slice(colon + 1).trim();
        if (key === 'event') ev.event = val;
        else if (key === 'data') ev.data += (ev.data ? '\n' : '') + val;
      }
      if (ev.data) yield ev;
    }
  }
}
```

```ts
// apps/api/src/providers/openai-compat.ts (extended)
async *stream(req: ChatRequest, opts: ProviderOptions): AsyncIterable<TokenEvent> {
  const { url } = this.resolveBaseUrl(opts);
  const headers = this.buildHeaders(opts);
  const res = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...this.buildChatBody(req), stream: true }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* */ }
    const cls = classifyOpenAIError({ status: res.status, body: parsed, text });
    yield { type: 'error', error: {
      type: cls.type, provider: this.name, model: req.model, retry_count: 0,
      status: res.status, upstream_code: cls.upstream_code, upstream_message: cls.upstream_message,
    }};
    return;
  }

  let totalIn = 0, totalOut = 0;
  for await (const ev of readSseEvents(res.body)) {
    if (ev.data === '[DONE]') break;
    let chunk: any;
    try { chunk = JSON.parse(ev.data); } catch { continue; }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      yield { type: 'token', delta };
    }
    if (chunk.usage) {
      totalIn  = chunk.usage.prompt_tokens     ?? totalIn;
      totalOut = chunk.usage.completion_tokens ?? totalOut;
    }
  }
  yield { type: 'usage', usage: { input_tokens: totalIn, output_tokens: totalOut } };
  yield { type: 'done' };
}
```

> Streaming does not retry — once we've started emitting tokens to a
> consumer, we cannot rewind. A mid-stream error yields a `'error'`
> event and ends.

**Acceptance**
- Unit test feeds a fixtured SSE byte stream and asserts the produced
  `TokenEvent` sequence:
  - 5 `'token'` events with `delta` matching the fixture.
  - 1 `'usage'` event with the final token counts.
  - 1 `'done'` event.
- A 401 response produces a single `'error'` event with type
  `invalid_api_key` and ends.
- A streamed 1500-token answer yields its first token in under 1 s
  against the live OpenAI endpoint (live-test only).

---

# Step 2.5 — Workers AI Binding Provider

**Goal:** A no-key tier provider that uses `env.AI.run(...)` directly,
no HTTP, no AI Gateway, no provider key. Lives alongside the
OpenAI-compat path.

## 2.5.1 Binding provider

**Files**
- `apps/api/src/providers/workers-ai-binding.ts`

**Contents (high level)**

```ts
import type { Ai } from '@cloudflare/workers-types';

export class WorkersAIBindingProvider implements LLMProvider, EmbeddingProvider {
  name = 'workers_ai';

  constructor(private ai: Ai) {}

  async chat(req: ChatRequest, opts: ProviderOptions): Promise<ProviderResult<ChatResponse>> {
    const start = Date.now();
    try {
      const out: any = await this.ai.run(req.model as any, {
        messages: req.messages,
        max_tokens: req.max_tokens,
        temperature: req.temperature ?? 0,
        // JSON mode if structured-output requested:
        response_format: req.response_format?.type === 'text' ? undefined : req.response_format,
      });
      const content = out.response ?? out.choices?.[0]?.message?.content ?? '';
      let parsed: unknown | undefined;
      if (req.response_format && req.response_format.type !== 'text') {
        try { parsed = JSON.parse(content); }
        catch {
          return this.failResult({ type: 'schema_violation', provider: this.name, model: req.model, retry_count: 0 }, start);
        }
      }
      return {
        outcome: 'success',
        value: {
          content, parsed,
          usage: {
            input_tokens:  out.usage?.prompt_tokens     ?? 0,
            output_tokens: out.usage?.completion_tokens ?? 0,
          },
          model: req.model,
          finish_reason: 'stop',
        },
        meta: { provider: this.name, model: req.model, latency_ms: Date.now() - start, retry_count: 0, via_gateway: false },
      };
    } catch (e: any) {
      // Workers AI binding errors are typed; surface as retryable.
      return {
        outcome: 'retryable_error',
        error:   { type: 'server_error', provider: this.name, model: req.model, retry_count: 0, upstream_message: String(e?.message ?? e) },
        meta:    { provider: this.name, model: req.model, latency_ms: Date.now() - start, retry_count: 0, via_gateway: false },
      };
    }
  }

  async embed(req: EmbeddingRequest, _opts: ProviderOptions): Promise<ProviderResult<EmbeddingResponse>> {
    const start = Date.now();
    try {
      const out: any = await this.ai.run(req.model as any, { text: req.input });
      const vectors = out.data ?? [];
      if (!Array.isArray(vectors) || vectors.length !== req.input.length) {
        return {
          outcome: 'retryable_error',
          error: { type: 'partial_batch', provider: this.name, model: req.model, retry_count: 0,
                   upstream_message: `expected ${req.input.length}, got ${vectors.length}` },
          meta: { provider: this.name, model: req.model, latency_ms: Date.now() - start, retry_count: 0, via_gateway: false },
        };
      }
      return {
        outcome: 'success',
        value: { vectors, model: req.model, usage: { input_tokens: 0 } },
        meta: { provider: this.name, model: req.model, latency_ms: Date.now() - start, retry_count: 0, via_gateway: false },
      };
    } catch (e: any) {
      return {
        outcome: 'retryable_error',
        error: { type: 'server_error', provider: this.name, model: req.model, retry_count: 0, upstream_message: String(e?.message ?? e) },
        meta: { provider: this.name, model: req.model, latency_ms: Date.now() - start, retry_count: 0, via_gateway: false },
      };
    }
  }

  // Workers AI binding does not natively stream from a Worker handler
  // path back through Hono in MVP. Streaming via Workers AI is via
  // its compat HTTP endpoint (use OpenAICompatProvider variant).
  async *stream(): AsyncIterable<TokenEvent> {
    yield { type: 'error', error: {
      type: 'unknown', provider: this.name, model: 'unsupported', retry_count: 0,
      upstream_message: 'Streaming via Workers AI binding is not implemented; use OpenAI-compat HTTP path.',
    }};
  }

  dimensions(model: string): number {
    switch (model) {
      case '@cf/baai/bge-large-en-v1.5': return 1024;
      case '@cf/baai/bge-base-en-v1.5':  return 768;
      case '@cf/baai/bge-small-en-v1.5': return 384;
      default: throw new Error(`Unknown Workers AI embedding dimensions: ${model}`);
    }
  }
}
```

**Acceptance**
- Add the `AI` binding to `apps/api/wrangler.toml` (both envs):
  ```toml
  [env.dev.ai]
  binding = "AI"
  ```
- Live integration test (gated): chat completion against
  `@cf/meta/llama-3.1-8b-instruct` returns a non-empty string.
- Live integration test: embedding 5 short texts via
  `@cf/baai/bge-large-en-v1.5` returns 5 1024-dim vectors.

---

# Step 2.6 — Anthropic Provider

**Goal:** A separate class because Anthropic's request/response shape
diverges enough from OpenAI that overloading the compat class would
be misleading. Same `ProviderResult` discipline.

## 2.6.1 Anthropic provider

**Files**
- `apps/api/src/providers/anthropic.ts`

**Contents (high level)**

```ts
export class AnthropicProvider extends ProviderHttpClient implements LLMProvider {
  public override readonly name = 'anthropic';

  protected directBaseUrl(_model: string) { return 'https://api.anthropic.com'; }

  // Anthropic requires anthropic-version + x-api-key headers (not Authorization).
  protected buildHeaders(opts: ProviderOptions): Headers {
    const h = new Headers({
      'content-type': 'application/json',
      'x-api-key': opts.api_key,
      'anthropic-version': '2023-06-01',
    });
    if (opts.gateway && opts.request_metadata) {
      h.set('cf-aig-metadata', buildAigMetadata(opts.request_metadata));
    }
    return h;
  }

  async chat(req: ChatRequest, opts: ProviderOptions): Promise<ProviderResult<ChatResponse>> {
    let attempt = 0;
    let lastErr: ProviderError | undefined;
    while (attempt < 3) {
      const start = Date.now();
      let res;
      try {
        res = await this.post('v1/messages', this.buildBody(req), opts, 30_000);
      } catch (e: any) {
        const err = this.classifyThrown(e, req.model, attempt);
        if (isFatal(err.type)) return this.fatalResult(err, attempt, start);
        lastErr = err;
        await sleep(backoffDelay(attempt), opts.signal);
        attempt++;
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        return this.parseSuccess(req, res, opts, attempt, start);
      }
      const cls = classifyAnthropicError(res);
      const err: ProviderError = {
        type: cls.type, provider: this.name, model: req.model,
        status: res.status, upstream_code: cls.upstream_code, upstream_message: cls.upstream_message,
        retry_count: attempt, retry_after_ms: parseRetryAfter(res.headers.get('retry-after')),
      };
      if (isFatal(err.type)) return this.fatalResult(err, attempt, start);
      lastErr = err;
      await sleep(backoffDelay(attempt, err.retry_after_ms), opts.signal);
      attempt++;
    }
    return { outcome: 'retryable_error', error: lastErr!, meta: this.buildMeta(req.model, opts, attempt, Date.now(), null) };
  }

  // Structured output via single forced tool call.
  private buildBody(req: ChatRequest): unknown {
    const sys = req.messages.find((m) => m.role === 'system');
    const turns = req.messages.filter((m) => m.role !== 'system' && m.role !== 'developer');

    const body: any = {
      model: req.model,
      max_tokens: req.max_tokens ?? 1024,
      temperature: req.temperature ?? 0,
      messages: turns,
    };
    if (sys) body.system = sys.content;

    if (req.response_format && req.response_format.type === 'json_schema') {
      const toolName = req.response_format.name ?? 'respond';
      body.tools = [{
        name: toolName,
        description: 'Respond with the structured object.',
        input_schema: req.response_format.schema,
      }];
      body.tool_choice = { type: 'tool', name: toolName };
    } else if (req.response_format && req.response_format.type === 'json_object') {
      // Anthropic has no native json_object mode; emulate via prompt suffix.
      body.system = (body.system ?? '') + '\n\nRespond ONLY with valid JSON. No prose.';
    }
    return body;
  }

  // CONTENT POLICY (feedback item 10): for structured Anthropic
  // responses, `parsed` (from the tool_use block) is authoritative.
  // `content` may legitimately be empty when only a tool_use block is
  // returned. Downstream code that treats `content === ''` as failure
  // would be wrong here. Always check `parsed` first when a structured
  // schema was requested.
  //
  // schema_violation classifies as RETRYABLE (feedback item 4); the
  // base-class withRetries will re-attempt automatically.
  private parseSuccess(req: ChatRequest, res: any, attempt: number):
    | { ok: true; value: ChatResponse; warning?: ProviderError }
    | { ok: false; error: ProviderError } {
    const content = res.body?.content ?? [];
    let text = '';
    let parsed: unknown | undefined;
    for (const block of content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') parsed = block.input;  // structured-output payload
    }
    if (req.response_format?.type === 'json_schema' && parsed === undefined) {
      return { ok: false, error: {
        type: 'schema_violation', provider: this.name, model: req.model, retry_count: attempt,
      }};
    }
    if (req.response_format?.type === 'json_object' && parsed === undefined) {
      try { parsed = JSON.parse(text); }
      catch {
        return { ok: false, error: {
          type: 'schema_violation', provider: this.name, model: req.model, retry_count: attempt,
        }};
      }
    }
    const usage = res.body.usage;
    const usageMissing = !usage || typeof usage.input_tokens !== 'number';
    const value: ChatResponse = {
      content: text, parsed,
      usage: { input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0 },
      model: res.body.model ?? req.model,
      finish_reason: this.normalizeStop(res.body.stop_reason),
    };
    if (usageMissing) {
      return { ok: true, value, warning: {
        type: 'malformed_response', provider: this.name, model: req.model,
        retry_count: attempt, safe_upstream_message: 'usage missing on success response',
      }};
    }
    return { ok: true, value };
  }

  // Streaming: Anthropic emits its own SSE event stream
  // (event: message_start / content_block_delta / etc.). We map to
  // our normalized TokenEvent shape.
  async *stream(req: ChatRequest, opts: ProviderOptions): AsyncIterable<TokenEvent> {
    // (Implementation omitted; structurally similar to OpenAI streaming
    //  but parses Anthropic's named events. Test fixture below.)
  }
}
```

**Acceptance**
- Fixture-based unit tests for: success (text), success (tool_use →
  structured output), 401 → fatal `invalid_api_key` no retries, 429
  → retried, 529 (overloaded) → retried.
- Live integration test (gated): `claude-haiku-4-5` returns a non-empty
  response.

---

# Step 2.7 — Reranker Providers

**Goal:** Voyage and Cohere rerank providers, callable from the
Worker, no streaming.

## 2.7.1 Voyage rerank

**Files**
- `apps/api/src/providers/voyage-rerank.ts`

**Contents (high level)**

Validation hardened per feedback item 11. The adapter:
- rejects malformed bodies (missing `data`, non-array),
- rejects out-of-range or non-integer indexes,
- de-duplicates indexes (keeps highest score),
- enforces score-descending sort (the adapter, not the test, owns this),
- emits `degraded_success` if the provider returned ≥1 but fewer than `top_n`.

```ts
export class VoyageRerankProvider extends ProviderHttpClient implements RerankProvider {
  public override readonly name = 'voyage';

  protected directBaseUrl(_model: string) { return 'https://api.voyageai.com/v1'; }

  async rerank(req: RerankRequest, opts: ProviderOptions): Promise<ProviderResult<RerankResponse>> {
    return this.withRetries<RerankResponse>({
      model: req.model,
      timeoutMs: 8_000,
      opts,
      call: () => this.post(req.model, 'rerank',
        { query: req.query, documents: req.documents, model: req.model, top_k: req.top_n },
        opts, 8_000),
      parseSuccess: (res, attempt) => this.parseRerank(req, res.body, attempt),
      classifyError: (res, attempt) => {
        const cls = classifyOpenAIError(res);
        return {
          type: cls.type, provider: this.name, model: req.model,
          status: res.status,
          upstream_code: cls.upstream_code,
          safe_upstream_message: redact(cls.upstream_message ?? ''),
          retry_count: attempt,
        };
      },
    });
  }

  private parseRerank(req: RerankRequest, body: any, attempt: number):
    | { ok: true; value: RerankResponse; warning?: ProviderError }
    | { ok: false; error: ProviderError } {
    const data = body?.data;
    if (!Array.isArray(data)) {
      return { ok: false, error: {
        type: 'malformed_response', provider: this.name, model: req.model, retry_count: attempt,
        safe_upstream_message: 'rerank response missing `data` array',
      }};
    }

    const n = req.documents.length;
    const seen = new Set<number>();
    const results: { index: number; score: number }[] = [];
    for (const r of data) {
      if (!r || typeof r !== 'object') continue;
      const idx = (r as any).index;
      const score = (r as any).relevance_score;
      if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
        return { ok: false, error: {
          type: 'malformed_response', provider: this.name, model: req.model, retry_count: attempt,
          safe_upstream_message: `rerank index out of range: ${idx} (input size ${n})`,
        }};
      }
      if (typeof score !== 'number' || Number.isNaN(score)) {
        return { ok: false, error: {
          type: 'malformed_response', provider: this.name, model: req.model, retry_count: attempt,
          safe_upstream_message: `rerank relevance_score is not a number: ${String(score)}`,
        }};
      }
      if (seen.has(idx)) continue;        // dedupe
      seen.add(idx);
      results.push({ index: idx, score });
    }

    if (results.length === 0) {
      return { ok: false, error: {
        type: 'malformed_response', provider: this.name, model: req.model, retry_count: attempt,
        safe_upstream_message: 'rerank produced 0 valid results',
      }};
    }

    // Adapter enforces sort order — never depend on the provider.
    results.sort((a, b) => b.score - a.score);
    const value = { results, model: req.model };

    // degraded_success producer (feedback item 5): fewer than top_n.
    const topN = req.top_n ?? results.length;
    if (results.length < topN) {
      return { ok: true, value, warning: {
        type: 'partial_batch', provider: this.name, model: req.model, retry_count: attempt,
        safe_upstream_message: `requested top_n=${topN}, got ${results.length}`,
      }};
    }
    return { ok: true, value };
  }
}
```

**Acceptance**
- Unit test: 30 candidates → returns top 12 in score-descending order
  even if the upstream response is unsorted.
- Unit test: response with `index: 99` for an input of size 30 →
  `retryable_error` of type `malformed_response`.
- Unit test: response with duplicate `index: 5` → de-duplicated.
- Unit test: `top_n=12` but provider returns 10 → `degraded_success`
  with the 10 results.
- Live integration test (gated): rerank returns a successful response
  and records latency. Latency is logged but NOT a hard acceptance
  threshold — p95 SLOs live in a nightly benchmark job (feedback item 15).

---

## 2.7.2 Cohere rerank

**Files**
- `apps/api/src/providers/cohere-rerank.ts`

**Contents (high level)**

```ts
// Cohere's API:
//   POST https://api.cohere.com/v2/rerank
//   { query, documents, top_n, model }
// Auth: Authorization: Bearer <key>
// Response: { results: [{ index, relevance_score }] }
//
// Errors: { message: '...' } with HTTP status. Reuse classifyByStatus.

export class CohereRerankProvider extends ProviderHttpClient implements RerankProvider {
  public override readonly name = 'cohere';
  protected directBaseUrl(_model: string) { return 'https://api.cohere.com/v2'; }

  async rerank(req: RerankRequest, opts: ProviderOptions): Promise<ProviderResult<RerankResponse>> {
    // Same shape as Voyage with body `top_n` instead of `top_k` and
    // a different success-shape parser.
  }
}
```

**Acceptance**
- Unit test with fixture matches expected behavior.
- Live integration test optional.

---

# Step 2.8 — Provider Resolver Completion (Light up `/test`)

**Goal:** The `/v1/provider-keys/:id/test` route stubbed at 501 in
Phase 1.5 now performs a real 1-token validation call.

## 2.8.1 Validation factory

**Files**
- `apps/api/src/providers/validate.ts`

**Contents (high level)**

```ts
// Given a registered provider key, issue a minimal call that
// confirms the key is alive and authorized. We make this provider-
// specific but uniformly small.
//
// Implementations:
//   openai    → POST /v1/embeddings, model='text-embedding-3-small',
//               input=['ping']  (1 input token, near-zero cost).
//   anthropic → POST /v1/messages, model='claude-haiku-4-5',
//               max_tokens=1, message='hi'.
//   voyage    → small rerank with one candidate.
//   cohere    → small rerank with one candidate.
//   workers_ai → not validatable (no key); return success.

export interface ValidationResult {
  ok: boolean;
  error_code?: string;       // a stable PROVIDER_* code if !ok
  error_message?: string;
}

export async function validateProviderKey(
  env: Env,
  provider: string,
  rawKey: string,
): Promise<ValidationResult> {
  switch (provider) {
    case 'openai':     return validateViaOpenAI(env, rawKey);
    case 'anthropic':  return validateViaAnthropic(env, rawKey);
    case 'voyage':     return validateViaVoyage(env, rawKey);
    case 'cohere':     return validateViaCohere(env, rawKey);
    case 'workers_ai': return { ok: true };
    default: return { ok: false, error_code: 'PROVIDER_KEY_VALIDATION_FAILED', error_message: `Unknown provider: ${provider}` };
  }
}
```

**Acceptance**
- Unit test against mocked providers: a 401 returns
  `{ ok: false, error_code: 'PROVIDER_KEY_INVALID' }`; a 200 returns
  `{ ok: true }`.

---

## 2.8.2 Wire `/test` route

**Files**
- `apps/api/src/routes/provider-keys.ts` (extended)

**Contents (high level)**

```ts
// Before this step, the route returned 501 NOT_IMPLEMENTED.
// Now:
//
// POST /v1/provider-keys/:id/test
//   1. SELECT provider_keys row by ID (404 if not owned).
//   2. resolveProviderKeyById() → { provider, raw_key }.       ← exact-row resolve
//   3. validateProviderKey(env, provider, raw_key).
//   4. Update last_validated_at + last_error_code on the row.
//   5. Return { ok: boolean, error_code?, error_message? }.
//
// Why resolve by ID, not by (provider, label)? Per feedback item 12:
// resolving by (provider, label) could accidentally test a DIFFERENT
// key than the one the consumer asked about — duplicate-label race
// conditions, or a stale row that's still "active." The /test
// endpoint must test the exact row the caller requested.

providerKeys.post('/:id/test', requireApiKey, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const id = c.req.param('id');

  const resolved = await resolveProviderKeyById(c.env, tenantId, id);
  // Throws PROVIDER_KEY_NOT_FOUND if no matching row.
  const result = await validateProviderKey(c.env, resolved.provider, resolved.raw_key);

  await c.env.DB.prepare(
    `UPDATE provider_keys SET last_validated_at = ?1, last_error_code = ?2 WHERE id = ?3`,
  ).bind(Date.now(), result.error_code ?? null, id).run();

  return c.json(result, result.ok ? 200 : 422);
});
```

**New helper added in `apps/api/src/auth/provider-keys.ts`:**

```ts
export async function resolveProviderKeyById(
  env: Env,
  tenantId: string,
  id: string,
): Promise<{ provider_key_id: string; provider: string; raw_key: string }> {
  const row = await env.DB.prepare(
    `SELECT id, provider, secrets_store_secret_name FROM provider_keys
     WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
  ).bind(id, tenantId).first<{
    id: string; provider: string; secrets_store_secret_name: string;
  }>();
  if (!row) {
    throw new TextralError('PROVIDER_KEY_NOT_FOUND', 404, 'Provider key not found');
  }
  const raw = await getSecretsStoreClient(env).get(row.secrets_store_secret_name);
  if (!raw) {
    throw new TextralError(
      'PROVIDER_KEY_NOT_FOUND', 404,
      `Provider key metadata exists but the secret is missing: ${row.id}`,
    );
  }
  return { provider_key_id: row.id, provider: row.provider, raw_key: raw };
}
```

**Acceptance**
```bash
# Register a key, then test it:
curl -s -X POST -H "X-Textral-Api-Key: <SEED>" \
     -H "Content-Type: application/json" \
     -d '{"provider":"openai","label":"prod","key":"sk-proj-..."}' \
     http://localhost:8787/v1/provider-keys
# (returns ProviderKey)

curl -s -X POST -H "X-Textral-Api-Key: <SEED>" \
     http://localhost:8787/v1/provider-keys/<ID>/test
# → {"ok":true}

# Test with a deliberately-invalid key:
# (register a key with body 'sk-invalid')
curl -s -X POST ...   # returns 422
# → {"ok":false,"error_code":"PROVIDER_KEY_INVALID","error_message":"..."}

# D1 reflects:
npx wrangler d1 execute textral-dev --env dev \
  --command "SELECT id, last_validated_at, last_error_code FROM provider_keys"
# → last_validated_at populated, last_error_code matches
```

---

# Step 2.9 — Provider Registry

**Goal:** A single place to look up "given a provider name and a
config, return the provider instance configured for AI Gateway
routing." Used by the `/test` endpoint above and by Phase 3+
ingestion + Phase 4 query path.

## 2.9.1 Registry

**Files**
- `apps/api/src/providers/registry.ts`

**Contents (high level)**

```ts
// Resolves a provider+model to an instance, with AI Gateway
// configuration applied based on env config.

export interface ResolveOptions {
  provider:    string;          // 'openai' | 'anthropic' | 'workers_ai' | 'voyage' | 'cohere'
  model:       string;
  api_key:     string;          // raw, resolved upstream
  request_metadata?: Record<string, string>;
}

export interface Resolved {
  llm?:       LLMProvider;
  embedding?: EmbeddingProvider;
  rerank?:    RerankProvider;
  options:    ProviderOptions;
}

export function resolve(env: Env, args: ResolveOptions): Resolved {
  const gateway: GatewayConfig | undefined = env.AI_GATEWAY_BYPASS === 'true' ? undefined : {
    account_id: env.CF_ACCOUNT_ID,
    gateway_id: env.AI_GATEWAY_ID,
    provider:   gatewayProviderFor(args.provider),
  };
  const opts: ProviderOptions = {
    api_key: args.api_key,
    gateway,
    request_metadata: args.request_metadata,
  };

  switch (args.provider) {
    case 'openai':
      return { llm: openaiDirect, embedding: openaiDirect, options: opts };
    case 'anthropic':
      return { llm: new AnthropicProvider(), options: opts };
    case 'workers_ai':
      return { llm: new WorkersAIBindingProvider(env.AI), embedding: new WorkersAIBindingProvider(env.AI), options: opts };
    case 'voyage':
      return { rerank: new VoyageRerankProvider(), options: opts };
    case 'cohere':
      return { rerank: new CohereRerankProvider(), options: opts };
    default:
      throw new TextralError('PROVIDER_UNSUPPORTED_MODEL', 400, `Unknown provider: ${args.provider}`);
  }
}

function gatewayProviderFor(p: string): GatewayConfig['provider'] {
  switch (p) {
    case 'openai':     return 'openai';
    case 'anthropic':  return 'anthropic';
    case 'workers_ai': return 'workers-ai';
    case 'voyage':     return 'voyage';
    case 'cohere':     return 'cohere';
    default: throw new Error(`No AI Gateway provider mapping for: ${p}`);
  }
}
```

## 2.9.2 Worker env additions

**Files**
- `apps/api/wrangler.toml` (extended)
- `apps/api/src/types.ts` (extended)

**Add per-env vars**:
```toml
[env.dev.vars]
# … existing …
CF_ACCOUNT_ID = "your-cloudflare-account-id"
AI_GATEWAY_ID = "textral-dev"        # create one in the CF dashboard
AI_GATEWAY_BYPASS = "false"
```

**Provision the AI Gateway**:
```bash
# Once per env, via dashboard:
#   Cloudflare dashboard → AI Gateway → Create gateway
#   Name: textral-dev (and textral-prod)
#   Authentication: off (for now; authenticated gateway supported later)
```

**Acceptance**
- A unit test passes a fake env and asserts that `resolve(env, { provider: 'openai', ... })`
  returns a provider with `options.gateway` populated.
- `AI_GATEWAY_BYPASS=true` causes `gateway` to be undefined.

---

## 2.9.3 Update `/test` endpoint to use registry

**Files**
- `apps/api/src/providers/validate.ts` (extended)

**Replace direct provider construction with `resolve(env, ...)`** so
the `/test` validation call ALSO routes through AI Gateway, producing
a row in the dashboard tagged with the tenant_id.

**Acceptance**
- Run `/test` against an OpenAI key.
- Open Cloudflare dashboard → AI Gateway → `textral-dev` → Logs.
- See a request tagged with `tenant_id` (the seed tenant's ID).

---

# Step 2.10 — Phase 2 close-out

## 2.10.1 Regression test for the v1 retry-loop incident

**Files**
- `apps/api/test/regression-quota.test.ts`

**Contents (high level)**
- A test that mocks `globalThis.fetch` to return HTTP 429 with
  `{ error: { code: 'insufficient_quota', message: '...' } }` on every
  call.
- Calls `openaiDirect.chat({ model: 'gpt-5.5', messages: [...] }, opts)`.
- Asserts:
  - `result.outcome === 'fatal_error'`
  - `result.error.type === 'insufficient_quota'`
  - `globalThis.fetch.mock.calls.length === 1` — **no retries**.
  - The `meta.latency_ms` is small (<200 ms), proving no backoff
    sleep ran.

This is the regression that proves the v1 bug cannot recur.

**Acceptance**
- Test green.

---

## 2.10.2 Live smoke test

**Files**
- `apps/api/test/live-smoke.test.ts` (gated by `RUN_LIVE_TESTS=1`)

**Contents (high level)**

Per feedback item 15, this test asserts **success + records latency**.
It does NOT enforce latency thresholds — those belong in a nightly
benchmark job, not a PR-blocking unit test, because they're sensitive
to network / region / provider variance.

- Hits each registered provider with one minimal call:
  - OpenAI chat: `gpt-4o-mini`, "ping" → assert `outcome === 'success'`
  - OpenAI embed: `text-embedding-3-small`, ["ping"] → assert vector length
  - Workers AI chat: `@cf/meta/llama-3.1-8b-instruct`, "ping" → assert `outcome === 'success'`
  - Anthropic chat: `claude-haiku-4-5`, "ping" → assert `outcome === 'success'`
  - Voyage rerank: 5 candidates → assert `outcome === 'success'` and `results.length > 0`
- Records `meta.latency_ms` to a JSON file under
  `apps/api/test/.live-smoke-latency.json` for later inspection /
  trend dashboards.

**Acceptance**
```bash
RUN_LIVE_TESTS=1 pnpm --filter @textral/api test live-smoke
# All providers return outcome=success.
# Latency is reported but not asserted — the nightly benchmark (out of
# scope for Phase 2) is responsible for trending p95/p99.
```

---

## 2.10.3 Provider error redaction tests

Per feedback item 13. Phase 2 introduces upstream error bodies and
`safe_upstream_message` (renamed from `upstream_message`). The
contract is: **no upstream string is assigned to `safe_upstream_message`
without flowing through `redact()` first**, and tests prove that no
provider-key fragment ever appears in a `ProviderError`, in a logged
telemetry event, or in any error envelope.

**Files**
- `apps/api/test/provider-redaction.test.ts`

**Contents (high level)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { OpenAICompatProvider } from '../src/providers/openai-compat.js';

const FAKE_KEYS = [
  'sk-proj-abcdefghijklmnopqrstuvwxyz0123',
  'sk-ant-abcdefghijklmnopqrstuvwxyz0123',
  'voy-abcdefghijklmnopqrstuvwxyz',
];

for (const fakeKey of FAKE_KEYS) {
  describe(`provider-error redaction (${fakeKey.slice(0, 8)}...)`, () => {
    it('does not leak the key in ProviderError or telemetry', async () => {
      // Mock fetch: the upstream error body unwisely echoes the key.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ error: {
          code: 'invalid_api_key',
          message: `Invalid API key: ${fakeKey}`,
        }}),
        { status: 401 },
      )));
      const captured: string[] = [];
      const origInfo = console.info;
      console.info = (...args: unknown[]) => { captured.push(JSON.stringify(args)); };

      const result = await openaiDirect.chat(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        { api_key: fakeKey },
      );
      console.info = origInfo;

      // The error string never echoes the raw key.
      const blob = JSON.stringify(result);
      expect(blob).not.toContain(fakeKey);
      // Telemetry log lines never echo the raw key.
      expect(captured.some((s) => s.includes(fakeKey))).toBe(false);
    });
  });
}
```

Also assert that **request headers are never logged**: the redaction
middleware (Phase 1.6) already strips `Authorization` / `x-api-key`,
but the provider-error path produces NEW telemetry that didn't exist
when 1.6 was tested. This test pins the contract.

**Acceptance**
- All three provider-key shapes (OpenAI / Anthropic / Voyage) verified.
- Test fails immediately if a future provider stops piping
  `upstream_message` through `redact()`.

---

## 2.10.4 Phase 2 exit gate

```bash
pnpm -r typecheck                         # green
pnpm -r lint                              # green
pnpm --filter @textral/api test           # all unit + fixture tests green
RUN_LIVE_TESTS=1 pnpm --filter @textral/api test live-smoke    # all providers green

# /test endpoint works:
curl -s -X POST -H "X-Textral-Api-Key: <SEED>" \
     http://localhost:8787/v1/provider-keys/<ID>/test
# → {"ok":true}

# AI Gateway logs show tagged requests:
# Cloudflare dashboard → AI Gateway → textral-dev → Logs → filter by tenant_id

# Regression test:
pnpm --filter @textral/api test regression-quota
# Green; the v1 incident cannot recur.
```

When every box above is green, Phase 2 is closed. Tag
`phase-2-complete`. Write `docs/retrospectives/phase-2.md` with what
changed vs the plan.

---

# Appendix A — File tree added/modified in Phase 2

```
apps/api/src/
├── providers/
│   ├── ai-gateway.ts                  ← 2.3.2
│   ├── anthropic.ts                   ← 2.6
│   ├── cohere-rerank.ts               ← 2.7.2
│   ├── error-classification.ts        ← 2.2
│   ├── lib/
│   │   ├── backoff.ts                 ← 2.3.1
│   │   ├── http-client.ts             ← 2.3.3
│   │   └── sse.ts                     ← 2.4.4
│   ├── openai-compat.ts               ← 2.4
│   ├── registry.ts                    ← 2.9.1
│   ├── types.ts                       ← 2.1
│   ├── validate.ts                    ← 2.8.1
│   ├── voyage-rerank.ts               ← 2.7.1
│   └── workers-ai-binding.ts          ← 2.5
├── routes/
│   └── provider-keys.ts               ← extended in 2.8.2
└── types.ts                           ← extended in 2.9.2

apps/api/test/
├── error-classification.test.ts       ← 2.2 unit + regression
├── http-client.test.ts                ← 2.3.3
├── live-smoke.test.ts                 ← 2.10.2 (gated)
├── openai-compat.test.ts              ← 2.4
├── anthropic.test.ts                  ← 2.6
├── workers-ai.test.ts                 ← 2.5
├── voyage-rerank.test.ts              ← 2.7.1
├── cohere-rerank.test.ts              ← 2.7.2
├── sse.test.ts                        ← 2.4.4
├── regression-quota.test.ts           ← 2.10.1  (the v1 fix locked in)
└── provider-keys-test-route.test.ts   ← 2.8.2

apps/api/wrangler.toml                 ← extended in 2.5 (AI binding) + 2.9.2 (gateway vars)

packages/contracts/src/
├── error-codes.ts                     ← extended in 2.1.3
└── provider.ts                        ← 2.1.3
```

---

# Appendix B — One-line answers to questions a dev might still have

| Q | A |
|---|---|
| Why not use `openai-node`? | Bundle size + opacity around our retry/classification layer. Raw `fetch` keeps the wire format inspectable. |
| Why are streaming calls not retried? | Once we've emitted a `'token'` event to a downstream consumer, we can't rewind. Mid-stream errors emit an `'error'` event and end. |
| Why is `partial_batch` retryable? | A short batch is usually a transient capacity issue at the provider, not a persistent error. Three attempts is the bound. |
| Why isn't `refusal` retryable? | A refusal is a deliberate policy decision by the model. Retrying with the same prompt yields the same refusal, costs money, and degrades trust. |
| Why does `validate.ts` use `text-embedding-3-small` for OpenAI key validation, not a chat call? | Embeddings are cheaper per call than chat completions for a 1-token request, and they exercise the auth path identically. |
| Why is Anthropic's `rate_limit_error` mapped retryable instead of fatal-on-quota? | Anthropic doesn't surface a quota-distinct code; we accept up to N retries and let the failure bubble through as `retryable_error` if persistent. If consumer feedback shows quota-vs-throttle confusion, add message-string heuristics later. |
| Why does AI Gateway routing live in the base HTTP client and not in each provider? | Single source of truth; per-provider URL building stays per-provider, gateway path-segment logic is shared. |
| What about provider-side prompt caching? | OpenAI and Anthropic both honor caching headers natively when called through AI Gateway; AI Gateway adds its own caching layer too. We don't need to do anything in Phase 2; verify in the AI Gateway dashboard during Phase 6. |
| Where are model-tier and fallback-chain decisions? | Phase 8 of the design doc references a model registry. We don't need it in Phase 2 — consumers pass concrete `(provider, model)` per request. The registry layer can be added later without changing this provider abstraction. |
| What about Workers AI streaming through AI Gateway? | Workers AI's compat HTTP endpoint can stream via AI Gateway. If a tenant requests streaming with `provider: workers_ai`, the resolver should pick the OpenAI-compat path rooted at the Workers AI compat URL, not the binding path. (Documented in Phase 5 when corpus profiles surface tier choice.) |

---

End of Phase 2 implementation guide. Phase 3 begins in
`PHASE_3_IMPLEMENTATION.md` (next doc to draft) — that's the heaviest
phase: the Container queue worker, the five core ingestion stages,
idempotent replay, and embedding-profile compatibility on the write
side.
