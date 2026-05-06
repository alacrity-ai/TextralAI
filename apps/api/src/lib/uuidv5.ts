// UUIDv5 (RFC 4122 §4.3) — namespaced, name-based UUID derived from a
// SHA-1 hash. Pure-fetch / Web Crypto only; no Node `crypto` import,
// so this works under the Workers runtime.
//
// Originally lived inline in the Qdrant adapter (chunk_id → point id
// translation: Qdrant requires UUID/uint, Textral chunk_ids are
// `chk_ver_<ulid>_<ord>`). Extracted here so any other backend whose
// IDs need RFC-4122 derivation can share the implementation.
//
// `NAMESPACE_DNS` matches Python's `uuid.NAMESPACE_DNS`, which v1's
// `apps/rag-core/app/clients/qdrant.py` used for the same purpose.

export const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** UUIDv5(namespace, name). Returns canonical 8-4-4-4-12 hex form. */
export async function uuidv5(namespaceUuid: string, name: string): Promise<string> {
  const ns = uuidToBytes(namespaceUuid);
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const buf = new Uint8Array(ns.length + nameBytes.length);
  buf.set(ns, 0);
  buf.set(nameBytes, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  // Set version (5) + variant (RFC 4122) bits.
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  return bytesToUuid(hash.subarray(0, 16));
}

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
