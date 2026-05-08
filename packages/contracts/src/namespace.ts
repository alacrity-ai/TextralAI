// Namespace contracts.
//
// A namespace is a logical scope inside a tenant — typically one per
// upstream product surface ('leases', 'support_kb', 'novels'). Each
// namespace pins a corpus profile and default embedding profile.

import { z } from 'zod';

export const NamespaceSlug = z
  .string()
  .min(2)
  .max(31)
  .regex(/^[a-z][a-z0-9-]+$/, 'slug must start with a-z and contain only a-z, 0-9, and -');

/** Vector store backend, locked at namespace-create time.
 *  See `apps/api/src/retrieval/vector-store.ts`. */
export const VectorBackend = z.enum(['vectorize', 'qdrant', 'pinecone']).describe(
  'Vector store backend, locked at create time. ' +
    '`vectorize` (default): Cloudflare Vectorize V2; binding is global and Textral isolates by metadata filter. ' +
    '`qdrant`: self-host or Qdrant Cloud; Textral creates a per-namespace collection idempotently. ' +
    '`pinecone`: managed Pinecone serverless; **the operator must pre-create the index** ' +
    '(dimensions matching `default_embedding_profile`) and pass its host URL as `vector_index_name`. ' +
    'See the Namespaces tag description for the full operator-config matrix.',
);
export type VectorBackend = z.infer<typeof VectorBackend>;

/** Vector-store-side partition handle. Provider-neutral name even
 *  though only the Pinecone adapter reads it today. Pinecone: native
 *  namespace inside the index — the canonical multi-tenancy primitive
 *  there. Qdrant / Vectorize: ignored (collection-per-namespace and
 *  metadata-filter respectively cover their isolation needs). */
export const VectorNamespace = z
  .string()
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    'vector_namespace must be lowercase alphanumerics, _, or -',
  );

/** A (chunking_profile, embedding_profile) pair the namespace was actually
 *  ingested with. Computed on read by joining `version_indexes` rows
 *  against the namespace's documents. Authoritative — `default_embedding_profile`
 *  is a soft default that does not always encode dimensions. */
export const IndexedProfile = z.object({
  chunking_profile: z.string(),
  embedding_profile: z.string(),
  embedding_provider: z.string(),
  embedding_model: z.string(),
  embedding_dimensions: z.number().int(),
});
export type IndexedProfile = z.infer<typeof IndexedProfile>;

export const Namespace = z.object({
  id: z.string(),
  tenant_id: z.string(),
  slug: NamespaceSlug,
  corpus_profile: z.string(),
  default_embedding_profile: z.string(),
  /** Hard-locked vector dimension this namespace's backing store
   *  accepts. Every ingest into this namespace MUST embed at this
   *  dim; queries do too. Set at create time, immutable. Backed by
   *  the Vectorize binding's index size / Qdrant collection's
   *  `vectors.size` / Pinecone index's dim. */
  embedding_dimensions: z.number().int().positive(),
  default_inference_model: z.string().nullable(),
  default_prompt_template_id: z.string().nullable(),
  vector_backend: VectorBackend,
  vector_index_name: z
    .string()
    .nullable()
    .describe(
      'Backend-meaningful handle. ' +
        'Vectorize: null (binding is global). ' +
        'Qdrant: collection name (Textral-managed). ' +
        'Pinecone: full data-plane host URL of the operator-provisioned index.',
    ),
  vector_namespace: z
    .string()
    .nullable()
    .describe(
      'Vector-store-side partition handle. ' +
        'Pinecone: the native Pinecone namespace inside the index — many Textral namespaces ' +
        'can share one Pinecone index by using different values here. ' +
        'Qdrant / Vectorize: null (not used).',
    ),
  /** The (chunking, embedding) profiles this namespace was actually
   *  ingested with — deduplicated across version_indexes. Empty for
   *  namespaces with no ingested documents yet. Clients should prefer
   *  these over `default_embedding_profile` when constructing queries. */
  indexed_profiles: z.array(IndexedProfile).optional(),
  created_at: z.number().int(),
});
export type Namespace = z.infer<typeof Namespace>;

export const NamespaceCreate = z.object({
  slug: NamespaceSlug,
  corpus_profile: z.string().default('generic'),
  default_embedding_profile: z.string().default('openai-text-embedding-3-large'),
  /** Vector dim this namespace will accept. If omitted, derived from
   *  `default_embedding_profile`. Once persisted, cannot change. For
   *  Vectorize backends the value MUST match the Worker's bound
   *  Vectorize index dim (currently 1536). */
  embedding_dimensions: z.number().int().min(1).max(4096).optional(),
  default_inference_model: z.string().nullable().optional(),
  default_prompt_template_id: z.string().nullable().optional(),
  vector_backend: VectorBackend.default('vectorize'),
  vector_index_name: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      'Backend-meaningful handle. ' +
        'Vectorize: must be omitted (binding is global). ' +
        'Qdrant: collection name — Textral auto-creates the collection idempotently at namespace-create time. ' +
        'Pinecone: full data-plane host URL of a **pre-existing** index ' +
        '(e.g. `https://my-idx-xxxxx.svc.us-east-1-aws.pinecone.io`); ' +
        'Textral verifies reachability but does not create Pinecone indexes. ' +
        'Provision the index via the Pinecone console / API first; dimensions must match `default_embedding_profile`. ' +
        'Locked at create time — switching backends requires a new namespace + re-ingest.',
    ),
  vector_namespace: VectorNamespace.optional().describe(
    'Pinecone: the native Pinecone namespace inside the index. ' +
      'Multiple Textral namespaces can share one Pinecone index by using different values here. ' +
      'Defaults to the Textral slug if omitted. ' +
      'Qdrant / Vectorize: ignored. ' +
      'Locked at create time.',
  ),
});
export type NamespaceCreate = z.infer<typeof NamespaceCreate>;

// Backend choice is locked at create time. Strip vector_backend +
// vector_index_name + vector_namespace + embedding_dimensions from
// the update shape so PATCH /v1/namespaces can never mutate them —
// preserves the "switch backends → new namespace + re-ingest"
// contract and the dim-immutability invariant.
export const NamespaceUpdate = NamespaceCreate.partial().omit({
  slug: true,
  vector_backend: true,
  vector_index_name: true,
  vector_namespace: true,
  embedding_dimensions: true,
});
export type NamespaceUpdate = z.infer<typeof NamespaceUpdate>;
