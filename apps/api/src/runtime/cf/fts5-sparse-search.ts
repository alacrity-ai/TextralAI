// SQLite FTS5 → SparseSearch adapter. Runs the `chunks_fts` virtual
// table query that previously lived in `db/chunks.ts:sparseSearchChunks`.
//
// The SQL is SQLite-specific (`bm25()`, `MATCH`); when Step 17 ships
// the Node runtime, a separate `runtime/node/pg-sparse-search.ts` will
// implement the same `SparseSearch` interface with Postgres `tsvector`
// + `ts_rank`. Both runtimes share the same `SparseSearchArgs` shape;
// only the SQL dialect differs.

import type { Db, SparseSearch, SparseSearchArgs } from '../shared/interfaces.js';

export class Fts5SparseSearch implements SparseSearch {
  constructor(private readonly db: Db) {}

  async search(args: SparseSearchArgs): Promise<Array<{ id: string; score: number }>> {
    if (args.version_ids.length === 0 || args.artifact_types.length === 0) {
      return [];
    }
    const versionPh = args.version_ids.map(() => '?').join(',');
    const artifactPh = args.artifact_types.map(() => '?').join(',');
    const sql = `
      SELECT c.id AS id, bm25(chunks_fts) AS score
        FROM chunks c
        JOIN chunks_fts f ON f.rowid = c.rowid
       WHERE f.text MATCH ?
         AND c.tenant_id = ?
         AND c.namespace_id = ?
         AND c.version_id IN (${versionPh})
         AND c.artifact_type IN (${artifactPh})
       ORDER BY bm25(chunks_fts) ASC
       LIMIT ?`;
    return await this.db.all<{ id: string; score: number }>(sql, [
      args.match,
      args.tenant_id,
      args.namespace_id,
      ...args.version_ids,
      ...args.artifact_types,
      args.top_k,
    ]);
  }
}
