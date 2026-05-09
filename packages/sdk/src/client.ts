// Typed REST client. Every method maps to one route; every response
// is shaped by `@textral/contracts`. Resilience features added in
// 0.2.x: retry/backoff (`retry.ts`), streaming SSE (`stream.ts`),
// pagination iterators (`paginate.ts`), AbortSignal cancellation,
// and `~/.textral/profiles.toml` resolution (`@textral/profiles`).
//
// All resilience layers are additive — the existing constructor
// shape continues to work unchanged. New ergonomics:
//
//   * `new TextralClient({ baseUrl, apiKey })` — explicit, eager.
//   * `new TextralClient({ profile: 'hosted-prod' })` — lazy
//     resolution on first request. Errors surface there, not in
//     the constructor (which can't be async).
//   * `await TextralClient.fromProfile('hosted-prod')` — static
//     factory; resolves up front so any error throws immediately.

import type {
  NamespaceCreate as NamespaceCreateSchema,
  IngestRequest as IngestRequestSchema,
  QueryRequest as QueryRequestSchema,
  BulkSubmitRequest as BulkSubmitRequestSchema,
} from '@textral/contracts';
import type { z } from 'zod';
import type {
  Namespace,
  Document,
  IngestionJob,
  KnownModel,
  ListModelsQuery,
  QueryResponse,
  QueryEvent,
  ProviderKey,
  ProviderKeyCreate,
  InfraKey,
  InfraKeyCreate,
  InfraKeyTestResponse,
  Chunk,
  UploadResponse,
  FinalizeResponse,
  BulkSubmitResponse,
  BulkJobStatus,
  BulkJobFile,
  BulkJobFileListResponse,
  BulkJobListResponse,
  BulkJobOk,
} from '@textral/contracts';
import { resolveProfile, type Profile } from '@textral/profiles';
import { TextralApiError } from './errors.js';
import {
  DEFAULT_RETRY,
  parseRetryAfter,
  withRetry,
  type RetryPolicy,
  type RequestContext,
} from './retry.js';
import { paginate } from './paginate.js';
import { streamSse } from './stream.js';

// Input shapes use `z.input<>` so callers can omit fields with
// `.default(...)` values; the schema's `.parse(...)` on the server
// applies them.
type NamespaceCreateInput = z.input<typeof NamespaceCreateSchema>;
type IngestRequestInput = z.input<typeof IngestRequestSchema>;
type QueryRequestInput = z.input<typeof QueryRequestSchema>;
type BulkSubmitRequestInput = z.input<typeof BulkSubmitRequestSchema>;

export interface TextralClientOptions {
  /** Explicit endpoint. Required if `profile` isn't set. */
  baseUrl?: string;
  /** Explicit API key. Required if `profile` isn't set. */
  apiKey?: string;
  /** Profile name from `~/.textral/profiles.toml`. When set without
   *  `baseUrl`/`apiKey`, the client lazily resolves on the first
   *  request. Use `TextralClient.fromProfile(...)` if you'd rather
   *  surface resolution errors at construction time. */
  profile?: string;
  /** Retry policy. See `retry.ts` for the default. Pass `false` to
   *  disable retries entirely. */
  retry?: RetryPolicy | false;
  /** Override `globalThis.fetch` — useful for tests. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in ms. The signal aborts the in-flight
   *  request when exceeded. Default 30_000. Pass `0` to disable. */
  timeoutMs?: number;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';

export interface QueryEventListResponse {
  data: QueryEvent[];
  next_cursor: string | null;
}
export interface DocumentListResponse {
  data: Document[];
  next_cursor: string | null;
}
export interface ChunkListResponse {
  data: Chunk[];
  next_cursor: string | null;
}
export interface FailingJobsResponse {
  items: IngestionJob[];
  next_cursor: string | null;
}

export interface MeResponse {
  tenant: { id: string; display_name: string; plan: string; created_at: number };
  api_key_id: string;
  runtime: 'cf' | 'node';
}

export interface ProviderKeyTestResponse {
  ok: boolean;
  error_code?: string;
  error_message?: string;
}

export interface IngestionJobCreateResponse {
  job_id: string;
  status: string;
  version_index_id: string;
}

/** Discriminated union of frames the streaming query endpoint
 *  emits. Yielded one-at-a-time by `client.query.stream(...)`. */
export type QueryStreamFrame =
  | { type: 'token'; value: string }
  | { type: 'citation'; ordinal: number; chunk_id: string; section_path: string }
  | { type: 'audit'; query_event_id: string; [k: string]: unknown }
  | { type: 'done' };

export interface RequestOptions {
  /** Cancel the in-flight HTTP request. Aborting also bails out of
   *  any in-flight retry-backoff sleep. Independent of the
   *  per-request timeout (`timeoutMs`). */
  signal?: AbortSignal;
}

function qs(obj: Record<string, unknown>, leader: '?' | '&' = '?'): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length === 0 ? '' : `${leader}${parts.join('&')}`;
}

