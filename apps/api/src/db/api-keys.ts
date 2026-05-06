// D1 helpers for api_keys.

import type { ResolvedKey } from '../auth/tenant-cache.js';
import type { Db } from '../runtime/shared/interfaces.js';

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  key_hash: string;
  key_prefix: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export async function lookupApiKeyByHash(
  db: Db,
  key_hash: string,
): Promise<ResolvedKey | null> {
  const row = await db.one<{ api_key_id: string; tenant_id: string; scopes: string }>(
    `SELECT id AS api_key_id, tenant_id, scopes FROM api_keys
        WHERE key_hash = ? AND revoked_at IS NULL`,
    [key_hash],
  );
  if (!row) return null;
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes) as unknown;
    if (Array.isArray(parsed)) scopes = parsed.map(String);
  } catch {
    scopes = [];
  }
  return { api_key_id: row.api_key_id, tenant_id: row.tenant_id, scopes };
}

export async function touchApiKeyLastUsed(db: Db, api_key_id: string): Promise<void> {
  await db.exec(
    `UPDATE api_keys SET last_used_at = ? WHERE id = ?`,
    [Date.now(), api_key_id],
  );
}

export async function insertApiKey(
  db: Db,
  tenant_id: string,
  args: {
    id: string;
    key_hash: string;
    key_prefix: string;
    scopes: string[];
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      tenant_id,
      args.key_hash,
      args.key_prefix,
      JSON.stringify(args.scopes),
      Date.now(),
    ],
  );
}

/** Lists ALL keys (including revoked) so callers can show audit
 *  history. Filter on the result set if you need only active keys. */
export async function listApiKeys(db: Db, tenant_id: string): Promise<ApiKeyRow[]> {
  return await db.all<ApiKeyRow>(
    `SELECT id, tenant_id, key_hash, key_prefix, scopes, created_at, last_used_at, revoked_at
         FROM api_keys WHERE tenant_id = ?
        ORDER BY created_at DESC`,
    [tenant_id],
  );
}

export async function revokeApiKey(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<boolean> {
  const result = await db.exec(
    `UPDATE api_keys SET revoked_at = ?
        WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    [Date.now(), id, tenant_id],
  );
  return result.rowsAffected === 1;
}
