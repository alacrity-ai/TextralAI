// /v1/namespaces — CRUD. Every query is tenant-scoped via the resolved
// auth context.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError, newId } from '@textral/contracts';
import { listProfiles } from '@textral/corpus-profiles';
import type { Env, Variables } from '../types.js';
import {
  findPineconeNamespaceConflict,
  getNamespaceBySlug,
  insertNamespace,
  listNamespaces,
  softDeleteNamespace,
  updateNamespace,
} from '../db/namespaces.js';

/** Map a known embedding profile name to its dimensionality. Used at
 *  namespace-create time to size Qdrant collections + verify Pinecone
 *  index dims. The contract default `'openai-text-embedding-3-large'`
 *  and the wire-form `'openai-text-embedding-3-large-1536'` both
 *  resolve to 1536 — historical mismatch between contract default
 *  and selector key, accepted for back-compat; orthogonal to V3. */
export function inferDimensionsFromProfile(profile: string): number {
  if (
    profile === 'openai-text-embedding-3-large-1536' ||
    profile === 'openai-text-embedding-3-large'
  )
    return 1536;
  if (profile === 'workers-bge-large-en-v1-5-1024') return 1024;
  return 1536;
}

function validateCorpusProfileOrThrow(name: string): void {
  const known = new Set(listProfiles().map((p) => p.id));
  if (!known.has(name)) {
    throw new TextralError(
      'UNKNOWN_CORPUS_PROFILE',
      400,
      `Unknown corpus_profile: ${name}`,
      { available: Array.from(known).sort() },
    );
  }
}
import {
  NamespaceCreateSchema,
  NamespaceList,
  NamespaceSchema,
  NamespaceSlugParam,
  NamespaceUpdateSchema,
} from '../openapi/components.js';
import { Responses } from '../openapi/registry.js';

export const namespacesRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Namespaces'],
  summary: 'List namespaces',
  description: 'Lists all namespaces owned by the authenticated tenant.',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Namespaces.',
      content: { 'application/json': { schema: NamespaceList } },
    },
    401: Responses.unauthorized,
  },
});

namespacesRoute.openapi(listRoute, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const items = await listNamespaces(c.env.db, tenantId);
  return c.json({ data: items }, 200);
});

const createRouteDef = createRoute({
  method: 'post',
  path: '/',
  tags: ['Namespaces'],
  summary: 'Create a namespace',
  description:
    'Creates a new namespace under the calling tenant. Slug must be unique within the tenant.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: NamespaceCreateSchema } } },
  },
  responses: {
    201: {
      description: 'Created.',
      content: { 'application/json': { schema: NamespaceSchema } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    409: Responses.conflict,
  },
});

namespacesRoute.openapi(createRouteDef, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const data = c.req.valid('json');
  validateCorpusProfileOrThrow(data.corpus_profile);

  // V3 Phase 1 — backend-vs-config consistency rules. Reject early.
  if (
    (data.vector_backend === 'qdrant' || data.vector_backend === 'pinecone') &&
    !data.vector_index_name
  ) {
    throw new TextralError(
      'BAD_REQUEST',
      400,
      `${data.vector_backend} backend requires vector_index_name`,
    );
  }
  if (data.vector_backend === 'vectorize' && data.vector_index_name) {
    throw new TextralError(
      'BAD_REQUEST',
      400,
      'vectorize backend does not accept vector_index_name (binding is global)',
    );
  }
  // V3 Phase 2 — Vectorize is a CF-runtime-only binding. Self-host
  // deploys (Node runtime) must pick `qdrant` or `pinecone`.
  if (data.vector_backend === 'vectorize' && c.env.runtime === 'node') {
    throw new TextralError(
      'BAD_REQUEST',
      400,
      'Vectorize backend unavailable in self-host mode; ' +
        'pick `qdrant` or `pinecone`.',
    );
  }

  // Fix Plan 08 — vector_namespace handling.
  // - Pinecone: default to the Textral slug if omitted; reject conflict
  //   on (tenant_id, vector_index_name, vector_namespace) since two
  //   Textral namespaces sharing the same Pinecone index + Pinecone
  //   namespace would silently corrupt each other.
  // - Qdrant / Vectorize: ignored (forced to null). Don't reject if
  //   passed — the field is forward-compat.
  let vectorNamespace: string | null;
  if (data.vector_backend === 'pinecone') {
    vectorNamespace = data.vector_namespace ?? data.slug;
    const conflict = await findPineconeNamespaceConflict(
      c.env.db,
      tenantId,
      data.vector_index_name!,
      vectorNamespace,
    );
    if (conflict) {
      throw new TextralError(
        'NAMESPACE_ALREADY_EXISTS',
        409,
        `Pinecone namespace "${vectorNamespace}" inside index ${data.vector_index_name} ` +
          `is already bound to Textral namespace "${conflict.slug}". ` +
          `Pick a different vector_namespace or reuse the existing namespace.`,
      );
    }
  } else {
    vectorNamespace = null;
  }

  const existing = await getNamespaceBySlug(c.env.db, tenantId, data.slug);
  if (existing) {
    throw new TextralError(
      'NAMESPACE_ALREADY_EXISTS',
      409,
      `Namespace already exists: ${data.slug}`,
    );
  }

  // Validate the upstream backing store BEFORE the DB write so a
  // failed reachability check doesn't leave a half-created row
  // (the bug surfaced during the Pinecone PE prep run — pre-fix the
  // row was inserted then the env-var-missing check fired afterward,
  // and a retry hit NAMESPACE_ALREADY_EXISTS).
  const dimensions = inferDimensionsFromProfile(data.default_embedding_profile);
  const store = c.env.vectors.forBinding({
    backend: data.vector_backend,
    index_name: data.vector_index_name ?? null,
    embedding_dimensions: dimensions,
    namespace: vectorNamespace,
  });
  if (store.ensureBackingExists) {
    await store.ensureBackingExists();
  }

  const ns = await insertNamespace(c.env.db, {
    id: newId('ns'),
    tenant_id: tenantId,
    slug: data.slug,
    corpus_profile: data.corpus_profile,
    default_embedding_profile: data.default_embedding_profile,
    default_inference_model: data.default_inference_model ?? null,
    default_prompt_template_id: data.default_prompt_template_id ?? null,
    vector_backend: data.vector_backend,
    vector_index_name: data.vector_index_name ?? null,
    vector_namespace: vectorNamespace,
  });

  return c.json(ns, 201);
});

