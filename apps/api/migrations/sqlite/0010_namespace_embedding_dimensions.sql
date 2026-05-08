-- 0010 — embedding_dimensions on namespaces.
--
-- Each Textral namespace points at a single backing-store handle
-- (Vectorize binding, Qdrant collection, Pinecone index). Every one
-- of those locks vector dimension at create-time:
--
--   * Vectorize  — index dim set when the index was provisioned.
--                  Today: one global 1536-dim binding per Worker.
--   * Qdrant     — collection dim set in `vectors.size` on first
--                  PUT /collections/{name}. Immutable thereafter.
--   * Pinecone   — index dim set operator-side. All namespaces
--                  inside one index share that dim.
--
-- Pre-fix, the dim was silently inferred from `default_embedding_profile`
-- via a 4-line if/else with a 1536 fallback. The contract returned no
-- `embedding_dimensions` field; ingest accepted arbitrary `dimensions`
-- and didn't validate against the namespace; the only error path was
-- the eventual 4xx from the vector store, with confusing context.
--
-- This makes dim explicit + immutable on the namespace row, and the
-- ingest dispatch validates against it. `default_embedding_profile`
-- keeps its existing role as a soft default for which embedding model
-- to use; dim is now a separate, hard column.
--
-- Backfill rule: profiles whose name encodes a dim (suffix `-<digits>`)
-- adopt that dim; the historically-known bare names map to their
-- intended dim; everything else falls through to the existing default.

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
