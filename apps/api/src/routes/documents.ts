// /v1/namespaces/:slug/documents and /v1/documents/:id/* routes.
//
// Phase 3.2 (presigned upload + finalize) + Phase 3.3 (ingest dispatch).
//
// Two OpenAPIHono apps so that index.ts can mount each at exactly one
// path:
//   * `documentRegisterRoute`  — only `POST /{slug}/documents`,
//                                mounted under `/v1/namespaces`.
//   * `documentsRoute`         — every `/{id}/...` op, mounted under
//                                `/v1/documents`.
// A single shared app mounted at both prefixes (the original layout)
// caused Scalar's spec emission to duplicate every operation under
// both paths.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError, newId, type Chunk as ChunkType } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import {
  DocumentCreateSchema,
  DocumentSchema,
  FinalizeResponseSchema,
  IngestRequestSchema,
  IngestionJobCreateResponse,
  NamespaceSlugParam,
  UploadCreateSchema,
  UploadResponseSchema,
} from '../openapi/components.js';
import { Responses } from '../openapi/registry.js';
import { z } from '../openapi/z.js';
import {
  getDocumentById,
  getVersionByContentHash,
  insertDocument,
  insertDocumentVersion,
  listDocumentsForNamespace,
  rowToDocument,
  type DocumentRow,
} from '../db/documents.js';
import { listChunksForDocument } from '../db/chunks.js';
import { ChunkSchema } from '../openapi/components.js';
import {
  getUploadIntentById,
  insertUploadIntent,
  markUploadIntentConsumed,
} from '../db/upload-intents.js';
import { getNamespaceBySlug } from '../db/namespaces.js';
import {
  buildUploadEndpoint,
  canonicalSourceKey,
  extFromContentType,
  uploadKey,
} from '../lib/r2-presign.js';
import { dispatchIngestion } from '../ingestion/dispatch.js';

export const documentsRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
export const documentRegisterRoute = new OpenAPIHono<{
  Bindings: Env;
  Variables: Variables;
}>();

