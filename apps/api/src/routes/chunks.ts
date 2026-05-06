// /v1/chunks — single-chunk read.
//
//   GET /{id}    Returns the operator-useful columns of a chunk
//                (text + section path + artifact type + embedding
//                metadata). Powers the sandbox SourcePanel — a
//                citation click expands the panel against this route.
//
// The chunks table also feeds dense + sparse retrieval and rerank
// hydration via `hydrateChunksByIds`, but those are internal call
// paths. This route is the operator-facing read surface.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError, type Chunk as ChunkType } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { Responses } from '../openapi/registry.js';
import { z } from '../openapi/z.js';
import { ChunkSchema } from '../openapi/components.js';
import { getChunkById, type ChunkRow } from '../db/chunks.js';

export const chunksRoute = new OpenAPIHono<{
  Bindings: Env;
  Variables: Variables;
}>();

const Param = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'chk_ver_…_00002' }),
});

const get = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Chunks'],
  summary: 'Get a chunk by id',
  description:
    'Returns a single chunk including its text, section path, artifact type, and embedding metadata. Tenant-scoped — chunks belonging to other tenants surface as 404, not 403, by design.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: Param },
  responses: {
    200: {
      description: 'Chunk.',
      content: { 'application/json': { schema: ChunkSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

/** Centralized row → API DTO mapping. Drops diagnostic columns
 *  (vector_id, embedding_input_hash, embedding_provider_request_id)
 *  that are internal-plumbing only. */
function rowToChunk(row: ChunkRow): ChunkType {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    namespace_id: row.namespace_id,
    document_id: row.document_id,
    version_id: row.version_id,
    version_index_id: row.version_index_id,
    artifact_type: row.artifact_type,
    section_path: row.section_path,
    ord: row.ord,
    text: row.text,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
    embedding_profile: row.embedding_profile,
    chunking_profile: row.chunking_profile,
    embedding_status: row.embedding_status as ChunkType['embedding_status'],
    embedding_dimensions: row.embedding_dimensions,
    parent_chunk_id: row.parent_chunk_id,
    enrichment_pass_id: row.enrichment_pass_id,
    created_at: row.created_at,
  };
}

chunksRoute.openapi(get, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const row = await getChunkById(c.env.db, tenantId, id);
  if (!row) throw new TextralError('NOT_FOUND', 404, 'Chunk not found');
  return c.json(rowToChunk(row), 200);
});
