// D1 helpers for provider_keys.

import type { Db } from '../runtime/shared/interfaces.js';

export interface ProviderKeyRow {
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

export async function getProviderKeyById(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<ProviderKeyRow | null> {
  return await db.one<ProviderKeyRow>(
    `SELECT * FROM provider_keys
        WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    [id, tenant_id],
  );
}

export async function getProviderKeyByLabel(
  db: Db,
  tenant_id: string,
  provider: string,
  label: string,
): Promise<ProviderKeyRow | null> {
  return await db.one<ProviderKeyRow>(
    `SELECT * FROM provider_keys
        WHERE tenant_id = ? AND provider = ? AND label = ? AND revoked_at IS NULL`,
    [tenant_id, provider, label],
  );
}

export async function insertProviderKey(
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
    `INSERT INTO provider_keys
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

export async function listProviderKeys(
  db: Db,
  tenant_id: string,
): Promise<ProviderKeyRow[]> {
  return await db.all<ProviderKeyRow>(
    `SELECT * FROM provider_keys
        WHERE tenant_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC`,
    [tenant_id],
  );
}

export async function revokeProviderKey(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<boolean> {
  const result = await db.exec(
    `UPDATE provider_keys SET revoked_at = ?
        WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    [Date.now(), id, tenant_id],
  );
  return result.rowsAffected === 1;
}

export async function updateProviderKeyValidation(
  db: Db,
  id: string,
  args: {
    last_validated_at: number;
    last_error_code: string | null;
  },
): Promise<void> {
  await db.exec(
    `UPDATE provider_keys
          SET last_validated_at = ?, last_error_code = ?
        WHERE id = ?`,
    [args.last_validated_at, args.last_error_code, id],
  );
}
