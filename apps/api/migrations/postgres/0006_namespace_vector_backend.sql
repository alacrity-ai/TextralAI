-- 0006_namespace_vector_backend.sql (Postgres)
--
-- V3 Phase 1 — pluggable vector store backend selection.
--
-- Adds two columns to BOTH `namespaces` and `version_indexes`:
--   * vector_backend     'vectorize' | 'qdrant' | 'pinecone'
--   * vector_index_name  opaque per-backend handle (collection name
--                        for Qdrant; host URL for Pinecone; NULL
--                        for Vectorize).
--
-- Defaults preserve V2 behavior: every existing namespace continues
-- to use Vectorize. New namespaces that want Qdrant/Pinecone pass
-- the field explicitly on POST /v1/namespaces.
--
-- The columns are denormalized onto version_indexes (read by the
-- ingest hot path) to avoid a namespace lookup per upsert.

ALTER TABLE namespaces ADD COLUMN vector_backend TEXT NOT NULL DEFAULT 'vectorize';
ALTER TABLE namespaces ADD COLUMN vector_index_name TEXT;

ALTER TABLE version_indexes ADD COLUMN vector_backend TEXT NOT NULL DEFAULT 'vectorize';
ALTER TABLE version_indexes ADD COLUMN vector_index_name TEXT;
