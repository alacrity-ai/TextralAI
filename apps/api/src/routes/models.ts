// GET /v1/models — curated model registry. Backs the `list_models` MCP
// tool and the sandbox model dropdowns. Read-only; tenant-scoped only
// because every /v1/* route runs under requireApiKey. The data is
// static — no tenant-scoped state is touched.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { KnownModel as KnownModelRaw, ModelKind, filterModels } from '@textral/contracts';
import { ProviderName as ProviderNameRaw } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { z } from '../openapi/z.js';
import { Responses } from '../openapi/registry.js';

export const modelsRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const KnownModelSchema = KnownModelRaw.openapi('KnownModel');
const KnownModelListResponse = z
  .object({ data: z.array(KnownModelSchema) })
  .openapi('KnownModelList');

const ListModelsQueryParams = z.object({
  provider: ProviderNameRaw.optional().openapi({ param: { name: 'provider', in: 'query' } }),
  kind: ModelKind.optional().openapi({ param: { name: 'kind', in: 'query' } }),
  include_deprecated: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .openapi({ param: { name: 'include_deprecated', in: 'query' } }),
});

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Meta'],
  summary: 'List known models',
  description:
    'Returns the curated registry of models Textral has validated against its provider adapters. ' +
    'Filter by provider/kind. Deprecated entries are hidden by default; pass `include_deprecated=true` to include them. ' +
    'Free-text model IDs are still accepted at the query layer — this list is for ergonomics, not enforcement.',
  security: [{ ApiKeyAuth: [] }],
  request: { query: ListModelsQueryParams },
  responses: {
    200: {
      description: 'Model registry, filtered.',
      content: { 'application/json': { schema: KnownModelListResponse } },
    },
    401: Responses.unauthorized,
  },
});

modelsRoute.openapi(listRoute, (c) => {
  const q = c.req.valid('query');
  const data = filterModels({
    ...(q.provider ? { provider: q.provider } : {}),
    ...(q.kind ? { kind: q.kind } : {}),
    include_deprecated: q.include_deprecated === 'true',
  });
  return c.json({ data }, 200);
});