/** Replace prefixed-ULID segments with `{id}` so route paths can be
 *  matched against the retry-allowlist patterns. Stable for our
 *  ID shape (`pkey_…`, `doc_…`, `ver_…`, `bjk_…`, `bjku_…`, etc.);
 *  doesn't touch namespace slugs (lowercase + dashes, no
 *  underscore-26-char-base32 suffix). */
const ULID_SEGMENT = /\/[a-z]{2,5}_[A-Z0-9]{26}/g;
function normalizePath(path: string): string {
  return path.replace(ULID_SEGMENT, '/{id}').split('?')[0]!;
}

export class TextralClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly retry: RetryPolicy | false;
  private readonly timeoutMs: number;
  /** Cached after the first resolution. Set immediately when
   *  baseUrl+apiKey are passed; resolved lazily on first request
   *  when only `profile` was passed. */
  private resolved: { baseUrl: string; apiKey: string } | null = null;
  private readonly profileName: string | undefined;

  constructor(opts: TextralClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.profileName = opts.profile;

    if (opts.baseUrl && opts.apiKey) {
      this.resolved = {
        baseUrl: opts.baseUrl.replace(/\/$/, ''),
        apiKey: opts.apiKey,
      };
    } else if (!opts.profile) {
      throw new Error(
        'TextralClient: either {baseUrl, apiKey} or {profile} must be supplied. ' +
          'For lazy ~/.textral/profiles.toml resolution, pass {profile: "..."}; ' +
          'for explicit credentials, pass {baseUrl, apiKey}.',
      );
    }
    // else: profile-only construction. Resolution deferred to
    // _ensureResolved() on the first request.
  }

  /** Async factory. Resolves the named profile (or the default
   *  precedence chain when `name` is undefined) before returning a
   *  fully-configured client. Use this when you want resolution
   *  errors to surface at construction time. */
  static async fromProfile(
    name?: string,
    opts: Omit<TextralClientOptions, 'baseUrl' | 'apiKey' | 'profile'> = {},
  ): Promise<TextralClient> {
    const profile = await resolveProfile(name !== undefined ? { name } : {});
    return new TextralClient({
      ...opts,
      baseUrl: profile.base_url,
      apiKey: profile.api_key,
    });
  }

  // ── tenancy ─────────────────────────────────────────────────────
  me(opts?: RequestOptions): Promise<MeResponse> {
    return this._call<MeResponse>('GET', '/v1/me', undefined, opts);
  }

  // ── namespaces ──────────────────────────────────────────────────
  namespaces = {
    list: (opts?: RequestOptions): Promise<{ data: Namespace[] }> =>
      this._call<{ data: Namespace[] }>('GET', '/v1/namespaces', undefined, opts),
    create: (body: NamespaceCreateInput, opts?: RequestOptions): Promise<Namespace> =>
      this._call<Namespace>('POST', '/v1/namespaces', body, opts),
    get: (slug: string, opts?: RequestOptions): Promise<Namespace> =>
      this._call<Namespace>('GET', `/v1/namespaces/${encodeURIComponent(slug)}`, undefined, opts),
    listDocuments: (
      slug: string,
      q: { limit?: number; cursor?: string } = {},
      opts?: RequestOptions,
    ): Promise<DocumentListResponse> =>
      this._call<DocumentListResponse>(
        'GET',
        `/v1/namespaces/${encodeURIComponent(slug)}/documents${qs(q)}`,
        undefined,
        opts,
      ),
    /** Async iterator over all documents in a namespace. Pages
     *  through `next_cursor` until exhausted. Aborts cleanly via
     *  `opts.signal`. */
    iterateDocuments: (
      slug: string,
      q: { limit?: number } = {},
      opts: RequestOptions = {},
    ): AsyncIterable<Document> =>
      paginate<Document>(
        async (cursor) => {
          const params: { limit?: number; cursor?: string } = {};
          if (q.limit !== undefined) params.limit = q.limit;
          if (cursor !== null) params.cursor = cursor;
          return this.namespaces.listDocuments(slug, params, opts);
        },
        opts.signal !== undefined ? { signal: opts.signal } : {},
      ),
  };

  // ── documents ───────────────────────────────────────────────────
  documents = {
    register: (
      slug: string,
      body: { title?: string; doc_type?: string; metadata?: Record<string, unknown> },
      opts?: RequestOptions,
    ): Promise<Document> =>
      this._call<Document>(
        'POST',
        `/v1/namespaces/${encodeURIComponent(slug)}/documents`,
        body,
        opts,
      ),
    get: (id: string, opts?: RequestOptions): Promise<Document> =>
      this._call<Document>('GET', `/v1/documents/${encodeURIComponent(id)}`, undefined, opts),
    createUpload: (
      id: string,
      body: { content_type: string; size_bytes: number },
      opts?: RequestOptions,
    ): Promise<UploadResponse> =>
      this._call<UploadResponse>(
        'POST',
        `/v1/documents/${encodeURIComponent(id)}/uploads`,
        body,
        opts,
      ),
    putUploadBytes: (
      uploadUrl: string,
      body: Uint8Array,
      contentType: string,
      opts?: RequestOptions,
    ): Promise<Response> => {
      // BodyInit's typed union doesn't accept `Uint8Array<ArrayBufferLike>`
      // (the recent TS narrowing distinguishes ArrayBuffer from
      // SharedArrayBuffer). The runtime accepts ArrayBuffer cleanly, so
      // pass `body.buffer` after slicing to guarantee a fresh,
      // non-shared ArrayBuffer.
      const ab: ArrayBuffer = body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ) as ArrayBuffer;
      return this._raw('PUT', this._absoluteToPath(uploadUrl), ab, {
        'content-type': contentType,
      }, opts);
    },
    finalize: (id: string, uploadId: string, opts?: RequestOptions): Promise<FinalizeResponse> =>
      this._call<FinalizeResponse>(
        'POST',
        `/v1/documents/${encodeURIComponent(id)}/uploads/${encodeURIComponent(uploadId)}/finalize`,
        {},
        opts,
      ),
    ingest: (
      id: string,
      body: IngestRequestInput,
      opts?: RequestOptions,
    ): Promise<IngestionJobCreateResponse> =>
      this._call<IngestionJobCreateResponse>(
        'POST',
        `/v1/documents/${encodeURIComponent(id)}/ingest`,
        body,
        opts,
      ),
    listChunks: (
      id: string,
      q: {
        limit?: number;
        cursor?: string;
        artifact_type?: string;
        version_id?: string;
      } = {},
      opts?: RequestOptions,
    ): Promise<ChunkListResponse> =>
      this._call<ChunkListResponse>(
        'GET',
        `/v1/documents/${encodeURIComponent(id)}/chunks${qs(q)}`,
        undefined,
        opts,
      ),
    iterateChunks: (
      id: string,
      q: { limit?: number; artifact_type?: string; version_id?: string } = {},
      opts: RequestOptions = {},
    ): AsyncIterable<Chunk> =>
      paginate<Chunk>(
        async (cursor) => {
          const params: typeof q & { cursor?: string } = { ...q };
          if (cursor !== null) params.cursor = cursor;
          return this.documents.listChunks(id, params, opts);
        },
        opts.signal !== undefined ? { signal: opts.signal } : {},
      ),
  };

  // ── chunks ──────────────────────────────────────────────────────
  chunks = {
    get: (id: string, opts?: RequestOptions): Promise<Chunk> =>
      this._call<Chunk>('GET', `/v1/chunks/${encodeURIComponent(id)}`, undefined, opts),
  };

  // ── ingestion jobs ──────────────────────────────────────────────
  ingestionJobs = {
    get: (id: string, opts?: RequestOptions): Promise<IngestionJob> =>
      this._call<IngestionJob>(
        'GET',
        `/v1/ingestion-jobs/${encodeURIComponent(id)}`,
        undefined,
        opts,
      ),
    retry: (id: string, opts?: RequestOptions): Promise<void> =>
      this._call<void>(
        'POST',
        `/v1/ingestion-jobs/${encodeURIComponent(id)}/retry`,
        undefined,
        opts,
      ),
  };

  // ── query ───────────────────────────────────────────────────────
  query = Object.assign(
    (body: QueryRequestInput, opts?: RequestOptions): Promise<QueryResponse> =>
      this._call<QueryResponse>('POST', '/v1/query', body, opts),
    {
      /** Async iterator over SSE frames from `POST /v1/query?stream=sse`.
       *  Yielded frames are typed as `QueryStreamFrame`. The stream
       *  is *not* retried on transient failure — callers see a
       *  `TextralStreamInterrupted` and decide whether to re-issue. */
      stream: (body: QueryRequestInput, opts: RequestOptions = {}): AsyncIterable<QueryStreamFrame> =>
        this._streamQuery(body, opts),
    },
  );

  queryEvents = {
    list: (
      q: {
        limit?: number;
        cursor?: string;
        namespace_slug?: string;
        status?: string;
      } = {},
      opts?: RequestOptions,
    ): Promise<QueryEventListResponse> =>
      this._call<QueryEventListResponse>('GET', `/v1/query-events${qs(q)}`, undefined, opts),
    get: (id: string, opts?: RequestOptions): Promise<QueryEvent> =>
      this._call<QueryEvent>('GET', `/v1/query-events/${encodeURIComponent(id)}`, undefined, opts),
    getResponse: (id: string, opts?: RequestOptions): Promise<QueryResponse> =>
      this._call<QueryResponse>(
        'GET',
        `/v1/query-events/${encodeURIComponent(id)}/response`,
        undefined,
        opts,
      ),
    iterate: (
      q: { namespace_slug?: string; status?: string; limit?: number } = {},
      opts: RequestOptions = {},
    ): AsyncIterable<QueryEvent> =>
      paginate<QueryEvent>(
        async (cursor) => {
          const params: typeof q & { cursor?: string } = { ...q };
          if (cursor !== null) params.cursor = cursor;
          return this.queryEvents.list(params, opts);
        },
        opts.signal !== undefined ? { signal: opts.signal } : {},
      ),
  };

  // ── provider keys ───────────────────────────────────────────────
  providerKeys = {
    list: (opts?: RequestOptions): Promise<{ data: ProviderKey[] }> =>
      this._call<{ data: ProviderKey[] }>('GET', '/v1/provider-keys', undefined, opts),
    create: (body: ProviderKeyCreate, opts?: RequestOptions): Promise<ProviderKey> =>
      this._call<ProviderKey>('POST', '/v1/provider-keys', body, opts),
    test: (id: string, opts?: RequestOptions): Promise<ProviderKeyTestResponse> =>
      this._call<ProviderKeyTestResponse>(
        'POST',
        `/v1/provider-keys/${encodeURIComponent(id)}/test`,
        undefined,
        opts,
      ),
  };

  // ── infra keys ──────────────────────────────────────────────────
  infraKeys = {
    list: (opts?: RequestOptions): Promise<{ data: InfraKey[] }> =>
      this._call<{ data: InfraKey[] }>('GET', '/v1/infra-keys', undefined, opts),
    create: (body: InfraKeyCreate, opts?: RequestOptions): Promise<InfraKey> =>
      this._call<InfraKey>('POST', '/v1/infra-keys', body, opts),
    test: (id: string, opts?: RequestOptions): Promise<InfraKeyTestResponse> =>
      this._call<InfraKeyTestResponse>(
        'POST',
        `/v1/infra-keys/${encodeURIComponent(id)}/test`,
        undefined,
        opts,
      ),
    revoke: (id: string, opts?: RequestOptions): Promise<{ ok: true }> =>
      this._call<{ ok: true }>(
        'DELETE',
        `/v1/infra-keys/${encodeURIComponent(id)}`,
        undefined,
        opts,
      ),
  };

  // ── bulk ingest ─────────────────────────────────────────────────
  bulkIngest = {
    submit: (body: BulkSubmitRequestInput, opts?: RequestOptions): Promise<BulkSubmitResponse> =>
      this._call<BulkSubmitResponse>('POST', '/v1/ingest/bulk', body, opts),
    finalize: (id: string, opts?: RequestOptions): Promise<BulkJobOk> =>
      this._call<BulkJobOk>(
        'POST',
        `/v1/ingest/bulk/${encodeURIComponent(id)}/finalize`,
        undefined,
        opts,
      ),
    get: (id: string, opts?: RequestOptions): Promise<BulkJobStatus> =>
      this._call<BulkJobStatus>(
        'GET',
        `/v1/ingest/bulk/${encodeURIComponent(id)}`,
        undefined,
        opts,
      ),
    files: (
      id: string,
      q: { state?: string; page?: number; page_size?: number } = {},
      opts?: RequestOptions,
    ): Promise<BulkJobFileListResponse> =>
      this._call<BulkJobFileListResponse>(
        'GET',
        `/v1/ingest/bulk/${encodeURIComponent(id)}/files${qs(q)}`,
        undefined,
        opts,
      ),
    iterateFiles: (
      id: string,
      q: { state?: string; page_size?: number } = {},
      opts: RequestOptions = {},
    ): AsyncIterable<BulkJobFile> =>
      paginate<BulkJobFile>(
        async (cursor) => {
          // The /files route's "next_cursor" is actually the next
          // page number as a string. paginate() doesn't care — it
          // just forwards the opaque cursor.
          const params: { state?: string; page?: number; page_size?: number } = { ...q };
          if (cursor !== null) params.page = Number(cursor);
          return this.bulkIngest.files(id, params, opts);
        },
        opts.signal !== undefined ? { signal: opts.signal } : {},
      ),
    cancel: (id: string, opts?: RequestOptions): Promise<BulkJobOk> =>
      this._call<BulkJobOk>(
        'DELETE',
        `/v1/ingest/bulk/${encodeURIComponent(id)}`,
        undefined,
        opts,
      ),
    retry: (id: string, opts?: RequestOptions): Promise<BulkJobOk> =>
      this._call<BulkJobOk>(
        'POST',
        `/v1/ingest/bulk/${encodeURIComponent(id)}/retry`,
        undefined,
        opts,
      ),
    list: (
      q: { namespace?: string; state?: string; limit?: number; cursor?: string } = {},
      opts?: RequestOptions,
    ): Promise<BulkJobListResponse> =>
      this._call<BulkJobListResponse>('GET', `/v1/ingest/bulk${qs(q)}`, undefined, opts),
    iterate: (
      q: { namespace?: string; state?: string; limit?: number } = {},
      opts: RequestOptions = {},
    ): AsyncIterable<BulkJobStatus> =>
      paginate<BulkJobStatus>(
        async (cursor) => {
          const params: typeof q & { cursor?: string } = { ...q };
          if (cursor !== null) params.cursor = cursor;
          return this.bulkIngest.list(params, opts);
        },
        opts.signal !== undefined ? { signal: opts.signal } : {},
      ),
    /** Per-file PUT URL the submit response gives back. Caller PUTs
     *  directly. Requires the credential context to be resolved
     *  (will throw if used before any prior request resolved a
     *  profile-only client). For lazy clients, call `await
     *  client.me()` once first to force resolution. */
    uploadUrlFor: (bulkJobId: string, ordinal: number): string => {
      if (!this.resolved) {
        throw new Error(
          'TextralClient.bulkIngest.uploadUrlFor: credentials not resolved yet. ' +
            'Call any other method first (e.g. `await client.me()`), or use ' +
            '`TextralClient.fromProfile(...)` for eager resolution.',
        );
      }
      return `${this.resolved.baseUrl}/v1/ingest/bulk/${encodeURIComponent(bulkJobId)}/files/${ordinal}/data`;
    },
  };

  // ── admin ───────────────────────────────────────────────────────
  admin = {
    listFailingJobs: (
      q: { limit?: number; cursor?: string } = {},
      opts?: RequestOptions,
    ): Promise<FailingJobsResponse> =>
      this._call<FailingJobsResponse>(
        'GET',
        `/v1/admin/ingestion-jobs?dead_lettered=1${qs(q, '&')}`,
        undefined,
        opts,
      ),
    iterateFailingJobs: (
      q: { limit?: number } = {},
      opts: RequestOptions = {},
    ): AsyncIterable<IngestionJob> =>
      paginate<IngestionJob>(
        async (cursor) => {
          const params: typeof q & { cursor?: string } = { ...q };
          if (cursor !== null) params.cursor = cursor;
          // FailingJobsResponse uses `items`, not `data`. Map for the
          // generic paginate() helper.
          const r = await this.admin.listFailingJobs(params, opts);
          return { data: r.items, next_cursor: r.next_cursor };
        },
        opts.signal !== undefined ? { signal: opts.signal } : {},
      ),
  };

  // ── models registry ─────────────────────────────────────────────
  models = {
    list: (q: ListModelsQuery = {}, opts?: RequestOptions): Promise<{ data: KnownModel[] }> => {
      const params: Record<string, unknown> = {};
      if (q.provider) params.provider = q.provider;
      if (q.kind) params.kind = q.kind;
      if (q.include_deprecated) params.include_deprecated = 'true';
      return this._call<{ data: KnownModel[] }>('GET', `/v1/models${qs(params)}`, undefined, opts);
    },
  };

  // ── reference resources (used by MCP `textral://*` resources) ───
  raw(path: string, opts?: RequestOptions): Promise<Response> {
    return this._raw('GET', path, undefined, {}, opts);
  }

  // ── internal: MCP tool-call audit (stdio writer) ────────────────
  internal = {
    submitMcpToolCall: (
      event: {
        tool_name: string;
        transport: 'stdio' | 'http';
        args_redacted: unknown;
        rest_call_count: number;
        latency_ms: number;
        outcome: 'ok' | 'tool_error' | 'rest_error' | 'cancelled';
        error_code?: string;
        error_message?: string;
      },
      opts?: RequestOptions,
    ): Promise<{ ok: true }> =>
      this._call<{ ok: true }>('POST', '/v1/_internal/mcp_tool_calls', event, opts),
  };

  // ── core ────────────────────────────────────────────────────────

  /** Lazy-resolve credentials. Idempotent. Called automatically
   *  before any request fires. */
  private async _ensureResolved(): Promise<{ baseUrl: string; apiKey: string }> {
    if (this.resolved) return this.resolved;
    const profile: Profile = await resolveProfile(
      this.profileName !== undefined ? { name: this.profileName } : {},
    );
    this.resolved = {
      baseUrl: profile.base_url.replace(/\/$/, ''),
      apiKey: profile.api_key,
    };
    return this.resolved;
  }

  /** Build a combined AbortSignal that fires when EITHER the caller's
   *  signal aborts OR the per-request timeout elapses. Returns null
   *  for the signal slot when neither applies (so we don't pass a
   *  no-op signal to fetch). */
  private _buildSignal(callerSignal?: AbortSignal): {
    signal: AbortSignal | undefined;
    cleanup: () => void;
  } {
    const useTimeout = this.timeoutMs > 0;
    if (!callerSignal && !useTimeout) {
      return { signal: undefined, cleanup: () => {} };
    }
    const ac = new AbortController();
    const onCallerAbort = () => ac.abort(callerSignal?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) ac.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (useTimeout) {
      timeout = setTimeout(() => ac.abort(new Error(`Timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
    }
    return {
      signal: ac.signal,
      cleanup: () => {
        if (timeout) clearTimeout(timeout);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      },
    };
  }

  /** The upload PUT URL the API mints is absolute
   *  (`http://host:port/v1/...`). When we run under stdio we want to
   *  pass it straight through; when we run inside the same process
   *  (no networking), we'd want just the path. The MCP server only
   *  ever calls this from outside the api process, so absolute is
   *  fine, but normalize so absolute → absolute and relative →
   *  joined with baseUrl. */
  private _absoluteToPath(url: string): string {
    return url;
  }

  private async _call<T>(
    method: Method,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const { baseUrl, apiKey } = await this._ensureResolved();
    const isAbsolute = path.startsWith('http://') || path.startsWith('https://');
    const url = isAbsolute ? path : `${baseUrl}${path}`;
    const ctx: RequestContext = {
      method,
      routePattern: normalizePath(isAbsolute ? new URL(path).pathname : path),
    };
    const fire = async (): Promise<T> => {
      const { signal, cleanup } = this._buildSignal(opts?.signal);
      try {
        const headers: Record<string, string> = {
          'x-textral-api-key': apiKey,
          accept: 'application/json',
        };
        const init: RequestInit = { method, headers };
        if (signal) init.signal = signal;
        if (body !== undefined) {
          headers['content-type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
        const res = await this.fetchImpl(url, init);
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        if (!res.ok) {
          this._throwFromResponse(res, text);
        }
        return text ? (JSON.parse(text) as T) : (undefined as T);
      } finally {
        cleanup();
      }
    };
    if (this.retry === false) return fire();
    return withRetry(fire, this.retry, ctx, opts?.signal);
  }

  private async _raw(
    method: Method,
    path: string,
    body: BodyInit | undefined,
    extraHeaders: Record<string, string>,
    opts?: RequestOptions,
  ): Promise<Response> {
    const { baseUrl, apiKey } = await this._ensureResolved();
    const isAbsolute = path.startsWith('http://') || path.startsWith('https://');
    const url = isAbsolute ? path : `${baseUrl}${path}`;
    const { signal, cleanup } = this._buildSignal(opts?.signal);
    try {
      const headers: Record<string, string> = {
        'x-textral-api-key': apiKey,
        ...extraHeaders,
      };
      const init: RequestInit = { method, headers };
      if (signal) init.signal = signal;
      if (body !== undefined) init.body = body;
      return await this.fetchImpl(url, init);
    } finally {
      cleanup();
    }
  }

  /** Streaming query. Returns an async iterable of typed frames.
   *  Streams are deliberately not retried; an interrupted stream
   *  surfaces `TextralStreamInterrupted`. */
  private async *_streamQuery(
    body: QueryRequestInput,
    opts: RequestOptions,
  ): AsyncIterable<QueryStreamFrame> {
    const { baseUrl, apiKey } = await this._ensureResolved();
    const url = `${baseUrl}/v1/query?stream=sse`;
    const { signal, cleanup } = this._buildSignal(opts.signal);
    let res: Response;
    try {
      const headers: Record<string, string> = {
        'x-textral-api-key': apiKey,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      };
      const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body) };
      if (signal) init.signal = signal;
      res = await this.fetchImpl(url, init);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this._throwFromResponse(res, text);
      }
      if (!res.body) {
        // Should never happen — SSE responses always carry a body.
        cleanup();
        throw new Error('streaming response missing body');
      }
    } catch (err) {
      cleanup();
      throw err;
    }
    try {
      const opts2 = signal !== undefined ? { signal } : {};
      for await (const frame of streamSse<QueryStreamFrame>(res.body, opts2)) {
        yield frame;
        if (frame.type === 'done') return;
      }
    } finally {
      cleanup();
    }
  }

  private _throwFromResponse(res: Response, text: string): never {
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    if (text) {
      try {
        const obj = JSON.parse(text) as {
          error?: { code?: string; message?: string; request_id?: string; details?: unknown };
        };
        if (obj?.error?.code) {
          throw new TextralApiError(
            res.status,
            obj.error.code,
            obj.error.message ?? `HTTP ${res.status}`,
            obj.error.request_id,
            obj.error.details,
            retryAfter,
          );
        }
      } catch (e) {
        if (e instanceof TextralApiError) throw e;
        // fall through to UNKNOWN
      }
    }
    throw new TextralApiError(res.status, 'UNKNOWN', text || `HTTP ${res.status}`, undefined, undefined, retryAfter);
  }
}
