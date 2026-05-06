// Small helpers used by the query route — extracted from
// routes/query.ts in the post-Phase-5 cleanup.

import type { Env } from '../types.js';
import { resolveCurrentVersionIds } from '../db/documents.js';
import { resolveProviderKey } from '../auth/provider-key-resolver.js';

export interface QueryResolvedKey {
  id: string;
  raw_key: string;
}

export async function resolveVersionIds(
  env: Env,
  tenantId: string,
  namespaceId: string,
  documentIds?: string[],
): Promise<string[]> {
  return await resolveCurrentVersionIds(env.db, tenantId, namespaceId, documentIds);
}

/** Query-side wrapper around the unified resolver. Workers AI tier
 *  short-circuits to null (no key needed); other providers get
 *  resolved with `kind:'either'` semantics. */
export async function resolveProviderKeyForQuery(
  env: Env,
  tenantId: string,
  provider: string,
  providerKeyId?: string,
  providerKeyRef?: string,
): Promise<QueryResolvedKey | null> {
  if (provider === 'workers_ai') return null;
  const r = await resolveProviderKey(
    env,
    tenantId,
    { kind: 'either', provider, id: providerKeyId, ref: providerKeyRef },
    { include_raw: true },
  );
  if (!r || !r.raw_key) return null;
  return { id: r.id, raw_key: r.raw_key };
}

/** Provider-default embedding dimensions when the request body
 *  omits the explicit value. Vectorize V2 caps a single vector at
 *  1536 dim, so OpenAI text-embedding-3-* both default to 1536. */
export function defaultDim(model: string): number {
  switch (model) {
    case 'text-embedding-3-large':
    case 'text-embedding-3-small':
      return 1536;
    case '@cf/baai/bge-large-en-v1.5':
      return 1024;
    case '@cf/baai/bge-base-en-v1.5':
      return 768;
    default:
      return 1536;
  }
}