const getBySlug = createRoute({
  method: 'get',
  path: '/{slug}',
  tags: ['Namespaces'],
  summary: 'Get a namespace',
  description: 'Fetch a single namespace by slug (tenant-scoped).',
  security: [{ ApiKeyAuth: [] }],
  request: { params: NamespaceSlugParam },
  responses: {
    200: {
      description: 'Namespace.',
      content: { 'application/json': { schema: NamespaceSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

namespacesRoute.openapi(getBySlug, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { slug } = c.req.valid('param');
  const ns = await getNamespaceBySlug(c.env.db, tenantId, slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);
  return c.json(ns, 200);
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/{slug}',
  tags: ['Namespaces'],
  summary: 'Update a namespace',
  description: 'Partial update of namespace defaults. Slug is immutable.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: NamespaceSlugParam,
    body: { content: { 'application/json': { schema: NamespaceUpdateSchema } } },
  },
  responses: {
    200: {
      description: 'Updated namespace.',
      content: { 'application/json': { schema: NamespaceSchema } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

namespacesRoute.openapi(patchRoute, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { slug } = c.req.valid('param');
  const data = c.req.valid('json');
  if (data.corpus_profile !== undefined) {
    validateCorpusProfileOrThrow(data.corpus_profile);
  }
  const updated = await updateNamespace(c.env.db, tenantId, slug, {
    ...(data.corpus_profile !== undefined && { corpus_profile: data.corpus_profile }),
    ...(data.default_embedding_profile !== undefined && {
      default_embedding_profile: data.default_embedding_profile,
    }),
    ...(data.default_inference_model !== undefined && {
      default_inference_model: data.default_inference_model,
    }),
    ...(data.default_prompt_template_id !== undefined && {
      default_prompt_template_id: data.default_prompt_template_id,
    }),
  });
  if (!updated) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);
  return c.json(updated, 200);
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{slug}',
  tags: ['Namespaces'],
  summary: 'Soft-delete a namespace',
  description: 'Marks the namespace deleted; subsequent reads return 404.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: NamespaceSlugParam },
  responses: {
    204: Responses.noContent,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

namespacesRoute.openapi(deleteRoute, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { slug } = c.req.valid('param');
  const ok = await softDeleteNamespace(c.env.db, tenantId, slug);
  if (!ok) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);
  return c.body(null, 204);
});
