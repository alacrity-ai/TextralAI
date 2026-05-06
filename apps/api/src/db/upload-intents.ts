// D1 helpers for upload_intents.

import type { Db } from '../runtime/shared/interfaces.js';

export interface UploadIntentRow {
  id: string;
  document_id: string;
  tenant_id: string;
  upload_r2_key: string;
  declared_size: number;
  declared_content_type: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

export async function insertUploadIntent(
  db: Db,
  args: {
    id: string;
    document_id: string;
    tenant_id: string;
    upload_r2_key: string;
    declared_size: number;
    declared_content_type: string;
    expires_at: number;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO upload_intents
         (id, document_id, tenant_id, upload_r2_key, declared_size,
          declared_content_type, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.document_id,
      args.tenant_id,
      args.upload_r2_key,
      args.declared_size,
      args.declared_content_type,
      args.expires_at,
      Date.now(),
    ],
  );
}

export async function getUploadIntentById(
  db: Db,
  tenant_id: string,
  id: string,
  document_id?: string,
): Promise<UploadIntentRow | null> {
  if (document_id) {
    return await db.one<UploadIntentRow>(
      `SELECT * FROM upload_intents
          WHERE id = ? AND tenant_id = ? AND document_id = ?`,
      [id, tenant_id, document_id],
    );
  }
  return await db.one<UploadIntentRow>(
    `SELECT * FROM upload_intents WHERE id = ? AND tenant_id = ?`,
    [id, tenant_id],
  );
}

export async function markUploadIntentConsumed(db: Db, id: string): Promise<void> {
  await db.exec(
    `UPDATE upload_intents SET consumed_at = ? WHERE id = ?`,
    [Date.now(), id],
  );
}
