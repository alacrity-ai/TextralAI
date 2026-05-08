// D1 helpers for infra_keys. Mirror provider_keys but with the KISS
// rule that at most one active key exists per (tenant, provider) —
// enforced by the unique partial index in migration 0011.

import type { Db } from '../runtime/shared/interfaces.js';

export interface InfraKeyRow {
  id: string;
  tenant_id: string;
  provider: string;
  label: string;
  secrets_store_secret_name: string;
  created_at: number;
  last_validated_at: number | null;
  last_error_code: string | null;
  revoked_at: number | null;
}

export async function getInfraKeyById(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<InfraKeyRow | null> {
  return await db.one<InfraKeyRow>(
    `SELECT * FROM infra_keys
        WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    [id, tenant_id],
  );
}

/** The hot-path lookup: vector-store factory calls this on every
 *  Pinecone-backed namespace operation to fetch the secret-store
 *  pointer, then resolves the raw key. Returns null if no active
 *  key — caller surfaces INFRA_KEY_NOT_FOUND. */
export async function getActiveInfraKeyForProvider(
  db: Db,
  tenant_id: string,
  provider: string,
): Promise<InfraKeyRow | null> {
  return await db.one<InfraKeyRow>(
    `SELECT * FROM infra_keys
        WHERE tenant_id = ? AND provider = ? AND revoked_at IS NULL`,
    [tenant_id, provider],
  );
}

export async function insertInfraKey(
  db: Db,
  tenant_id: string,
  args: {
    id: string;
    provider: string;
    label: string;
    secrets_store_secret_name: string;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO infra_keys
         (id, tenant_id, provider, label, secrets_store_secret_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      tenant_id,
      args.provider,
      args.label,
      args.secrets_store_secret_name,
      Date.now(),
    ],
  );
}

export async function listInfraKeys(
  db: Db,
  tenant_id: string,
): Promise<InfraKeyRow[]> {
  return await db.all<InfraKeyRow>(
    `SELECT * FROM infra_keys
        WHERE tenant_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC`,
    [tenant_id],
  );
}

export async function revokeInfraKey(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<void> {
  await db.exec(
    `UPDATE infra_keys
        SET revoked_at = ?
      WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    [Date.now(), id, tenant_id],
  );
}

export async function updateInfraKeyValidation(
  db: Db,
  id: string,
  args: { last_validated_at: number; last_error_code: string | null },
): Promise<void> {
  await db.exec(
    `UPDATE infra_keys
        SET last_validated_at = ?,
            last_error_code = ?
      WHERE id = ?`,
    [args.last_validated_at, args.last_error_code, id],
  );
}