// ── POST /v1/namespaces/{slug}/documents ─────────────────────────────
const registerDoc = createRoute({
  method: 'post',
  path: '/{slug}/documents',
  tags: ['Documents'],
  summary: 'Register a document',
  description: 'Creates a document row inside a namespace. No bytes uploaded yet.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: NamespaceSlugParam,
    body: { content: { 'application/json': { schema: DocumentCreateSchema } } },
  },
  responses: {
    201: {
      description: 'Document registered.',
      content: { 'application/json': { schema: DocumentSchema } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

documentRegisterRoute.openapi(registerDoc, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { slug } = c.req.valid('param');
  const body = c.req.valid('json');
  const ns = await getNamespaceBySlug(c.env.db, tenantId, slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);

  const id = newId('doc');
  const now = Date.now();
  await insertDocument(c.env.db, tenantId, {
    id,
    namespace_id: ns.id,
    title: body.title ?? null,
    doc_type: body.doc_type ?? null,
    metadata: body.metadata ?? null,
  });

  return c.json(
    rowToDocument({
      id,
      tenant_id: tenantId,
      namespace_id: ns.id,
      title: body.title ?? null,
      doc_type: body.doc_type ?? null,
      metadata: body.metadata ? JSON.stringify(body.metadata) : null,
      current_version_id: null,
      created_at: now,
      deleted_at: null,
    }),
    201,
  );
});

// ── GET /v1/namespaces/{slug}/documents ──────────────────────────────
//
// Tenant-scoped, soft-deletes filtered out, descending by created_at.
// Cursor pagination mirrors `/v1/query-events` (cursor = previous
// page's last `created_at`). Used by the sandbox DocumentInspector
// to populate its document browser.

const DocumentListResponse = z
  .object({
    data: z.array(DocumentSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi('DocumentList');

const ListDocsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().openapi({
    param: { name: 'limit', in: 'query' },
    example: 50,
    description: 'Page size, 1..200 (default 50).',
  }),
  cursor: z.string().optional().openapi({
    param: { name: 'cursor', in: 'query' },
    description:
      'Opaque cursor returned as `next_cursor` from the previous page.',
  }),
});

const listDocs = createRoute({
  method: 'get',
  path: '/{slug}/documents',
  tags: ['Documents'],
  summary: 'List documents in a namespace',
  description:
    "Returns the namespace's documents, newest-first. Soft-deleted rows are excluded. Cursor-paginated by `created_at` descending.",
  security: [{ ApiKeyAuth: [] }],
  request: { params: NamespaceSlugParam, query: ListDocsQuery },
  responses: {
    200: {
      description: 'A page of documents.',
      content: { 'application/json': { schema: DocumentListResponse } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

documentRegisterRoute.openapi(listDocs, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { slug } = c.req.valid('param');
  const q = c.req.valid('query');
  const ns = await getNamespaceBySlug(c.env.db, tenantId, slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);

  const page = await listDocumentsForNamespace(c.env.db, tenantId, ns.id, {
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  return c.json(
    {
      data: page.items.map(rowToDocument),
      next_cursor: page.next_cursor,
    },
    200,
  );
});

// ── GET /v1/documents/{id} ────────────────────────────────────────────
const DocumentIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
});

const getDoc = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Documents'],
  summary: 'Get a document',
  security: [{ ApiKeyAuth: [] }],
  request: { params: DocumentIdParam },
  responses: {
    200: {
      description: 'Document.',
      content: { 'application/json': { schema: DocumentSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

documentsRoute.openapi(getDoc, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const row = await getDocumentById(c.env.db, tenantId, id);
  if (!row) throw new TextralError('DOCUMENT_NOT_FOUND', 404, 'Document not found');
  return c.json(rowToDocument(row), 200);
});

// ── GET /v1/documents/{id}/chunks ────────────────────────────────────
//
// Lists chunks for a document, ascending by `ord`. Defaults to the
// document's `current_version_id` so callers see the active set;
// pass `?version_id=ver_…` to inspect a prior version. Optional
// `?artifact_type=passage` filter to skip enrichment-derived chunks.
// Cursor pagination by `ord` (within a document, ord is unique).

const ChunkListResponse = z
  .object({
    data: z.array(ChunkSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi('ChunkList');

const ListChunksQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().openapi({
    param: { name: 'limit', in: 'query' },
    example: 100,
    description: 'Page size, 1..500 (default 100).',
  }),
  cursor: z.string().optional().openapi({
    param: { name: 'cursor', in: 'query' },
    description:
      'Opaque cursor returned as `next_cursor` from the previous page.',
  }),
  artifact_type: z.string().optional().openapi({
    param: { name: 'artifact_type', in: 'query' },
    example: 'passage',
    description: 'Filter to a single artifact type (e.g. `passage`).',
  }),
  version_id: z.string().optional().openapi({
    param: { name: 'version_id', in: 'query' },
    description:
      "Inspect a specific version's chunks. Defaults to the document's `current_version_id`.",
  }),
});

const listChunks = createRoute({
  method: 'get',
  path: '/{id}/chunks',
  tags: ['Documents'],
  summary: "List a document's chunks",
  description:
    "Returns chunks in `ord` order. Without `version_id`, scopes to the document's current version. Cursor-paginated by `ord` ascending.",
  security: [{ ApiKeyAuth: [] }],
  request: { params: DocumentIdParam, query: ListChunksQuery },
  responses: {
    200: {
      description: 'A page of chunks.',
      content: { 'application/json': { schema: ChunkListResponse } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

function chunkRowToDto(r: {
  id: string;
  tenant_id: string;
  namespace_id: string;
  document_id: string;
  version_id: string;
  version_index_id: string;
  artifact_type: string;
  section_path: string | null;
  ord: number;
  text: string;
  metadata: string | null;
  embedding_profile: string;
  chunking_profile: string;
  embedding_status: string;
  embedding_dimensions: number | null;
  parent_chunk_id: string | null;
  enrichment_pass_id: string | null;
  created_at: number;
}): ChunkType {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    namespace_id: r.namespace_id,
    document_id: r.document_id,
    version_id: r.version_id,
    version_index_id: r.version_index_id,
    artifact_type: r.artifact_type,
    section_path: r.section_path,
    ord: r.ord,
    text: r.text,
    metadata: r.metadata
      ? (JSON.parse(r.metadata) as Record<string, unknown>)
      : null,
    embedding_profile: r.embedding_profile,
    chunking_profile: r.chunking_profile,
    embedding_status: r.embedding_status as ChunkType['embedding_status'],
    embedding_dimensions: r.embedding_dimensions,
    parent_chunk_id: r.parent_chunk_id,
    enrichment_pass_id: r.enrichment_pass_id,
    created_at: r.created_at,
  };
}

documentsRoute.openapi(listChunks, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const q = c.req.valid('query');
  const doc = await getDocumentById(c.env.db, tenantId, id);
  if (!doc) throw new TextralError('DOCUMENT_NOT_FOUND', 404, 'Document not found');

  // Default to the doc's current version. If neither current_version_id
  // nor an explicit ?version_id is set, return an empty page — the doc
  // exists but has no ingested version yet, which is a "no rows" case.
  const versionId = q.version_id ?? doc.current_version_id;
  if (!versionId) {
    return c.json({ data: [], next_cursor: null }, 200);
  }

  const page = await listChunksForDocument(c.env.db, tenantId, id, {
    version_id: versionId,
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
    ...(q.artifact_type ? { artifact_type: q.artifact_type } : {}),
  });
  return c.json(
    {
      data: page.items.map(chunkRowToDto),
      next_cursor: page.next_cursor,
    },
    200,
  );
});

// ── POST /v1/documents/{id}/uploads ──────────────────────────────────
const createUpload = createRoute({
  method: 'post',
  path: '/{id}/uploads',
  tags: ['Documents'],
  summary: 'Mint a presigned upload URL',
  description:
    'Returns a single-shot presigned PUT URL for direct R2 upload. The declared content-type and size are recorded; finalize verifies the actual R2 object metadata against these values.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: DocumentIdParam,
    body: { content: { 'application/json': { schema: UploadCreateSchema } } },
  },
  responses: {
    200: {
      description: 'Presigned upload URL.',
      content: { 'application/json': { schema: UploadResponseSchema } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

documentsRoute.openapi(createUpload, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id: documentId } = c.req.valid('param');
  const body = c.req.valid('json');
  const doc = await getDocumentById(c.env.db, tenantId, documentId);
  if (!doc) throw new TextralError('DOCUMENT_NOT_FOUND', 404, 'Document not found');

  const uploadId = newId('upl');
  const ext = extFromContentType(body.content_type);
  const key = uploadKey(tenantId, doc.namespace_id, documentId, uploadId, ext);
  // R2 bindings don't expose presigned URLs; the upload URL always
  // routes back to the Worker proxy. See lib/r2-presign.ts.
  const upload = buildUploadEndpoint(c.req.url, documentId, uploadId);
  await insertUploadIntent(c.env.db, {
    id: uploadId,
    document_id: documentId,
    tenant_id: tenantId,
    upload_r2_key: key,
    declared_size: body.size_bytes,
    declared_content_type: body.content_type,
    expires_at: upload.expires_at,
  });

  return c.json(
    {
      upload_id: uploadId,
      url: upload.url,
      key,
      expires_at: upload.expires_at,
    },
    200,
  );
});

// ── PUT /v1/documents/{id}/uploads/{upload_id}/data ──────────────────
// Worker-proxied upload. The /uploads endpoint above returns this URL
// when native R2 presigning is unavailable. Auth via X-Textral-Api-Key
// (same as every other /v1/* route).
const uploadProxyParams = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
  upload_id: z.string().openapi({ param: { name: 'upload_id', in: 'path' } }),
});

const proxyUpload = createRoute({
  method: 'put',
  path: '/{id}/uploads/{upload_id}/data',
  tags: ['Documents'],
  summary: 'Upload bytes for a previously-presigned upload (Worker-proxied)',
  description:
    'Proxy upload path used when the deploy is not configured for native R2 presigning. Validates the upload_intent, writes the request body to R2, and returns 204.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: uploadProxyParams,
    body: {
      content: {
        'application/octet-stream': { schema: z.unknown() },
        'text/plain': { schema: z.string() },
      },
    },
  },
  responses: {
    204: { description: 'Upload stored.' },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

documentsRoute.openapi(proxyUpload, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id: documentId, upload_id: uploadId } = c.req.valid('param');
  const intent = await getUploadIntentById(c.env.db, tenantId, uploadId, documentId);
  if (!intent) {
    throw new TextralError('UPLOAD_INTENT_NOT_FOUND', 404, 'Upload intent not found');
  }
  if (intent.consumed_at !== null) {
    throw new TextralError('UPLOAD_VALIDATION_FAILED', 400, 'Upload already finalized');
  }
  if (intent.expires_at < Date.now()) {
    throw new TextralError('UPLOAD_VALIDATION_FAILED', 400, 'Upload intent expired');
  }
  const body = await c.req.raw.arrayBuffer();
  if (body.byteLength !== intent.declared_size) {
    throw new TextralError(
      'UPLOAD_VALIDATION_FAILED',
      400,
      `Body size ${body.byteLength} differs from declared size ${intent.declared_size}`,
    );
  }
  await c.env.blobs.put(intent.upload_r2_key, body, {
    contentType: intent.declared_content_type,
  });
  return new Response(null, { status: 204 });
});

// ── POST /v1/documents/{id}/uploads/{upload_id}/finalize ─────────────
const UploadFinalizeParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
  upload_id: z.string().openapi({ param: { name: 'upload_id', in: 'path' } }),
});

const finalizeUpload = createRoute({
  method: 'post',
  path: '/{id}/uploads/{upload_id}/finalize',
  tags: ['Documents'],
  summary: 'Finalize an upload',
  description:
    'Streams the uploaded R2 object, computes sha256, verifies declared size + content-type against the actual object, copies to the canonical version path, and inserts a document_versions row. Idempotent: re-finalizing the same upload (or finalizing identical bytes for the same document) returns the existing version_id.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: UploadFinalizeParam },
  responses: {
    201: {
      description: 'Version finalized.',
      content: { 'application/json': { schema: FinalizeResponseSchema } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

documentsRoute.openapi(finalizeUpload, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id: documentId, upload_id: uploadId } = c.req.valid('param');
  const env = c.env;

  const doc = await getDocumentById(env.db, tenantId, documentId);
  if (!doc) throw new TextralError('DOCUMENT_NOT_FOUND', 404, 'Document not found');
  const intent = await getUploadIntentById(env.db, tenantId, uploadId, documentId);
  if (!intent) {
    throw new TextralError('UPLOAD_INTENT_NOT_FOUND', 404, 'Upload intent not found');
  }

  // 1. HEAD; validate declared vs actual.
  const uploadObj = await env.blobs.head(intent.upload_r2_key);
  if (!uploadObj) {
    throw new TextralError(
      'UPLOAD_VALIDATION_FAILED',
      400,
      'Upload object not found in R2 (PUT not completed?)',
    );
  }
  if (uploadObj.size !== intent.declared_size) {
    throw new TextralError(
      'UPLOAD_VALIDATION_FAILED',
      400,
      `Declared size ${intent.declared_size} does not match actual ${uploadObj.size}`,
      { declared_size: intent.declared_size, actual_size: uploadObj.size },
    );
  }
  const actualContentType = uploadObj.contentType ?? 'application/octet-stream';
  if (actualContentType !== intent.declared_content_type) {
    throw new TextralError(
      'UPLOAD_VALIDATION_FAILED',
      400,
      `Declared content-type ${intent.declared_content_type} does not match actual ${actualContentType}`,
      { declared: intent.declared_content_type, actual: actualContentType },
    );
  }

  // 2. Stream + hash.
  const uploadBody = await env.blobs.get(intent.upload_r2_key);
  if (!uploadBody) {
    throw new TextralError('UPLOAD_VALIDATION_FAILED', 400, 'Upload object disappeared');
  }
  const contentHash = await c.env.hash.sha256OfStream(uploadBody.body);

  // 3. Recover-or-create.
  const existing = await getVersionByContentHash(env.db, documentId, contentHash);
  if (existing) {
    const canonical = await env.blobs.head(existing.source_r2_key);
    if (!canonical) {
      const re = await env.blobs.get(intent.upload_r2_key);
      if (re) {
        await env.blobs.put(existing.source_r2_key, re.body, {
          contentType: existing.content_type,
        });
      }
    }
    await tryDelete(env, intent.upload_r2_key);
    await markUploadIntentConsumed(env.db, uploadId);
    return c.json(
      {
        version_id: existing.id,
        content_hash: existing.content_hash,
        source_r2_key: existing.source_r2_key,
        size_bytes: existing.size_bytes,
        content_type: existing.content_type,
        deduplicated: true,
      },
      201,
    );
  }

  // 4. Copy upload → canonical.
  const versionId = newId('ver');
  const canonicalKey = canonicalSourceKey(
    tenantId,
    doc.namespace_id,
    documentId,
    versionId,
    extFromContentType(intent.declared_content_type),
  );
  const canonicalCheck = await env.blobs.head(canonicalKey);
  if (!canonicalCheck) {
    const re = await env.blobs.get(intent.upload_r2_key);
    if (!re) {
      throw new TextralError('UPLOAD_VALIDATION_FAILED', 400, 'Upload object disappeared');
    }
    await env.blobs.put(canonicalKey, re.body, {
      contentType: intent.declared_content_type,
    });
  }

  // 5. INSERT version row; UNIQUE constraint handles concurrent finalize.
  try {
    await insertDocumentVersion(env.db, tenantId, {
      id: versionId,
      document_id: documentId,
      content_hash: contentHash,
      source_r2_key: canonicalKey,
      content_type: intent.declared_content_type,
      size_bytes: intent.declared_size,
    });
  } catch (e) {
    const concurrent = await getVersionByContentHash(env.db, documentId, contentHash);
    if (concurrent) {
      await tryDelete(env, intent.upload_r2_key);
      await markUploadIntentConsumed(env.db, uploadId);
      return c.json(
        {
          version_id: concurrent.id,
          content_hash: concurrent.content_hash,
          source_r2_key: concurrent.source_r2_key,
          size_bytes: concurrent.size_bytes,
          content_type: concurrent.content_type,
          deduplicated: true,
        },
        201,
      );
    }
    throw e;
  }

  // 6. Cleanup.
  await tryDelete(env, intent.upload_r2_key);
  await markUploadIntentConsumed(env.db, uploadId);

  return c.json(
    {
      version_id: versionId,
      content_hash: contentHash,
      source_r2_key: canonicalKey,
      size_bytes: intent.declared_size,
      content_type: intent.declared_content_type,
      deduplicated: false,
    },
    201,
  );
});

async function tryDelete(env: Env, key: string): Promise<void> {
  try {
    await env.blobs.delete(key);
  } catch {
    // best-effort
  }
}

// ── POST /v1/documents/{id}/ingest ────────────────────────────────────
const ingestDoc = createRoute({
  method: 'post',
  path: '/{id}/ingest',
  tags: ['Documents'],
  summary: 'Kick off ingestion',
  description:
    'Validates the ingestion config, finds-or-creates a `version_index`, persists an `ingestion_jobs` row (with `provider_key_ref` resolved to a `pkey_*` ID), and dispatches a queue message. Returns immediately with a `job_id`; poll `GET /v1/ingestion-jobs/{id}` to track progress.\n\n' +
    '**Modes:**\n' +
    '- `mode="full"` — runs all six stages (fetch → normalize → chunk → embed → index → enrich). Default and most common.\n' +
    '- `mode="embed_only"` — re-runs embed + index (use after changing the embedding model). Assumes chunks exist.\n' +
    '- `mode="enrichment_only"` — runs only the enrichment stage. Assumes chunks + vectors already exist.\n\n' +
    '**Idempotency.** Repeated identical calls (same `version_id` + `mode`) return the same `job_id`. The runner skips stages whose latest attempt is `completed`, so replaying a partially-failed job picks up where it left off.\n\n' +
    '**Failure → DLQ.** After `attempt_count >= 3`, the job is dead-lettered. Recovery is `POST /v1/ingestion-jobs/{id}/retry` (admin scope).\n\n' +
    'See the **Ingestion** tag for the polling shape and per-stage forensics.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: DocumentIdParam,
    body: { content: { 'application/json': { schema: IngestRequestSchema } } },
  },
  responses: {
    202: {
      description: 'Job dispatched.',
      content: { 'application/json': { schema: IngestionJobCreateResponse } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    404: Responses.notFound,
    409: Responses.conflict,
  },
});

documentsRoute.openapi(ingestDoc, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id: documentId } = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await dispatchIngestion(c.env, tenantId, documentId, body);
  return c.json(result, 202);
});

export type { DocumentRow };
