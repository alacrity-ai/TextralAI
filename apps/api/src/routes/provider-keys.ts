// /v1/provider-keys — register / list / revoke / test.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError, newId, type ProviderKey } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { getSecretsStoreClient, providerKeySecretName } from '../lib/secrets-store.js';
import { resolveProviderKeyById } from '../auth/provider-keys.js';
import { validateProviderKey } from '../providers/validate.js';
import {
  getProviderKeyById,
  getProviderKeyByLabel,
  insertProviderKey,
  listProviderKeys,
  revokeProviderKey,
  updateProviderKeyValidation,
} from '../db/provider-keys.js';
import {
  IdParam,
  ProviderKeyCreateSchema,
  ProviderKeyList,
  ProviderKeySchema,
  ProviderKeyTestResponse,
} from '../openapi/components.js';
import { Responses } from '../openapi/registry.js';

interface ProviderKeyRow {
  id: string;
  tenant_id: string;
  provider: string;
  label: string;
  secrets_store_secret_name: string;
  last_validated_at: number | null;
  last_error_code: string | null;
  created_at: number;
  revoked_at: number | null;
}

function rowToKey(r: ProviderKeyRow): ProviderKey {
  return {
    id: r.id,
    provider: r.provider as ProviderKey['provider'],
    label: r.label,
    prefix: `pkey_${r.id.slice(-6)}`,
    last_validated_at: r.last_validated_at,
    last_error_code: r.last_error_code,
    created_at: r.created_at,
  };
}

export const providerKeysRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const createKey = createRoute({
  method: 'post',
  path: '/',
  tags: ['Provider Keys'],
  summary: 'Register a provider key',
  description:
    'Stores a customer-supplied upstream API key (OpenAI, Anthropic, etc.) in Cloudflare Secrets Store. The key is identified internally by `(provider, label)`; subsequent reads never return the raw value.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: ProviderKeyCreateSchema } } },
  },
  responses: {
    201: {
      description: 'Provider key registered (metadata only).',
      content: { 'application/json': { schema: ProviderKeySchema } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    409: Responses.conflict,
  },
});

providerKeysRoute.openapi(createKey, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const data = c.req.valid('json');
  const existing = await getProviderKeyByLabel(c.env.db, tenantId, data.provider, data.label);
  if (existing) {
    throw new TextralError(
      'BAD_REQUEST',
      409,
      `A provider key already exists for (${data.provider}, ${data.label}). Delete it first.`,
    );
  }

  const id = newId('pkey');
  const secretName = providerKeySecretName(tenantId, data.provider, data.label);
  const store = getSecretsStoreClient(c.env);
  await store.put(secretName, data.key);
  await insertProviderKey(c.env.db, tenantId, {
    id,
    provider: data.provider,
    label: data.label,
    secrets_store_secret_name: secretName,
  });

  return c.json(
    rowToKey({
      id,
      tenant_id: tenantId,
      provider: data.provider,
      label: data.label,
      secrets_store_secret_name: secretName,
      last_validated_at: null,
      last_error_code: null,
      created_at: Date.now(),
      revoked_at: null,
    }),
    201,
  );
});

const listKeys = createRoute({
  method: 'get',
  path: '/',
  tags: ['Provider Keys'],
  summary: 'List provider keys',
  description: 'Returns metadata for all active provider keys owned by the tenant.',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Provider key metadata (raw keys never returned).',
      content: { 'application/json': { schema: ProviderKeyList } },
    },
    401: Responses.unauthorized,
  },
});

providerKeysRoute.openapi(listKeys, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const rows = await listProviderKeys(c.env.db, tenantId);
  return c.json({ data: rows.map(rowToKey) }, 200);
});

const revokeKey = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Provider Keys'],
  summary: 'Revoke a provider key',
  description: 'Best-effort delete from Secrets Store + soft-delete the metadata row.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: Responses.noContent,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

providerKeysRoute.openapi(revokeKey, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const row = await getProviderKeyById(c.env.db, tenantId, id);
  if (!row) throw new TextralError('PROVIDER_KEY_NOT_FOUND', 404, 'Provider key not found');
  try {
    const store = getSecretsStoreClient(c.env);
    await store.delete(row.secrets_store_secret_name);
  } catch {
    // intentionally swallowed; revocation still succeeds
  }
  await revokeProviderKey(c.env.db, tenantId, id);
  return c.body(null, 204);
});

const testKey = createRoute({
  method: 'post',
  path: '/{id}/test',
  tags: ['Provider Keys'],
  summary: 'Validate a provider key',
  description:
    'Issues a minimal upstream call (e.g. 1-token embedding for OpenAI) to confirm the registered key is alive and authorized. Updates `last_validated_at` and `last_error_code`. Resolves by exact ID — never by `(provider, label)`.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: 'Key is valid.',
      content: { 'application/json': { schema: ProviderKeyTestResponse } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
    422: {
      description: 'Validation failed (returns ok=false with error_code).',
      content: { 'application/json': { schema: ProviderKeyTestResponse } },
    },
  },
});

providerKeysRoute.openapi(testKey, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const resolved = await resolveProviderKeyById(c.env, tenantId, id);
  const result = await validateProviderKey(c.env, resolved.provider, resolved.raw_key, {
    tenant_id: tenantId,
    provider_key_id: resolved.provider_key_id,
  });

  await updateProviderKeyValidation(c.env.db, id, {
    last_validated_at: Date.now(),
    last_error_code: result.error_code ?? null,
  });

  return c.json(result, result.ok ? 200 : 422);
});
