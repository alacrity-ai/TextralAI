// Runtime-agnostic binding shape consumed by routes + helpers.
// Two implementations: runtime/cf/* (Workers) and runtime/node/*
// (self-host). The `Bindings` shape is what `c.env` resolves to
// at the route layer.
//
// Migration policy (Phase 2): `Env` (in `apps/api/src/types.ts`)
// extends `Bindings` for the duration of the migration. Existing
// code reads `c.env.DB` (CF binding type); new code reads
// `c.env.db` (the `Db` interface). Once every call site is
// migrated, the CF-binding fields disappear from `Env` and
// `Env` collapses to `Bindings`.

import type { VectorBinding, VectorStore } from '../../retrieval/vector-store.js';

// ── Db ─────────────────────────────────────────────────────────
export interface DbStatement {
  sql: string;
  params: unknown[];
}

export interface Db {
  /** Returns the first row, or null. */
  one<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Returns all rows. */
  all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs a write. Returns rows-affected. */
  exec(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  /** Execute multiple statements as a single round-trip / atomic
   *  group. All-or-nothing: any statement failing rolls back the
   *  rest.
   *
   *  CF impl wraps `d1.batch(...)` (D1's atomic-batch primitive).
   *  Node impl wraps a single transaction (BEGIN ... COMMIT / ROLLBACK).
   *
   *  Used by callers that need to write many rows efficiently
   *  (e.g., `insertChunksBatch`); prefer this over a `for`-loop of
   *  `exec()` calls — it's an order-of-magnitude faster on D1 and
   *  ensures atomicity on Postgres. */
  batch(statements: DbStatement[]): Promise<void>;
  /** Run inside a transaction. The CF (D1) implementation is a
   *  no-op wrapper today; the Node (Postgres) implementation
   *  uses BEGIN/COMMIT/ROLLBACK. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

// ── BlobStore ──────────────────────────────────────────────────
export type BlobBody =
  | ReadableStream<Uint8Array>
  | ArrayBuffer
  | Uint8Array
  | string;
export interface BlobPutOpts {
  contentType?: string;
  metadata?: Record<string, string>;
}
export interface BlobHead {
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
}
export interface BlobGet {
  body: ReadableStream<Uint8Array>;
  contentType?: string;
  /** Byte size when the underlying store reports it on GET. Both R2
   *  and S3 GetObject responses include it; we expose it because the
   *  internal back-channel sends `content-length` back to the
   *  Container. */
  size?: number;
}
export interface BlobStore {
  put(key: string, body: BlobBody, opts?: BlobPutOpts): Promise<void>;
  get(key: string): Promise<BlobGet | null>;
  head(key: string): Promise<BlobHead | null>;
  delete(key: string): Promise<void>;
}

// ── KvStore ────────────────────────────────────────────────────
export interface KvStore {
  /** Returns null if missing. `type: 'json'` parses; default is text. */
  get<T = string>(key: string, opts?: { type?: 'json' | 'text' }): Promise<T | null>;
  put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// ── QueueProducer ──────────────────────────────────────────────
export interface QueueProducer {
  send(message: unknown): Promise<void>;
}

// ── ContainerInvoker ───────────────────────────────────────────
export type ContainerOutcome =
  | 'full_success'
  | 'partial_ingestion'
  | 'fatal_failure';
export interface ContainerInvokeResult {
  /** Raw HTTP status from the Container call. The consumer reads
   *  this to decide ack vs retry: 2xx → ack, 409/423 (lease taken
   *  / job terminal) → ack, 5xx / network → retry. */
  status: number;
  /** Outcome from the Container's response body. Present iff
   *  status is 2xx. */
  outcome?: ContainerOutcome;
  /** Optional error string (when status is non-2xx and we read it). */
  error?: string;
}
export interface ContainerInvoker {
  invoke(args: { job_id: string; attempt: number }): Promise<ContainerInvokeResult>;
}

// ── MetricsSink ────────────────────────────────────────────────
export interface MetricsSink {
  /** Emit a metric data point. CF impl writes to Analytics Engine;
   *  Node impl writes one structured JSON line to stdout. Same
   *  shape so callers don't branch. */
  write(point: { indexes: string[]; doubles: number[]; blobs: string[] }): void;
}

// ── BackgroundTasks ────────────────────────────────────────────
export interface BackgroundTasks {
  /** Schedule fire-and-forget work. CF impl ties to
   *  `executionCtx.waitUntil`; Node impl tracks promises and
   *  drains on SIGTERM with a 30s timeout. */
  spawn(promise: Promise<unknown>): void;
}

// ── VectorizeIndexHandle ───────────────────────────────────────
// Structural shape of the Cloudflare Vectorize V2 binding's API
// surface that `VectorizeV2Adapter` actually consumes. Defined here
// (not as `Vectorize` from @cloudflare/workers-types) so the Node
// runtime can compile without CF types in tsconfig.
//
// The CF runtime assigns `env.VECTORIZE_OPENAI_LARGE` directly into
// `bindings.vectorize`; the real `Vectorize` type satisfies this shape
// structurally. The Node runtime sets `bindings.vectorize = undefined`
// and the namespace-create gate (Phase 2 Step 14) refuses
// `vector_backend: 'vectorize'` in self-host mode.
export interface VectorizeIndexHandle {
  upsert(records: unknown[]): Promise<{ mutationId?: string }>;
  query(
    vector: number[],
    opts: { topK: number; filter?: unknown; returnMetadata?: 'all' | 'none' | 'indexed' },
  ): Promise<{ matches: Array<{ id: string; score: number; metadata?: unknown }> }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

// ── WorkersAiBinding ───────────────────────────────────────────
// Structural shape of the Cloudflare Workers AI binding's `run()`
// method. Defined here (not imported as `Ai` from
// @cloudflare/workers-types) so the Node runtime can compile against
// `runtime/shared/interfaces.ts` without CF-specific types.
//
// The CF runtime assigns `env.AI` (which has the real `Ai` type)
// directly into `bindings.ai`; `Ai` satisfies this structural shape.
// The Node runtime sets `bindings.ai = undefined` and
// providers/registry.ts 501s on absence.
export interface WorkersAiBinding {
  run(model: string, args: unknown, options?: unknown): Promise<unknown>;
}

// ── Hasher ─────────────────────────────────────────────────────
export interface Hasher {
  /** Hex-encoded SHA-256 of the entire stream, computed without
   *  buffering. CF impl uses `crypto.DigestStream`; Node impl
   *  pipes the web stream through `node:crypto`'s createHash. */
  sha256OfStream(stream: ReadableStream<Uint8Array>): Promise<string>;
}

// ── SparseSearch ───────────────────────────────────────────────
// Sparse (keyword/lexical) chunk search. Used by the hybrid
// retrieval path to fuse with dense vector results.
//
// CF impl runs SQLite FTS5 against the `chunks_fts` virtual table
// (BM25-ordered).
//
// Node impl (Step 17, deferred): Postgres `tsvector` + `ts_rank`,
// or a sidecar like ParadeDB / Elasticsearch. Postgres has no native
// BM25, so the Step-17 design needs to either accept a different
// scoring function or wire in an extension. Documented as a J-1
// follow-up in `docs/v3/V3_PHASE_2_STEPS_1_15_AUDIT.md`.
//
// The `match` field is a pre-built dialect-specific query expression
// (FTS5 MATCH syntax for CF; Postgres tsquery for Node when it
// lands). Each runtime's caller builds this via its own helper —
// see `apps/api/src/retrieval/fts5-query.ts` for the CF flavor.
export interface SparseSearchArgs {
  tenant_id: string;
  namespace_id: string;
  version_ids: string[];
  artifact_types: string[];
  match: string;
  top_k: number;
}

export interface SparseSearch {
  search(args: SparseSearchArgs): Promise<Array<{ id: string; score: number }>>;
}

// ── VectorStoreFactory ─────────────────────────────────────────
export interface VectorStoreFactory {
  /** Returns a `VectorStore` for the given `VectorBinding`. The
   *  factory closure binds to the runtime's adapter set. */
  forBinding(binding: VectorBinding): VectorStore;
}

// ── AI Gateway (runtime-conditional shape) ─────────────────────
export interface AiGatewayConfig {
  /** Base URL up to but not including the provider segment. CF:
   *  built from `CF_ACCOUNT_ID + AI_GATEWAY_ID`. Node: read from
   *  `AI_GATEWAY_BASE_URL`. */
  baseUrl: string;
  /** Header prefix for tagging metadata. CF: `cf-aig-`. Node:
   *  `x-aig-`. */
  metadataHeaderPrefix: 'cf-aig-' | 'x-aig-';
  /** Provider-name translation (snake_case → wire format). CF
   *  uses dash-cased URL segments (e.g. `workers_ai → workers-ai`);
   *  non-CF is generally permissive. */
  providerSegment: (p: string) => string;
}

// ── Bindings ───────────────────────────────────────────────────
export interface Bindings {
  // Data layer
  db: Db;
  blobs: BlobStore;
  kv: KvStore;
  queue: QueueProducer;
  vectors: VectorStoreFactory;
  /** Sparse (keyword) chunk search. CF: SQLite FTS5; Node: Postgres
   *  tsvector (Step 17 — deferred). */
  sparseSearch: SparseSearch;
  containerInvoker: ContainerInvoker;
  metrics: MetricsSink;
  bg: BackgroundTasks;
  hash: Hasher;

