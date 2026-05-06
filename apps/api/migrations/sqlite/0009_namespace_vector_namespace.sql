-- 0009 — vector_namespace column.
--
-- Pinecone-specific. Maps a Textral namespace onto a *Pinecone
-- native namespace* inside the operator-provisioned index, so many
-- Textral namespaces can share one Pinecone index — the canonical
-- Pinecone multi-tenancy pattern. Pre-fix: every Textral namespace
-- required its own Pinecone index, which is operator-hostile and
-- billed per index.
--
-- Backfill: existing pinecone-backed rows wrote to Pinecone's
-- default (unnamed) namespace. Set the column to '' so the adapter
-- continues to omit the `namespace` field on requests, preserving
-- existing data location. New pinecone namespaces created
-- post-migration default to the Textral slug at the route layer.
--
-- Qdrant + Vectorize rows leave the column NULL — the field is
-- ignored on those backends.
--
-- Same column lands on `version_indexes` (denormalised from the
-- namespace at vidx-create time), so the ingest hot path
-- (upsert / delete-by-filter) doesn't need a namespace lookup
-- per call. See `apps/api/src/ingestion/dispatch.ts`.

ALTER TABLE namespaces ADD COLUMN vector_namespace TEXT;

UPDATE namespaces
   SET vector_namespace = ''
 WHERE vector_backend = 'pinecone';

ALTER TABLE version_indexes ADD COLUMN vector_namespace TEXT;

UPDATE version_indexes
   SET vector_namespace = ''
 WHERE vector_backend = 'pinecone';
