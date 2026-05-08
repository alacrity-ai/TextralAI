// /v1/infra-keys — register / list / revoke / test for tenant-scoped
// vector-store credentials. Mirrors /v1/provider-keys in shape; the
// resolution semantics differ (at-most-one active per (tenant,
// provider) — no `label` ref needed at lookup time).
//
// Today: Pinecone only. Qdrant Cloud / managed-Postgres later — add
// to InfraProviderName + extend the test probe.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError, newId, type InfraKey } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { getSecretsStoreClient, infraKeySecretName } from '../lib/secrets-store.js';
import { resolveInfraKey } from '../auth/infra-key-resolver.js';
import {
  getActiveInfraKeyForProvider,
  getInfraKeyById,
  insertInfraKey,
  listInfraKeys,
  revokeInfraKey,
  updateInfraKeyValidation,
} from '../db/infra-keys.js';
import {
  IdParam,
  InfraKeyCreateSchema,
  InfraKeyList,
  InfraKeySchema,
  InfraKeyTestResponse,
} from '../openapi/components.js';
import { Responses } from '../openapi/registry.js';

interface InfraKeyRow {
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

function rowToKey(r: InfraKeyRow): InfraKey {
  return {
    id: r.id,
    provider: r.provider as InfraKey['provider'],
    label: r.label,
    prefix: `ikey_${r.id.slice(-6)}`,
    last_validated_at: r.last_validated_at,
    last_error_code: r.last_error_code,
    created_at: r.created_at,
  };
}

export const infraKeysRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const createKey = createRoute({
  method: 'post',
  path: '/',
  tags: ['Infra Keys'],
  summary: 'Register an infrastructure key',
  description:
    'Stores a tenant-scoped vector-store credential (Pinecone today; Qdrant Cloud and managed-Postgres in future). At most one active key per (tenant, provider) — re-register requires revoking the existing one first. Raw key is written to Cloudflare Secrets Store and never returned again.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: InfraKeyCreateSchema } } },
  },
  responses: {
    201: {
      description: 'Infra key registered (metadata only; raw key never returned).',
      content: { 'application/json': { schema: InfraKeySchema } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    409: Responses.conflict,
  },
});

infraKeysRoute.openapi(createKey, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const data = c.req.valid('json');
  const existing = await getActiveInfraKeyForProvider(c.env.db, tenantId, data.provider);
  if (existing) {
    throw new TextralError(
      'INFRA_KEY_ALREADY_REGISTERED',
      409,
      `An active infra key already exists for ${data.provider}. Revoke ${existing.id} first, then re-register.`,
    );
  }

  const id = newId('ikey');
  const secretName = infraKeySecretName(tenantId, data.provider, data.label);
  const store = getSecretsStoreClient(c.env);
  await store.put(secretName, data.key);
  await insertInfraKey(c.env.db, tenantId, {
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
  tags: ['Infra Keys'],
  summary: 'List infrastructure keys',
  description: 'Metadata for all active infra keys owned by the tenant.',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Infra key metadata (raw keys never returned).',
      content: { 'application/json': { schema: InfraKeyList } },
    },
    401: Responses.unauthorized,
  },
});

infraKeysRoute.openapi(listKeys, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const rows = await listInfraKeys(c.env.db, tenantId);
  return c.json({ data: rows.map(rowToKey) }, 200);
});

const revokeKey = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Infra Keys'],
  summary: 'Revoke an infrastructure key',
  description: 'Best-effort delete from Secrets Store + soft-delete the metadata row. Pinecone-backed namespaces created against this key will fail subsequent operations until a replacement is registered.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: Responses.noContent,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

infraKeysRoute.openapi(revokeKey, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const row = await getInfraKeyById(c.env.db, tenantId, id);
  if (!row) throw new TextralError('INFRA_KEY_NOT_FOUND', 404, 'Infra key not found');
  try {
    const store = getSecretsStoreClient(c.env);
    await store.delete(row.secrets_store_secret_name);
  } catch {
    // intentionally swallowed; revocation still succeeds
  }
  await revokeInfraKey(c.env.db, tenantId, id);
  return c.body(null, 204);
});

const testKey = createRoute({
  method: 'post',
  path: '/{id}/test',
  tags: ['Infra Keys'],
  summary: 'Validate an infrastructure key',
  description:
    'Issues a minimal upstream call to confirm the registered key is alive and authorized. Pinecone: GET /indexes against api.pinecone.io. Updates `last_validated_at` and `last_error_code`.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: 'Key is valid.',
      content: { 'application/json': { schema: InfraKeyTestResponse } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
    422: {
      description: 'Validation failed (returns ok=false with error_code).',
      content: { 'application/json': { schema: InfraKeyTestResponse } },
    },
  },
});

infraKeysRoute.openapi(testKey, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { id } = c.req.valid('param');
  const row = await getInfraKeyById(c.env.db, tenantId, id);
  if (!row) throw new TextralError('INFRA_KEY_NOT_FOUND', 404, 'Infra key not found');
  const resolved = await resolveInfraKey(c.env, tenantId, row.provider);
  if (!resolved) {
    // Row found but secret missing from the store; treat as a soft
    // 422 since the test is the right place to surface this.
    await updateInfraKeyValidation(c.env.db, id, {
      last_validated_at: Date.now(),
      last_error_code: 'secret_missing',
    });
    return c.json(
      { ok: false, error_code: 'secret_missing', error_message: 'Stored secret not found' },
      422,
    );
  }

  const result = await probeInfraKey(row.provider, resolved.raw_key);
  await updateInfraKeyValidation(c.env.db, id, {
    last_validated_at: Date.now(),
    last_error_code: result.error_code ?? null,
  });
  return c.json(result, result.ok ? 200 : 422);
});

/** Per-provider reachability probe. Pinecone's /indexes endpoint
 *  takes only the API key (no index URL), which makes it a clean
 *  authorization check. */
async function probeInfraKey(
  provider: string,
  apiKey: string,
): Promise<{ ok: boolean; error_code?: string; error_message?: string }> {
  if (provider === 'pinecone') {
    try {
      const res = await fetch('https://api.pinecone.io/indexes', {
        method: 'GET',
        headers: { 'Api-Key': apiKey, accept: 'application/json' },
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          error_code: 'invalid_api_key',
          error_message: `Pinecone rejected the key (HTTP ${res.status})`,
        };
      }
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error_code: 'upstream_error',
        error_message: `Pinecone HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`,
      };
    } catch (e) {
      return {
        ok: false,
        error_code: 'network',
        error_message: (e as Error).message,
      };
    }
  }
  // Future: qdrant cloud — GET /collections; managed-postgres — SELECT 1.
  return {
    ok: false,
    error_code: 'unsupported_provider',
    error_message: `Reachability probe not implemented for ${provider}`,
  };
}
