// Unified provider-key resolver.
//
// Replaces the four pre-existing variants:
//   auth/provider-keys.ts:resolveProviderKeyById
//   auth/provider-keys.ts:resolveProviderKey  (by label)
//   ingestion/dispatch.ts:resolveProviderKey  (id-only return)
//   routes/query.ts:resolveProviderKeyForQuery (id+raw, throws BAD_REQUEST)
//
// One discriminated `KeyLookup` input, one `ResolvedKey | null` output,
// one `include_raw` opt. The Phase-5 rerank path uses `optional_ref`
// and gets `null` instead of having to wrap the call in a try/catch.

import { TextralError } from '@textral/contracts';
import type { Env } from '../types.js';
import { getProviderKeyById, getProviderKeyByLabel } from '../db/provider-keys.js';
import { getSecretsStoreClient } from '../lib/secrets-store.js';

export type KeyLookup =
  | { kind: 'id'; provider: string; id: string }
  | { kind: 'ref'; provider: string; ref: string }
  | { kind: 'either'; provider: string; id?: string | undefined; ref?: string | undefined }
  | { kind: 'optional_ref'; provider: string; ref?: string | undefined };

export interface ResolveOpts {
  /** Fetch the raw key from Secrets Store. Default false — most call
   *  sites only need the ID. */
  include_raw?: boolean;
  /** Workers AI binding tier has no key — short-circuit with a
   *  sentinel id so call sites don't have to special-case. Default
   *  true. */
  short_circuit_workers_ai?: boolean;
}

export interface ResolvedKey {
  id: string;
  raw_key?: string;
  meta: {
    provider: string;
    label: string;
    secrets_store_secret_name: string;
  };
}

const WORKERS_AI_SENTINEL_ID = '__workers_ai_no_key__';

export async function resolveProviderKey(
  env: Env,
  tenant_id: string,
  lookup: KeyLookup,
  opts: ResolveOpts = {},
): Promise<ResolvedKey | null> {
  const shortCircuit = opts.short_circuit_workers_ai ?? true;
  if (shortCircuit && lookup.provider === 'workers_ai') {
    return {
      id: WORKERS_AI_SENTINEL_ID,
      meta: {
        provider: 'workers_ai',
        label: '__binding__',
        secrets_store_secret_name: '__binding__',
      },
    };
  }

  // Locate the provider_keys row.
  let row: Awaited<ReturnType<typeof getProviderKeyById>> = null;
  switch (lookup.kind) {
    case 'id':
      row = await getProviderKeyById(env.db, tenant_id, lookup.id);
      if (!row) {
        throw new TextralError(
          'PROVIDER_KEY_NOT_FOUND',
          404,
          `Provider key ${lookup.id} not found`,
        );
      }
      break;
    case 'ref':
      row = await getProviderKeyByLabel(env.db, tenant_id, lookup.provider, lookup.ref);
      if (!row) {
        throw new TextralError(
          'PROVIDER_KEY_NOT_FOUND',
          404,
          `Provider key (${lookup.provider}, ${lookup.ref}) not found`,
        );
      }
      break;
    case 'either':
      if (lookup.id) {
        row = await getProviderKeyById(env.db, tenant_id, lookup.id);
      } else if (lookup.ref) {
        row = await getProviderKeyByLabel(env.db, tenant_id, lookup.provider, lookup.ref);
      } else {
        throw new TextralError(
          'BAD_REQUEST',
          400,
          'provider_key_id or provider_key_ref required',
        );
      }
      if (!row) {
        const which = lookup.id
          ? `id=${lookup.id}`
          : `(${lookup.provider}, ${lookup.ref ?? '∅'})`;
        throw new TextralError(
          'PROVIDER_KEY_NOT_FOUND',
          404,
          `Provider key ${which} not found`,
        );
      }
      break;
    case 'optional_ref':
      if (!lookup.ref) return null;
      row = await getProviderKeyByLabel(env.db, tenant_id, lookup.provider, lookup.ref);
      if (!row) return null;
      break;
  }

  const result: ResolvedKey = {
    id: row.id,
    meta: {
      provider: row.provider,
      label: row.label,
      secrets_store_secret_name: row.secrets_store_secret_name,
    },
  };

  if (opts.include_raw) {
    const raw = await getSecretsStoreClient(env).get(row.secrets_store_secret_name);
    if (!raw) {
      throw new TextralError(
        'PROVIDER_KEY_NOT_FOUND',
        404,
        `Provider key metadata exists but the secret is missing: ${row.id}`,
      );
    }
    result.raw_key = raw;
  }

  return result;
}
