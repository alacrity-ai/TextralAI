// GET /v1/error-catalog — structured error catalog. Backs the
// `textral://error-catalog` MCP resource so an agent can interpret
// error codes without parsing the Scalar landing page.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Env, Variables } from '../types.js';
import { z } from '../openapi/z.js';
import { Responses } from '../openapi/registry.js';
import { ERROR_CATALOG } from '../openapi/error-catalog.js';

export const errorCatalogRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const ErrorMetaSchema = z
  .object({
    http: z.number().int(),
    when: z.string(),
    recovery: z.string(),
  })
  .openapi('ErrorMeta');

const ErrorCatalogResponse = z
  .object({ data: z.record(z.string(), ErrorMetaSchema) })
  .openapi('ErrorCatalogResponse');

const getRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Meta'],
  summary: 'Fetch the structured error catalog',
  description:
    'Returns every error code Textral can emit, paired with the conditions that fire it and the recommended recovery. Sister surface to the Scalar landing page table.',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Error catalog.',
      content: { 'application/json': { schema: ErrorCatalogResponse } },
    },
    401: Responses.unauthorized,
  },
});

errorCatalogRoute.openapi(getRoute, (c) => c.json({ data: ERROR_CATALOG }, 200));
