-- 0009 — vector_namespace column.
--
-- Pinecone-specific. Maps a Textral namespace onto a *Pinecone
-- native namespace* inside the operator-provisioned index, so many
-- Textral namespaces can share one Pinecone index. See the SQLite
-- variant of this migration for the full rationale.
--
-- Backfill: existing pinecone-backed rows get '' so the adapter
-- continues to omit the `namespace` field on requests (preserves
-- existing data location). Qdrant + Vectorize rows stay NULL.

ALTER TABLE namespaces ADD COLUMN vector_namespace TEXT;

UPDATE namespaces
   SET vector_namespace = ''
 WHERE vector_backend = 'pinecone';

ALTER TABLE version_indexes ADD COLUMN vector_namespace TEXT;

UPDATE version_indexes
   SET vector_namespace = ''
 WHERE vector_backend = 'pinecone';
