// Postgres `tsvector` + `ts_rank` → SparseSearch adapter.
//
// Schema requirement (Step 16's Postgres migration tree adds):
//   ALTER TABLE chunks ADD COLUMN tsv tsvector
//     GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;
//   CREATE INDEX chunks_tsv_idx ON chunks USING GIN (tsv);
//
// Postgres has no native BM25, so this implementation uses
// `ts_rank` (inverse-frequency weighted) instead. Both engines
// return rows sorted best-first; the RRF fusion in
// `retrieval/rrf.ts` is rank-positional (not score-absolute) so
// the score-function difference doesn't change fused output.
//
// The `match` field is a pre-built dialect-specific query
// expression. CF expects FTS5 MATCH syntax; Node expects
// Postgres tsquery (`plainto_tsquery`-compatible). Step 19+
// will need a `pg-query-translate.ts` helper to smooth over
// FTS5 operators (`*` wildcards, NEAR, column qualifiers) that
// `plainto_tsquery` doesn't accept; for now the caller passes
// expressions that work on both.

import type { Db, SparseSearch, SparseSearchArgs } from '../shared/interfaces.js';

export class PgSparseSearch implements SparseSearch {
  constructor(private readonly db: Db) {}

  async search(
    args: SparseSearchArgs,
  ): Promise<Array<{ id: string; score: number }>> {
    if (args.version_ids.length === 0 || args.artifact_types.length === 0) {
      return [];
    }
    const versionPh = args.version_ids.map(() => '?').join(',');
    const artifactPh = args.artifact_types.map(() => '?').join(',');
    // ts_rank returns higher = better; we sort DESC for the topK.
    // The CF FTS5 impl returns lower bm25 = better; the abstraction
    // hides this — RRF fusion is positional, not absolute-score.
    const sql = `
      SELECT id,
             ts_rank(tsv, plainto_tsquery('english', ?)) AS score
        FROM chunks
       WHERE tsv @@ plainto_tsquery('english', ?)
         AND tenant_id = ?
         AND namespace_id = ?
         AND version_id IN (${versionPh})
         AND artifact_type IN (${artifactPh})
       ORDER BY score DESC
       LIMIT ?`;
    return await this.db.all<{ id: string; score: number }>(sql, [
      args.match,
      args.match,
      args.tenant_id,
      args.namespace_id,
      ...args.version_ids,
      ...args.artifact_types,
      args.top_k,
    ]);
  }
}
