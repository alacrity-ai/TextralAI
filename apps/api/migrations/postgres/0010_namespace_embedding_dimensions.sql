-- 0010 — embedding_dimensions on namespaces. Postgres parallel.
-- See `migrations/sqlite/0010_namespace_embedding_dimensions.sql`
-- for the full design rationale. Each Textral namespace points at a
-- single backing-store handle (Vectorize binding / Qdrant collection /
-- Pinecone index), each of which locks the vector dim at create time.
-- Pre-fix the dim was silently inferred from `default_embedding_profile`
-- with a 1536 fallback; this column makes it explicit + immutable, and
-- the ingest dispatch validates against it.

ALTER TABLE namespaces
    ADD COLUMN embedding_dimensions INTEGER NOT NULL DEFAULT 1536;

UPDATE namespaces
   SET embedding_dimensions = CASE
     WHEN default_embedding_profile = 'workers-bge-large-en-v1-5-1024' THEN 1024
     WHEN default_embedding_profile = 'workers-bge-base-en-v1-5-768' THEN 768
     WHEN default_embedding_profile = '@cf/baai/bge-large-en-v1.5' THEN 1024
     WHEN default_embedding_profile = '@cf/baai/bge-base-en-v1.5' THEN 768
     WHEN default_embedding_profile LIKE '%-3072' THEN 3072
     WHEN default_embedding_profile LIKE '%-1536' THEN 1536
     WHEN default_embedding_profile LIKE '%-1024' THEN 1024
     WHEN default_embedding_profile LIKE '%-768' THEN 768
     WHEN default_embedding_profile LIKE '%-512' THEN 512
     WHEN default_embedding_profile LIKE '%-256' THEN 256
     ELSE 1536
   END;
