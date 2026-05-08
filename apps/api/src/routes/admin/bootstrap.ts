// POST /v1/admin/bootstrap — one-shot tenant + namespace + api-key creation.
//
// Authenticated by ADMIN_BOOTSTRAP_TOKEN (a Worker secret), NOT by an
// X-Textral-Api-Key. Used by `make seed-dev` to bring up a fresh dev
// environment.
//
// Idempotent on (tenant_display_name + namespace_slug): re-running with
// the same body returns the existing tenant + namespace, but always
// issues a new api_key. Callers should revoke old keys explicitly.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError, newId } from '@textral/contracts';
import type { Env, Variables } from '../../types.js';
import { generateApiKey } from '../../auth/api-key.js';
import { readPepper } from '../../auth/pepper.js';
import { getNamespaceBySlug, insertNamespace } from '../../db/namespaces.js';
import { findTenantByDisplayName, insertTenant } from '../../db/tenants.js';
import { insertApiKey } from '../../db/api-keys.js';
import { BootstrapRequest, BootstrapResponse } from '../../openapi/components.js';
import { Responses } from '../../openapi/registry.js';
import { inferDimensionsFromProfile } from '../namespaces.js';
import { resolveVectorBinding } from '../../auth/infra-key-resolver.js';
import type { VectorBackend } from '../../retrieval/vector-store.js';

export const bootstrapRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const bootstrap = createRoute({
  method: 'post',
  path: '/',
  tags: ['Admin'],
  summary: 'Bootstrap a tenant',
  description:
    'One-shot tenant + namespace + api-key creation. Authenticated via X-Admin-Bootstrap-Token (a Worker secret), NOT a tenant API key. Idempotent on tenant_display_name + namespace_slug; always issues a new API key.',
  security: [{ AdminToken: [] }],
  request: {
    body: { content: { 'application/json': { schema: BootstrapRequest } } },
  },
  responses: {
    200: {
      description: 'Tenant + namespace + freshly-minted API key.',
      content: { 'application/json': { schema: BootstrapResponse } },
    },
    400: Responses.badRequest,
    401: Responses.forbiddenAdmin,
  },
});

bootstrapRoute.openapi(bootstrap, async (c) => {
  const provided = c.req.header('X-Admin-Bootstrap-Token');
  const expected = c.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!expected || !provided || !timingSafeEqual(expected, provided)) {
    throw new TextralError('INVALID_API_KEY', 401, 'Bootstrap token invalid');
  }

  const data = c.req.valid('json');

  const existingTenant = await findTenantByDisplayName(c.env.db, data.tenant_display_name);

  let tenantId = existingTenant?.id;
  if (!tenantId) {
    tenantId = newId('ten');
    await insertTenant(c.env.db, { id: tenantId, display_name: data.tenant_display_name });
  }

  // V3 Phase 2 — pick a backend that's actually available on this
  // runtime. CF defaults to vectorize (the legacy bootstrap path);
  // self-host defaults to qdrant (vectorize binding doesn't exist).
  // Operators can override via `namespace_vector_backend`.
  const isSelfHost = c.env.runtime === 'node';
  const backend: VectorBackend =
    data.namespace_vector_backend ?? (isSelfHost ? 'qdrant' : 'vectorize');
  if (backend === 'vectorize' && isSelfHost) {
    throw new TextralError(
      'BAD_REQUEST',
      400,
      'Vectorize backend unavailable in self-host mode; ' +
        'pick `qdrant` or `pinecone`.',
    );
  }
  if (
    (backend === 'qdrant' || backend === 'pinecone') &&
    !data.namespace_vector_index_name
  ) {
    // Self-host operators rarely care about the collection name;
    // pick a sensible default mirroring the namespace slug.
    if (!isSelfHost) {
      throw new TextralError(
        'BAD_REQUEST',
        400,
        `${backend} backend requires namespace_vector_index_name`,
      );
    }
  }
  const indexName =
    data.namespace_vector_index_name ??
    (backend === 'qdrant' ? `textral-${data.namespace_slug}` : null);

  let ns = await getNamespaceBySlug(c.env.db, tenantId, data.namespace_slug);
  if (!ns) {
    const dims = inferDimensionsFromProfile(data.namespace_default_embedding_profile);
    ns = await insertNamespace(c.env.db, {
      id: newId('ns'),
      tenant_id: tenantId,
      slug: data.namespace_slug,
      corpus_profile: data.namespace_corpus_profile,
      default_embedding_profile: data.namespace_default_embedding_profile,
      embedding_dimensions: dims,
      default_inference_model: null,
      default_prompt_template_id: null,
      vector_backend: backend,
      vector_index_name: backend === 'vectorize' ? null : indexName,
      // Fix Plan 08 — Pinecone default uses the slug as the native
      // Pinecone namespace. Other backends ignore the field.
      vector_namespace: backend === 'pinecone' ? data.namespace_slug : null,
    });

    // V3 Phase 1 — provision the upstream backing store for non-
    // Vectorize backends (Qdrant collection / Pinecone index dims).
    // Mirrors the same call site in `routes/namespaces.ts`.
    if (backend !== 'vectorize') {
      const binding = await resolveVectorBinding(c.env, tenantId, {
        backend: ns.vector_backend,
        index_name: ns.vector_index_name,
        embedding_dimensions: dims,
        namespace: ns.vector_namespace,
      });
      const store = c.env.vectors.forBinding(binding);
      if (store.ensureBackingExists) {
        await store.ensureBackingExists();
      }
    }
  }

  const pepper = await readPepper(c.env);
  const key = await generateApiKey(pepper);
  await insertApiKey(c.env.db, tenantId, {
    id: key.id,
    key_hash: key.hash,
    key_prefix: key.prefix,
    scopes: data.api_key_scopes,
  });

  return c.json(
    {
      tenant: { id: tenantId, display_name: data.tenant_display_name },
      namespace: ns,
      api_key: { id: key.id, raw: key.raw, prefix: key.prefix },
    },
    200,
  );
});

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
