// Typed REST client. Every method is one route; every response is
// shaped by the corresponding `@textral/contracts` schema. No retry
// logic, no caching — the server is the source of truth for both.
//
// Used by `@textral/mcp` today. The sandbox can adopt it after Phase
// 1 lands.

import {
  NamespaceCreate as NamespaceCreateSchema,
  IngestRequest as IngestRequestSchema,
} from '@textral/contracts';
import type { z } from 'zod';
import type {
  Namespace,
  Document,
  IngestionJob,
  KnownModel,
  ListModelsQuery,
  QueryRequest,
  QueryResponse,
  QueryEvent,
  ProviderKey,
  ProviderKeyCreate,
  Chunk,
  UploadResponse,
  FinalizeResponse,
} from '@textral/contracts';
import { TextralApiError } from './errors.js';

// Input shapes use `z.input<>` so caller can omit fields with `.default(...)`
// values; the schema's `.parse(...)` on the server applies them.
type NamespaceCreateInput = z.input<typeof NamespaceCreateSchema>;
type IngestRequestInput = z.input<typeof IngestRequestSchema>;

export interface TextralClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Override fetch — useful for tests. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';

interface QueryEventListResponse {
  data: QueryEvent[];
  next_cursor: string | null;
}
interface DocumentListResponse {
  data: Document[];
  next_cursor: string | null;
}
interface ChunkListResponse {
  data: Chunk[];
  next_cursor: string | null;
}
interface FailingJobsResponse {
  items: IngestionJob[];
  next_cursor: string | null;
}

interface MeResponse {
  tenant: { id: string; display_name: string; plan: string; created_at: number };
  api_key_id: string;
}

interface ProviderKeyTestResponse {
  ok: boolean;
  error_code?: string;
  error_message?: string;
}

interface IngestionJobCreateResponse {
  job_id: string;
  status: string;
  version_index_id: string;
}

function qs(obj: Record<string, unknown>, leader: '?' | '&' = '?'): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length === 0 ? '' : `${leader}${parts.join('&')}`;
}

