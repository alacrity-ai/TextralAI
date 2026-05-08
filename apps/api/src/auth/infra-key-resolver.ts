// Resolve the active infra key for (tenant_id, provider) into its raw
// secret. Used by the vector-store factory's Pinecone branch and by
// the `/test` route. Returns null when no active key exists — callers
// surface INFRA_KEY_NOT_FOUND.

import { TextralError } from '@textral/contracts';
import type { Env } from '../types.js';
import type { VectorBinding } from '../retrieval/vector-store.js';
import { getActiveInfraKeyForProvider } from '../db/infra-keys.js';
import { getSecretsStoreClient } from '../lib/secrets-store.js';

export interface ResolvedInfraKey {
  id: string;
  provider: string;
  label: string;
  raw_key: string;
}

export async function resolveInfraKey(
  env: Env,
  tenantId: string,
  provider: string,
): Promise<ResolvedInfraKey | null> {
  const row = await getActiveInfraKeyForProvider(env.db, tenantId, provider);
  if (!row) return null;
  const raw = await getSecretsStoreClient(env).get(row.secrets_store_secret_name);
  if (!raw) {
    // Row exists but the secret is missing from the store — most
    // likely a partial-write during register or an out-of-band wipe.
    // Treat as "not found" so callers surface a single, consistent
    // error shape.
    return null;
  }
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    raw_key: raw,
  };
}

/** Convenience for vector-store call sites: takes a partially-built
 *  `VectorBinding` (no `pineconeApiKey`) plus the calling tenant and
 *  returns a fully-resolved binding ready for `vectors.forBinding(...)`.
 *  Throws INFRA_KEY_NOT_FOUND if Pinecone is selected but no active
 *  tenant key exists. Vectorize / Qdrant pass through unchanged. */
export async function resolveVectorBinding(
  env: Env,
  tenantId: string,
  partial: Omit<VectorBinding, 'pineconeApiKey'>,
): Promise<VectorBinding> {
  if (partial.backend !== 'pinecone') return partial;
  const ikey = await resolveInfraKey(env, tenantId, 'pinecone');
  if (!ikey) {
    throw new TextralError(
      'INFRA_KEY_NOT_FOUND',
      400,
      'Pinecone backend requires a tenant-registered infra key. Register one via POST /v1/infra-keys (provider=pinecone).',
    );
  }
  return { ...partial, pineconeApiKey: ikey.raw_key };
}
