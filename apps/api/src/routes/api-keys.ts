// /v1/api-keys — create / list / revoke. The raw key is returned in the
// response body ONLY on creation; subsequent reads return only metadata.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { generateApiKey } from '../auth/api-key.js';
import { readPepper } from '../auth/pepper.js';
import { insertApiKey, listApiKeys as listApiKeyRows, revokeApiKey as revokeApiKeyDb } from '../db/api-keys.js';
import {
  ApiKeyCreateRequest,
  ApiKeyCreateResponse,
  ApiKeyList,
  IdParam,
} from '../openapi/components.js';
import { Responses } from '../openapi/registry.js';

export const apiKeysRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const createApiKey = createRoute({
  method: 'post',
  path: '/',
  tags: ['API Keys'],
  summary: 'Create an API key',
  description:
    'Mints a new API key for the calling tenant. The raw key is returned exactly once on creation; it is never persisted in cleartext or shown again.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: ApiKeyCreateRequest } } },
  },
  responses: {
    201: {
      description: 'API key created. The `raw` value is shown ONCE.',
      content: { 'application/json': { schema: ApiKeyCreateResponse } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
  },
});

apiKeysRoute.openapi(createApiKey, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const body = c.req.valid('json');
  const pepper = await readPepper(c.env);
  const key = await generateApiKey(pepper);
  const scopes = body.scopes ?? ['*'];
  await insertApiKey(c.env.db, tenantId, {
    id: key.id,
    key_hash: key.hash,
    key_prefix: key.prefix,
    scopes,
  });
  return c.json(
    {
      id: key.id,
      raw: key.raw,
      prefix: key.prefix,
      scopes,
      created_at: Date.now(),
    },
    201,
  );
});

const listApiKeys = createRoute({
  method: 'get',
  path: '/',
  tags: ['API Keys'],
  summary: 'List API keys',
  description: 'Lists API keys for the calling tenant. Raw keys are never returned.',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'API keys metadata.',
      content: { 'application/json': { schema: ApiKeyList } },
    },
    401: Responses.unauthorized,
  },
});

apiKeysRoute.openapi(listApiKeys, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const rows = await listApiKeyRows(c.env.db, tenantId);
  return c.json(
    {
      data: rows.map((r) => ({
        id: r.id,
        prefix: r.key_prefix,
        scopes: JSON.parse(r.scopes) as string[],
        created_at: r.created_at,
        last_used_at: r.last_used_at,
        revoked_at: r.revoked_at,
      })),
    },
    200,
  );
});

const revokeApiKey = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['API Keys'],
  summary: 'Revoke an API key',
  description: 'Marks the key revoked. Subsequent auth attempts with it fail.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: Responses.noContent,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

apiKeysRoute.openapi(revokeApiKey, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const ok = await revokeApiKeyDb(c.env.db, tenantId, id);
  if (!ok) {
    throw new TextralError('NOT_FOUND', 404, 'API key not found');
  }
  return c.body(null, 204);
});
