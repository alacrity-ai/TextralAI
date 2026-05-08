// GET /v1/me — minimal "who am I" endpoint. Returns the resolved tenant
// for the authenticated API key.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { MeResponse } from '../openapi/components.js';
import { Responses } from '../openapi/registry.js';
import { getTenantById } from '../db/tenants.js';

export const meRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const getMe = createRoute({
  method: 'get',
  path: '/',
  tags: ['Tenancy'],
  summary: 'Who am I',
  description: 'Returns the resolved tenant + api-key id for the caller.',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Authenticated tenant context.',
      content: { 'application/json': { schema: MeResponse } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

meRoute.openapi(getMe, async (c) => {
  const tenantId = c.get('tenant_id');
  const apiKeyId = c.get('api_key_id');
  if (!tenantId || !apiKeyId) {
    throw new TextralError('INTERNAL', 500, 'Auth context missing');
  }
  const tenant = await getTenantById(c.env.db, tenantId);
  if (!tenant) throw new TextralError('TENANT_NOT_FOUND', 404, 'Tenant not found');
  return c.json(
    {
      tenant: {
        id: tenant.id,
        display_name: tenant.display_name,
        plan: tenant.plan,
        created_at: tenant.created_at,
      },
      api_key_id: apiKeyId,
      runtime: c.env.runtime,
    },
    200,
  );
});
