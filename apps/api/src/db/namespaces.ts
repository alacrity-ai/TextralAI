// D1 query helpers for namespaces. Every helper takes `tenant_id` as a
// non-optional first argument so it's structurally impossible to forget
// the tenant filter at a call site.

import type { Namespace } from '@textral/contracts';
import type { Db } from '../runtime/shared/interfaces.js';

interface NamespaceRow {
  id: string;
  tenant_id: string;
  slug: string;
  corpus_profile: string;
  default_embedding_profile: string;
  default_inference_model: string | null;
  default_prompt_template_id: string | null;
  vector_backend: 'vectorize' | 'qdrant' | 'pinecone';
  vector_index_name: string | null;
  vector_namespace: string | null;
  created_at: number;
  deleted_at: number | null;
}

export function rowToNamespace(r: NamespaceRow): Namespace {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    slug: r.slug,
    corpus_profile: r.corpus_profile,
    default_embedding_profile: r.default_embedding_profile,
    default_inference_model: r.default_inference_model,
    default_prompt_template_id: r.default_prompt_template_id,
    vector_backend: r.vector_backend,
    vector_index_name: r.vector_index_name,
    vector_namespace: r.vector_namespace,
    created_at: r.created_at,
  };
}

export async function listNamespaces(db: Db, tenantId: string): Promise<Namespace[]> {
  const rows = await db.all<NamespaceRow>(
    `SELECT * FROM namespaces WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    [tenantId],
  );
  return rows.map(rowToNamespace);
}

export async function getNamespaceById(
  db: Db,
  tenantId: string,
  namespaceId: string,
): Promise<Namespace | null> {
  const row = await db.one<NamespaceRow>(
    `SELECT * FROM namespaces WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    [namespaceId, tenantId],
  );
  return row ? rowToNamespace(row) : null;
}

/** Variant for internal back-channel ownership checks: looks up by
 *  id with no tenant filter. The HMAC + per-job ownership re-check
 *  in the route handler is the trust boundary. */
export async function getNamespaceByIdAny(
  db: Db,
  namespaceId: string,
): Promise<Namespace | null> {
  const row = await db.one<NamespaceRow>(
    `SELECT * FROM namespaces WHERE id = ?`,
    [namespaceId],
  );
  return row ? rowToNamespace(row) : null;
}

export async function getNamespaceBySlug(
  db: Db,
  tenantId: string,
  slug: string,
): Promise<Namespace | null> {
  const row = await db.one<NamespaceRow>(
    `SELECT * FROM namespaces WHERE tenant_id = ? AND slug = ? AND deleted_at IS NULL`,
    [tenantId, slug],
  );
  return row ? rowToNamespace(row) : null;
}

export interface InsertNamespaceArgs {
  id: string;
  tenant_id: string;
  slug: string;
  corpus_profile: string;
  default_embedding_profile: string;
  default_inference_model: string | null;
  default_prompt_template_id: string | null;
  vector_backend: 'vectorize' | 'qdrant' | 'pinecone';
  vector_index_name: string | null;
  vector_namespace: string | null;
}

export async function insertNamespace(
  db: Db,
  args: InsertNamespaceArgs,
): Promise<Namespace> {
  const now = Date.now();
  await db.exec(
    `INSERT INTO namespaces
         (id, tenant_id, slug, corpus_profile, default_embedding_profile,
          default_inference_model, default_prompt_template_id,
          vector_backend, vector_index_name, vector_namespace, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.tenant_id,
      args.slug,
      args.corpus_profile,
      args.default_embedding_profile,
      args.default_inference_model,
      args.default_prompt_template_id,
      args.vector_backend,
      args.vector_index_name,
      args.vector_namespace,
      now,
    ],
  );
  return {
    id: args.id,
    tenant_id: args.tenant_id,
    slug: args.slug,
    corpus_profile: args.corpus_profile,
    default_embedding_profile: args.default_embedding_profile,
    default_inference_model: args.default_inference_model,
    default_prompt_template_id: args.default_prompt_template_id,
    vector_backend: args.vector_backend,
    vector_index_name: args.vector_index_name,
    vector_namespace: args.vector_namespace,
    created_at: now,
  };
}

/** Used by the create-namespace route to enforce uniqueness on
 *  (vector_backend, vector_index_name, vector_namespace) for pinecone
 *  rows: two Textral namespaces sharing the same Pinecone index +
 *  Pinecone namespace would write to the same vectors. Returns the
 *  conflicting namespace, or null if none. Tenant-scoped (we don't
 *  prevent cross-tenant overlap — operators picking the same
 *  Pinecone index across tenants is their concern, not ours). */
export async function findPineconeNamespaceConflict(
  db: Db,
  tenantId: string,
  vectorIndexName: string,
  vectorNamespace: string,
): Promise<Namespace | null> {
  const row = await db.one<NamespaceRow>(
    `SELECT * FROM namespaces
       WHERE tenant_id = ?
         AND vector_backend = 'pinecone'
         AND vector_index_name = ?
         AND vector_namespace = ?
         AND deleted_at IS NULL`,
    [tenantId, vectorIndexName, vectorNamespace],
  );
  return row ? rowToNamespace(row) : null;
}

export async function updateNamespace(
  db: Db,
  tenantId: string,
  slug: string,
  updates: Partial<
    Pick<
      Namespace,
      | 'corpus_profile'
      | 'default_embedding_profile'
      | 'default_inference_model'
      | 'default_prompt_template_id'
    >
  >,
): Promise<Namespace | null> {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (updates.corpus_profile !== undefined) {
    fields.push('corpus_profile = ?');
    values.push(updates.corpus_profile);
  }
  if (updates.default_embedding_profile !== undefined) {
    fields.push('default_embedding_profile = ?');
    values.push(updates.default_embedding_profile);
  }
  if (updates.default_inference_model !== undefined) {
    fields.push('default_inference_model = ?');
    values.push(updates.default_inference_model);
  }
  if (updates.default_prompt_template_id !== undefined) {
    fields.push('default_prompt_template_id = ?');
    values.push(updates.default_prompt_template_id);
  }
  if (fields.length === 0) return getNamespaceBySlug(db, tenantId, slug);
  await db.exec(
    `UPDATE namespaces SET ${fields.join(', ')}
       WHERE tenant_id = ? AND slug = ? AND deleted_at IS NULL`,
    [...values, tenantId, slug],
  );
  return getNamespaceBySlug(db, tenantId, slug);
}

export async function softDeleteNamespace(
  db: Db,
  tenantId: string,
  slug: string,
): Promise<boolean> {
  const res = await db.exec(
    `UPDATE namespaces SET deleted_at = ?
       WHERE tenant_id = ? AND slug = ? AND deleted_at IS NULL`,
    [Date.now(), tenantId, slug],
  );
  return res.rowsAffected > 0;
}