export class TextralClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: TextralClientOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
  }

  // ── tenancy ─────────────────────────────────────────────────────
  me(): Promise<MeResponse> {
    return this._call<MeResponse>('GET', '/v1/me');
  }

  // ── namespaces ──────────────────────────────────────────────────
  namespaces = {
    list: (): Promise<{ data: Namespace[] }> =>
      this._call<{ data: Namespace[] }>('GET', '/v1/namespaces'),
    create: (body: NamespaceCreateInput): Promise<Namespace> =>
      this._call<Namespace>('POST', '/v1/namespaces', body),
    get: (slug: string): Promise<Namespace> =>
      this._call<Namespace>('GET', `/v1/namespaces/${encodeURIComponent(slug)}`),
    listDocuments: (
      slug: string,
      q: { limit?: number; cursor?: string } = {},
    ): Promise<DocumentListResponse> =>
      this._call<DocumentListResponse>(
        'GET',
        `/v1/namespaces/${encodeURIComponent(slug)}/documents${qs(q)}`,
      ),
  };

  // ── documents ───────────────────────────────────────────────────
  documents = {
    register: (
      slug: string,
      body: { title?: string; doc_type?: string; metadata?: Record<string, unknown> },
    ): Promise<Document> =>
      this._call<Document>(
        'POST',
        `/v1/namespaces/${encodeURIComponent(slug)}/documents`,
        body,
      ),
    get: (id: string): Promise<Document> =>
      this._call<Document>('GET', `/v1/documents/${encodeURIComponent(id)}`),
    createUpload: (
      id: string,
      body: { content_type: string; size_bytes: number },
    ): Promise<UploadResponse> =>
      this._call<UploadResponse>('POST', `/v1/documents/${encodeURIComponent(id)}/uploads`, body),
    putUploadBytes: (
      uploadUrl: string,
      body: Uint8Array,
      contentType: string,
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
      });
    },
    finalize: (id: string, uploadId: string): Promise<FinalizeResponse> =>
      this._call<FinalizeResponse>(
        'POST',
        `/v1/documents/${encodeURIComponent(id)}/uploads/${encodeURIComponent(uploadId)}/finalize`,
        {},
      ),
    ingest: (id: string, body: IngestRequestInput): Promise<IngestionJobCreateResponse> =>
      this._call<IngestionJobCreateResponse>(
        'POST',
        `/v1/documents/${encodeURIComponent(id)}/ingest`,
        body,
      ),
    listChunks: (
      id: string,
      q: {
        limit?: number;
        cursor?: string;
        artifact_type?: string;
        version_id?: string;
      } = {},
    ): Promise<ChunkListResponse> =>
      this._call<ChunkListResponse>(
        'GET',
        `/v1/documents/${encodeURIComponent(id)}/chunks${qs(q)}`,
      ),
  };

  // ── chunks ──────────────────────────────────────────────────────
  chunks = {
    get: (id: string): Promise<Chunk> =>
      this._call<Chunk>('GET', `/v1/chunks/${encodeURIComponent(id)}`),
  };

  // ── ingestion jobs ──────────────────────────────────────────────
  ingestionJobs = {
    get: (id: string): Promise<IngestionJob> =>
      this._call<IngestionJob>('GET', `/v1/ingestion-jobs/${encodeURIComponent(id)}`),
    retry: (id: string): Promise<void> =>
      this._call<void>('POST', `/v1/ingestion-jobs/${encodeURIComponent(id)}/retry`),
  };

  // ── query ───────────────────────────────────────────────────────
  query(body: QueryRequest): Promise<QueryResponse> {
    return this._call<QueryResponse>('POST', '/v1/query', body);
  }

  queryEvents = {
    list: (
      q: {
        limit?: number;
        cursor?: string;
        namespace_slug?: string;
        status?: string;
      } = {},
    ): Promise<QueryEventListResponse> =>
      this._call<QueryEventListResponse>('GET', `/v1/query-events${qs(q)}`),
    get: (id: string): Promise<QueryEvent> =>
      this._call<QueryEvent>('GET', `/v1/query-events/${encodeURIComponent(id)}`),
    getResponse: (id: string): Promise<QueryResponse> =>
      this._call<QueryResponse>('GET', `/v1/query-events/${encodeURIComponent(id)}/response`),
  };

  // ── provider keys ───────────────────────────────────────────────
  providerKeys = {
    list: (): Promise<{ data: ProviderKey[] }> =>
      this._call<{ data: ProviderKey[] }>('GET', '/v1/provider-keys'),
    create: (body: ProviderKeyCreate): Promise<ProviderKey> =>
      this._call<ProviderKey>('POST', '/v1/provider-keys', body),
    test: (id: string): Promise<ProviderKeyTestResponse> =>
      this._call<ProviderKeyTestResponse>(
        'POST',
        `/v1/provider-keys/${encodeURIComponent(id)}/test`,
      ),
  };

  // ── admin ───────────────────────────────────────────────────────
  admin = {
    listFailingJobs: (
      q: { limit?: number; cursor?: string } = {},
    ): Promise<FailingJobsResponse> =>
      this._call<FailingJobsResponse>(
        'GET',
        `/v1/admin/ingestion-jobs?dead_lettered=1${qs(q, '&')}`,
      ),
  };

  // ── models registry ─────────────────────────────────────────────
  models = {
    list: (q: ListModelsQuery = {}): Promise<{ data: KnownModel[] }> => {
      const params: Record<string, unknown> = {};
      if (q.provider) params.provider = q.provider;
      if (q.kind) params.kind = q.kind;
      if (q.include_deprecated) params.include_deprecated = 'true';
      return this._call<{ data: KnownModel[] }>('GET', `/v1/models${qs(params)}`);
    },
  };

  // ── reference resources (used by MCP `textral://*` resources) ───
  raw(path: string): Promise<Response> {
    return this._raw('GET', path, undefined, {});
  }

  // ── internal: MCP tool-call audit (stdio writer) ────────────────
  internal = {
    submitMcpToolCall: (event: {
      tool_name: string;
      transport: 'stdio' | 'http';
      args_redacted: unknown;
      rest_call_count: number;
      latency_ms: number;
      outcome: 'ok' | 'tool_error' | 'rest_error' | 'cancelled';
      error_code?: string;
      error_message?: string;
    }): Promise<{ ok: true }> =>
      this._call<{ ok: true }>('POST', '/v1/_internal/mcp_tool_calls', event),
  };

  // ── core ────────────────────────────────────────────────────────
  /** The upload PUT URL the API mints is absolute
   *  (`http://host:port/v1/...`). When we run under stdio we want to
   *  pass it straight through; when we run inside the same process
   *  (no networking), we'd want just the path. The MCP server only
   *  ever calls this from outside the api process, so absolute is
   *  fine, but normalize so absolute → absolute and relative →
   *  joined with baseUrl. */
  private _absoluteToPath(url: string): string {
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return url;
  }

  private async _call<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const isAbsolute = path.startsWith('http://') || path.startsWith('https://');
    const url = isAbsolute ? path : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'x-textral-api-key': this.apiKey,
      accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(url, init);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      this._throwFromBody(res.status, text);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private async _raw(
    method: Method,
    path: string,
    body: BodyInit | undefined,
    extraHeaders: Record<string, string>,
  ): Promise<Response> {
    const isAbsolute = path.startsWith('http://') || path.startsWith('https://');
    const url = isAbsolute ? path : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'x-textral-api-key': this.apiKey,
      ...extraHeaders,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    return this.fetchImpl(url, init);
  }

  private _throwFromBody(status: number, text: string): never {
    if (text) {
      try {
        const obj = JSON.parse(text) as {
          error?: { code?: string; message?: string; request_id?: string; details?: unknown };
        };
        if (obj?.error?.code) {
          throw new TextralApiError(
            status,
            obj.error.code,
            obj.error.message ?? `HTTP ${status}`,
            obj.error.request_id,
            obj.error.details,
          );
        }
      } catch (e) {
        if (e instanceof TextralApiError) throw e;
        // fall through to UNKNOWN
      }
    }
    throw new TextralApiError(status, 'UNKNOWN', text || `HTTP ${status}`);
  }
}
