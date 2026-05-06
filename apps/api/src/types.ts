// Worker bindings + per-request context shape.
//
// Binding identifiers are 1:1 with `apps/api/wrangler.toml`. When the
// implementation references `c.env.DB` etc., it's reaching one of these.
//
// V3 Phase 2 migration: `Env` extends the runtime-shared `Bindings`
// interface for the duration of the migration. Both shapes are
// available on `c.env`: legacy CF-binding access (the uppercase
// `DB`, `BLOBS`, `CACHE`, ... fields below) and the runtime-agnostic
// `Db` / `BlobStore` / `KvStore` adapters from `Bindings`.
//
// PHASE_2_CLEANUP_TODO markers below identify each legacy field's
// remaining consumer site (or `unread` if all consumers have already
// migrated). Post-Phase-2 cleanup will:
//   1. Verify every `unread` field has zero source-tree references.
//   2. Drop the field from `Env`.
//   3. Migrate the runtime-shared field to be required (currently
//      most are optional in `Bindings`).
// At that point `Env` collapses to a CF-binding-only type used only
// inside `runtime/cf/bindings.ts`, and routes type their Hono
// generic as `<{ Bindings: Bindings; Variables: Variables }>`.

import type { Bindings } from './runtime/shared/interfaces.js';

export type { Bindings } from './runtime/shared/interfaces.js';

export interface Env extends Bindings {
  // ── env vars (TOML-driven) ────────────────────────────────────────────
  /** PHASE_2_CLEANUP_TODO: read by `auth/pepper.ts` (test-mode
   *  string-or-binding detection only). Production reads runtimeEnv. */
  ENV: 'dev' | 'prod';
  /** PHASE_2_CLEANUP_TODO: read by `routes/dev/{ingest-ping,workers-ai-ping}.ts`
   *  + middleware redaction allowlist. CF-runtime-only diagnostic
   *  routes; Node runtime can carry through env if needed. */
  ENABLE_DEBUG_ROUTES: string; // "true" | "false"
  /** PHASE_2_CLEANUP_TODO: read by CORS middleware (TBD audit). */
  ALLOWED_ORIGINS: string;
  /** PHASE_2_CLEANUP_TODO: only read by `runtime/cf/bindings.ts`
   *  to construct `aiGateway.baseUrl`. Drop after collapse. */
  CF_ACCOUNT_ID: string;
  /** PHASE_2_CLEANUP_TODO: same — only the CF builder reads it. */
  AI_GATEWAY_ID: string;
  /** PHASE_2_CLEANUP_TODO: same — only the CF builder reads it.
   *  Set to "true" to bypass AI Gateway routing (calls go direct to
   *  upstream providers). Useful for local development; off in prod. */
  AI_GATEWAY_BYPASS?: string;

  // ── Cloudflare bindings ───────────────────────────────────────────────
  /** PHASE_2_CLEANUP_TODO: only `runtime/cf/bindings.ts` reads it
   *  (constructs D1Db). All call sites migrated to `c.env.db`. */
  DB: D1Database;
  /** PHASE_2_CLEANUP_TODO: only `runtime/cf/bindings.ts` reads it
   *  (constructs R2BlobStore). All call sites migrated to
   *  `c.env.blobs`. */
  BLOBS: R2Bucket;
  /** PHASE_2_CLEANUP_TODO: only `runtime/cf/bindings.ts` reads it
   *  (constructs CfQueueProducer). All call sites migrated to
   *  `c.env.queue`. */
  INGEST_QUEUE: Queue<unknown>;
  /** Vectorize V2 index. Bound as the modern `Vectorize` type so
   *  upserts return `{ mutationId }` (the V1 `VectorizeIndex` shape
   *  returned `{ ids, count }` and is being deprecated).
   *  PHASE_2_CLEANUP_TODO: only `runtime/cf/bindings.ts` reads it
   *  (assigns to `bindings.vectorize`). All call sites migrated to
   *  `c.env.vectors.forBinding(...)`. */
  VECTORIZE_OPENAI_LARGE: Vectorize;
  /** Server-side pepper for HMAC-hashing customer API keys.
   *  Set as a Worker secret via `wrangler secret put API_KEY_PEPPER`.
   *  `readPepper(env)` handles both plain strings (here + tests) and
   *  `SecretsStoreSecret` shapes (future, when token scope permits).
   *  PHASE_2_CLEANUP_TODO: read by `auth/pepper.ts` for the
   *  string-or-binding detection. Migrate when peppered to
   *  `bindings.apiKeyPepper`. */
  API_KEY_PEPPER: string;
  /** PHASE_2_CLEANUP_TODO: only `runtime/cf/bindings.ts` (constructs
   *  DoContainerInvoker) and `routes/dev/ingest-ping.ts` (CF-only
   *  diagnostic, runtime-gated) read it. */
  INGEST_CONTAINER: DurableObjectNamespace;
  /** PHASE_2_CLEANUP_TODO: only `runtime/cf/bindings.ts` reads it
   *  (assigns to `bindings.ai`). All consumers migrated to
   *  `c.env.ai` (the structural shape) or `c.env.runtime` gating. */
  CACHE: KVNamespace;
  AI: Ai;

  // ── Worker secrets (set via `wrangler secret put`) ────────────────────
  /** PHASE_2_CLEANUP_TODO: read by `routes/admin/bootstrap.ts:47`. */
  ADMIN_BOOTSTRAP_TOKEN?: string;
  /** PHASE_2_CLEANUP_TODO: read by `middleware/internal-auth.ts`. */
  INTERNAL_HMAC_SECRET?: string;
  /** Tenant-salt for query_events.request_config_hash.
   *  PHASE_2_CLEANUP_TODO: read by `audit/query-events.ts`. */
  AUDIT_HASH_SALT?: string;
  /** PHASE_2_CLEANUP_TODO: read by `runtime/cf/container.ts`. */
  WORKER_INTERNAL_URL?: string;
  /** PHASE_2_CLEANUP_TODO: only `runtime/cf/bindings.ts` reads it
   *  (constructs AeMetricsSink or NoopMetricsSink). All call sites
   *  migrated to `c.env.metrics.write(...)`. */
  AE_METRICS?: AnalyticsEngineDataset;

  // ── V3 Phase 1 — pluggable vector store ───────────────────────────────
  /** PHASE_2_CLEANUP_TODO: read by `retrieval/vector-store.ts`
   *  (qdrant case) and copied to `bindings.qdrantUrl`. */
  QDRANT_URL?: string;
  /** PHASE_2_CLEANUP_TODO: read by `retrieval/vector-store.ts`. */
  QDRANT_API_KEY?: string;
  /** PHASE_2_CLEANUP_TODO: read by `retrieval/vector-store.ts`. */
  PINECONE_API_KEY?: string;
}

export type Variables = {
  // Populated by middleware as the request flows through.
  request_id?: string;
  tenant_id?: string;
  api_key_id?: string;
  /** Scope list from the resolved API key. `['*']` is the wildcard. */
  api_key_scopes?: string[];
};
