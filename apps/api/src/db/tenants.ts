// D1 helpers for tenants.

import type { Db } from '../runtime/shared/interfaces.js';

export interface TenantRow {
  id: string;
  display_name: string;
  plan: string;
  audit_mode: 'full' | 'redacted' | 'metadata_only';
  created_at: number;
  deleted_at: number | null;
}

export async function getTenantById(
  db: Db,
  tenant_id: string,
): Promise<TenantRow | null> {
  return await db.one<TenantRow>(
    `SELECT id, display_name, plan, audit_mode, created_at, deleted_at
         FROM tenants WHERE id = ? AND deleted_at IS NULL`,
    [tenant_id],
  );
}

export async function findTenantByDisplayName(
  db: Db,
  display_name: string,
): Promise<TenantRow | null> {
  return await db.one<TenantRow>(
    `SELECT id, display_name, plan, audit_mode, created_at, deleted_at
         FROM tenants WHERE display_name = ? AND deleted_at IS NULL LIMIT 1`,
    [display_name],
  );
}

export async function insertTenant(
  db: Db,
  args: { id: string; display_name: string },
): Promise<void> {
  await db.exec(
    `INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)`,
    [args.id, args.display_name, Date.now()],
  );
}

export async function getTenantAuditMode(
  db: Db,
  tenant_id: string,
): Promise<'full' | 'redacted' | 'metadata_only'> {
  const row = await db.one<{ audit_mode: 'full' | 'redacted' | 'metadata_only' }>(
    `SELECT audit_mode FROM tenants WHERE id = ?`,
    [tenant_id],
  );
  return row?.audit_mode ?? 'full';
}