  // Runtime shape — used by code that needs to gate behavior
  // (e.g., Workers AI provider, namespace-create vectorize gating).
  runtime: 'cf' | 'node';

  // Optional CF-only Workers AI binding handle. Absent in Node
  // runtime. Routes that need it read through `bindings.ai` and
  // 501 cleanly when undefined. The shape is defined structurally
  // (not as `Ai` from @cloudflare/workers-types) so the runtime-
  // shared interface doesn't drag CF-specific types into Node code.
  // The CF impl in `runtime/cf/bindings.ts` assigns `env.AI`
  // directly — `Ai` satisfies this shape structurally.
  ai?: WorkersAiBinding;

  // Optional CF-only Vectorize V2 index handle. Absent in Node
  // runtime; the namespace-create gate refuses `vector_backend:
  // 'vectorize'` in self-host mode (Phase 2 Step 14). The factory
  // `bindings.vectors.forBinding(b)` reads this when constructing a
  // `VectorizeV2Adapter`.
  vectorize?: VectorizeIndexHandle;

  // Stateless config — common to both runtimes. `runtimeEnv`
  // (not `env`, which conflicts with the legacy `Env.ENV` shape
  // during the migration period) is the deploy environment label.
  runtimeEnv: 'dev' | 'prod' | 'self-host';
  apiKeyPepper: string;
  internalHmacSecret?: string;
  adminBootstrapToken?: string;
  auditHashSalt?: string;
  workerInternalUrl?: string;

  // AI Gateway — runtime-conditional shape; absent → providers go direct
  aiGateway?: AiGatewayConfig;

  // Pluggable vector backend env. Same shape both runtimes; the
  // selector in retrieval/vector-store.ts reads these.
  qdrantUrl?: string;
  qdrantApiKey?: string;
  pineconeApiKey?: string;
}
