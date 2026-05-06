-- 0003_phase5_enrichment.sql (Postgres)
--
-- Phase 5: enrichment artifact lineage + provenance.
--
-- chunks.parent_chunk_id  — set on chunk- and section-scope artifacts;
--                           NULL for passages and document-scope artifacts.
-- chunks.enrichment_pass_id — which pass produced this row.
--
-- The PHASE_3_4 implementation kept document-scope provenance in
-- chunks.metadata.source_chunk_ids (a JSON array). That stays where
-- it is; it complements parent_chunk_id rather than replacing it.

ALTER TABLE chunks ADD COLUMN parent_chunk_id TEXT REFERENCES chunks(id);
ALTER TABLE chunks ADD COLUMN enrichment_pass_id TEXT;

-- Per-pass query: how many artifacts of type X from pass Y for version Z?
CREATE INDEX IF NOT EXISTS idx_chunks_pass
  ON chunks(version_id, enrichment_pass_id, artifact_type);

-- Lineage lookup: which artifacts derive from a given passage?
CREATE INDEX IF NOT EXISTS idx_chunks_parent
  ON chunks(parent_chunk_id);
