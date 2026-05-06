// Prefixed ULIDs for every entity in the system.
// 26-char Crockford-base32 ULID, lexicographically sortable by creation
// time, prefixed by entity for grep-ability in logs.

import { ulid } from 'ulidx';

export type Prefix =
  | 'ten' // tenant
  | 'ns' // namespace
  | 'doc' // document
  | 'ver' // document version
  | 'vidx' // version_index (chunking + embedding combo)
  | 'upl' // upload intent
  | 'job' // ingestion job
  | 'chunk' // indexed chunk (legacy; new chunks use chk_<ver>_<ord>)
  | 'ak' // textral api key
  | 'pkey' // registered provider key
  | 'qev' // query event
  | 'req' // request id (per Worker invocation)
  | 'evset' // eval set (Phase 7)
  | 'evq' // eval question (Phase 7)
  | 'evrun' // eval run (Phase 7)
  | 'evres' // eval result (Phase 7)
  | 'mcp'; // mcp tool call audit row

/** Generate a prefixed ULID, e.g. `doc_01HZ8YQ8P...`. */
export function newId(prefix: Prefix): string {
  return `${prefix}_${ulid()}`;
}

/** Parse a prefixed ID; throws if shape is wrong. */
export function parseId(id: string, expectedPrefix: Prefix): { prefix: Prefix; ulid: string } {
  const idx = id.indexOf('_');
  if (idx === -1) throw new Error(`Malformed id: ${id}`);
  const prefix = id.slice(0, idx) as Prefix;
  if (prefix !== expectedPrefix) {
    throw new Error(`Expected ${expectedPrefix} id, got ${prefix}`);
  }
  return { prefix, ulid: id.slice(idx + 1) };
}
