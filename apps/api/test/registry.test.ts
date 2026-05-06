import { describe, it, expect } from 'vitest';
import { resolve } from '../src/providers/registry.js';
import type { Env } from '../src/types.js';

function fakeEnv(overrides: Partial<Env> = {}): Env {
  // Test stub. Real Bindings adapter fields (db, blobs, kv, etc.) are
  // not exercised by registry.test.ts — resolve() only reads
  // aiGateway. The aiGateway field defaults to a CF-shape value;
  // tests that need bypass set `aiGateway: undefined` explicitly.
  // Cast through `unknown` so the Phase-2 expanded `Env extends
  // Bindings` shape doesn't drag in test-irrelevant fields.
  return {
    ENV: 'dev',
    ENABLE_DEBUG_ROUTES: 'true',
    ALLOWED_ORIGINS: '*',
    CF_ACCOUNT_ID: 'acct',
    AI_GATEWAY_ID: 'textral-dev',
    AI_GATEWAY_BYPASS: 'false',
    DB: {} as D1Database,
    BLOBS: {} as R2Bucket,
    INGEST_QUEUE: {} as Queue<unknown>,
    VECTORIZE_OPENAI_LARGE: {} as Vectorize,
    CACHE: {} as KVNamespace,
    API_KEY_PEPPER: 'pepper',
    INGEST_CONTAINER: {} as DurableObjectNamespace,
    AI: {} as Ai,
    ai: {} as Ai,
    aiGateway: {
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/textral-dev',
      metadataHeaderPrefix: 'cf-aig-' as const,
      providerSegment: (p: string) => (p === 'workers_ai' ? 'workers-ai' : p),
    },
    ...overrides,
  } as unknown as Env;
}

describe('resolve()', () => {
  it('returns OpenAI provider with gateway populated', () => {
    const r = resolve(fakeEnv(), { provider: 'openai', api_key: 'sk-x' });
    expect(r.llm).toBeDefined();
    expect(r.embedding).toBeDefined();
    expect(r.options.gateway).toEqual({
      base_url: 'https://gateway.ai.cloudflare.com/v1/acct/textral-dev',
      metadata_header_prefix: 'cf-aig-',
      provider: 'openai',
    });
    expect(r.options.api_key).toBe('sk-x');
  });

  it('returns Anthropic provider', () => {
    const r = resolve(fakeEnv(), { provider: 'anthropic', api_key: 'sk-ant-x' });
    expect(r.llm).toBeDefined();
    expect(r.options.gateway?.provider).toBe('anthropic');
  });

  it('returns Workers AI binding provider — gateway omitted (no key)', () => {
    const r = resolve(fakeEnv(), { provider: 'workers_ai' });
    expect(r.llm).toBeDefined();
    expect(r.embedding).toBeDefined();
    expect(r.options.api_key).toBeUndefined();
  });

  it('throws PROVIDER_UNAVAILABLE for workers_ai when bindings.ai is undefined (self-host)', () => {
    // V3 Phase 2 Step 13: workers_ai gates on `bindings.ai`. The Node
    // runtime sets it to undefined; CF runtime sets it from env.AI.
    // Simulate the self-host shape by removing both legacy and new
    // fields from the fake env.
    const env = fakeEnv();
    delete (env as { ai?: unknown }).ai;
    delete (env as { AI?: unknown }).AI;
    expect(() => resolve(env, { provider: 'workers_ai' })).toThrow(
      /Workers AI not available/,
    );
  });

  it('returns Voyage rerank provider', () => {
    const r = resolve(fakeEnv(), { provider: 'voyage', api_key: 'voy-x' });
    expect(r.rerank).toBeDefined();
    expect(r.options.gateway?.provider).toBe('voyage');
  });

  it('returns Cohere rerank provider', () => {
    const r = resolve(fakeEnv(), { provider: 'cohere', api_key: 'co-x' });
    expect(r.rerank).toBeDefined();
    expect(r.options.gateway?.provider).toBe('cohere');
  });

  it('omits gateway when the runtime adapter resolves no aiGateway', () => {
    // The CF adapter sets `aiGateway: undefined` when AI_GATEWAY_BYPASS
    // is set or when CF_ACCOUNT_ID/AI_GATEWAY_ID are missing; the Node
    // adapter sets it undefined when AI_GATEWAY_BASE_URL is unset.
    // resolve()'s job is to pass that through.
    const env = fakeEnv();
    delete (env as { aiGateway?: unknown }).aiGateway;
    const r = resolve(env, { provider: 'openai', api_key: 'sk-x' });
    expect(r.options.gateway).toBeUndefined();
  });

  it('forwards request_metadata to options', () => {
    const r = resolve(fakeEnv(), {
      provider: 'openai',
      api_key: 'sk-x',
      request_metadata: { tenant_id: 'ten_x', provider_key_id: 'pkey_y' },
    });
    expect(r.options.request_metadata).toEqual({
      tenant_id: 'ten_x',
      provider_key_id: 'pkey_y',
    });
  });

  it('throws on unknown provider', () => {
    expect(() => resolve(fakeEnv(), { provider: 'nope' })).toThrow(/Unknown provider/);
  });
});
