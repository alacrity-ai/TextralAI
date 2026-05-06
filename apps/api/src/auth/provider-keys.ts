// Backwards-compat shims around the unified resolveProviderKey
// (provider-key-resolver.ts). Prefer the new resolver for new code;
// these shims preserve the historical signatures consumers rely on
// while routing all D1 + Secrets Store reads through one path.

import type { Env } from '../types.js';
import { resolveProviderKey as resolveProviderKeyUnified } from './provider-key-resolver.js';

export interface ResolvedProviderKey {
  provider_key_id: string;
  raw_key: string;
}

export interface ResolvedProviderKeyById extends ResolvedProviderKey {
  provider: string;
}

/** Exact-row resolver — the `/v1/provider-keys/:id/test` route uses
 *  this to validate the exact key the caller asked about, including
 *  the `revoked_at IS NULL` filter built into the underlying lookup. */
export async function resolveProviderKeyById(
  env: Env,
  tenantId: string,
  id: string,
): Promise<ResolvedProviderKeyById> {
  const r = await resolveProviderKeyUnified(
    env,
    tenantId,
    { kind: 'id', provider: '', id },
    { include_raw: true, short_circuit_workers_ai: false },
  );
  // resolveProviderKey throws on `kind:'id'` not-found; non-null is
  // guaranteed for this branch. Belt-and-suspenders for TS.
  if (!r || !r.raw_key) {
    throw new Error(`Provider key ${id} not found`);
  }
  return {
    provider_key_id: r.id,
    provider: r.meta.provider,
    raw_key: r.raw_key,
  };
}

export async function resolveProviderKeyByLabel(
  env: Env,
  tenantId: string,
  provider: string,
  label: string,
): Promise<ResolvedProviderKey> {
  const r = await resolveProviderKeyUnified(
    env,
    tenantId,
    { kind: 'ref', provider, ref: label },
    { include_raw: true },
  );
  if (!r || !r.raw_key) {
    throw new Error(`Provider key (${provider}, ${label}) not found`);
  }
  return { provider_key_id: r.id, raw_key: r.raw_key };
}

/** Legacy export name. New callers should use the new
 *  `provider-key-resolver` directly. The (provider, label) shape is
 *  what most existing tests assert against. */
export const resolveProviderKey = resolveProviderKeyByLabel;
