// Chunk — a single retrievable unit of text inside a document version.
//
// Surfaces the operator-useful columns from the `chunks` table; omits
// internal-plumbing fields (vector_id, embedding_input_hash,
// embedding_provider_request_id) which are diagnostic-only and
// shouldn't be part of the public contract.

import { z } from 'zod';

export const ChunkArtifactType = z.string().describe(
  "Class of chunk. `passage` is the default body text; corpus profiles can introduce others (e.g., `summary`, `theme`, `character_arc`).",
);

export const ChunkEmbeddingStatus = z.enum(['pending', 'embedded', 'missing']);
export type ChunkEmbeddingStatus = z.infer<typeof ChunkEmbeddingStatus>;

export const Chunk = z.object({
  id: z.string(),
  tenant_id: z.string(),
  namespace_id: z.string(),
  document_id: z.string(),
  version_id: z.string(),
  version_index_id: z.string(),
  artifact_type: ChunkArtifactType,
  section_path: z.string().nullable(),
  ord: z.number().int(),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  embedding_profile: z.string(),
  chunking_profile: z.string(),
  embedding_status: ChunkEmbeddingStatus,
  embedding_dimensions: z.number().int().nullable(),
  parent_chunk_id: z.string().nullable(),
  enrichment_pass_id: z.string().nullable(),
  created_at: z.number().int(),
});
export type Chunk = z.infer<typeof Chunk>;
