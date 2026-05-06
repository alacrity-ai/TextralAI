// 60-second KV cache for resolved (api_key_hash → tenant) pairs.
//
// On a cache miss the middleware falls back to D1; on a hit it skips D1
// entirely. Revoking an API key takes effect after at most 60 seconds.
// (Acceptable trade-off; design doc calls this out.)

import type { KvStore } from '../runtime/shared/interfaces.js';

const TTL_SECS = 60;

export interface ResolvedKey {
  api_key_id: string;
  tenant_id: string;
  /** JSON-serialized scope list, mirroring api_keys.scopes. May be
   *  absent on rows pre-Phase 6 when this field wasn't cached;
   *  callers must treat absence as "wildcard scope" only when the
   *  DB lookup is current. */
  scopes?: string[];
}

export async function readResolvedKey(
  kv: KvStore,
  keyHash: string,
): Promise<ResolvedKey | null> {
  return kv.get<ResolvedKey>(`auth:${keyHash}`, { type: 'json' });
}

export async function writeResolvedKey(
  kv: KvStore,
  keyHash: string,
  resolved: ResolvedKey,
): Promise<void> {
  await kv.put(`auth:${keyHash}`, JSON.stringify(resolved), { ttlSeconds: TTL_SECS });
}
