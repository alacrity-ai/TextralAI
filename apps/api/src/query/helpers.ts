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

/** Resolve the rerank provider key for the query path.
 *
 *  Lookup order:
 *    1. Request-pinned `provider_key_id` (strict — throws if not found).
 *    2. Request- or profile-pinned `provider_key_ref` (if declared).
 *    3. The tenant's key labeled `default` for that provider.
 *
 *  Returns `null` only when no key is configured for the provider —
 *  `maybeRerank` then falls back to RRF top-K with a
 *  `PROVIDER_KEY_NOT_FOUND` audit reason.
 *
 *  Why the `default`-label fallback lives here (not in the generic
 *  resolver): baked corpus profiles describe corpus types and ship
 *  to every tenant — they shouldn't reference tenant-side label
 *  conventions. The convention "label=default is the tenant's
 *  preferred key for this provider" is meaningful only on the rerank
 *  path, where the profile-declared key is optional. Other callers of
 *  `optional_ref` (e.g., the enrichment internal route) require an
 *  explicit ref and would be silently weakened by a global fallback. */
export async function resolveRerankProviderKey(
  env: Env,
  tenantId: string,
  provider: string,
  providerKeyRef?: string,
  providerKeyId?: string,
): Promise<QueryResolvedKey | null> {
  if (providerKeyId) {
    const r = await resolveProviderKey(
      env,
      tenantId,
      { kind: 'id', provider, id: providerKeyId },
      { include_raw: true },
    );
    return r?.raw_key ? { id: r.id, raw_key: r.raw_key } : null;
  }

  const pinned = await resolveProviderKey(
    env,
    tenantId,
    { kind: 'optional_ref', provider, ref: providerKeyRef },
    { include_raw: true },
  );
  if (pinned?.raw_key) return { id: pinned.id, raw_key: pinned.raw_key };

  if (providerKeyRef) return null;

  const fallback = await resolveProviderKey(
    env,
    tenantId,
    { kind: 'optional_ref', provider, ref: 'default' },
    { include_raw: true },
  );
  if (fallback?.raw_key) return { id: fallback.id, raw_key: fallback.raw_key };
  return null;
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
