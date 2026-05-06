// Postgres → Db adapter. Uses `pg.Pool` for connection management.
//
// `?` placeholders in the helpers are translated to `$1`, `$2`, ...
// at this boundary so the helpers in `db/*.ts` don't fork by dialect.
// `batch(...)` wraps a single BEGIN/COMMIT — atomic semantics matching
// D1's batch primitive.

import { types as pgTypes } from 'pg';
import type { Pool, PoolClient } from 'pg';
import type { Db, DbStatement } from '../shared/interfaces.js';

// Coerce Postgres BIGINT (int8, OID 20) to a JS `number` instead of
// the default `string`. Cross-runtime parity: D1's INTEGER columns
// come back as `number`, so the helpers in `db/*.ts` (and every
// route comparing `r.created_at < Date.now()`, `body.byteLength
// !== intent.declared_size`, etc.) assume `number`. Without this
// coercion, BIGINT columns silently arrive as strings and equality
// comparisons fail (`652 !== "652"` is true).
//
// Safe-range trade-off: pg-default returns string to avoid losing
// precision past 2^53 (≈ 9.0 × 10^15). Every BIGINT in our schema
// is well inside that range — Unix-ms timestamps don't approach it
// until the year ~287,000; file sizes are bounded by content; chunk
// indexes are tens of thousands at most. If a future column ever
// needs the full int8 range (e.g., Snowflake-style IDs), the
// per-column fix is to either use the string form deliberately or
// SELECT it as TEXT.
//
// Side effect at module load: pg's type parser registry is process-
// global. The api process loads `pg` only through this module, so
// this side effect is scoped to the runtime that actually uses it.
pgTypes.setTypeParser(20, (value) => parseInt(value, 10));

// Coerce Postgres JSON (OID 114) and JSONB (OID 3802) to the raw
// JSON string instead of pg's default-parsed JS object. Same
// cross-runtime parity reason as BIGINT: D1 stores JSON-shaped
// payloads in TEXT columns, so call sites do `JSON.parse(row.x)`.
// Letting pg pre-parse means `JSON.parse(<object>)` runs and
// throws `'"[object Object]" is not valid JSON'`. Returning the
// raw text keeps every caller working unchanged on both runtimes.
//
// The cost is one redundant serialize+parse per JSON column read,
// negligible for our payload sizes (config_json, request_config,
// metadata blobs are KBs at most). If a future hot path needs
// pre-parsed JSONB for performance, expose a typed helper that
// reads with a per-call type-parser override rather than flipping
// this default.
const passThroughJson = (value: string): string => value;
pgTypes.setTypeParser(114, passThroughJson);
pgTypes.setTypeParser(3802, passThroughJson);

export class PgDb implements Db {
  constructor(private readonly pool: Pool) {}

  async one<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    const r = await this.pool.query(translate(sql), params);
    return (r.rows[0] as T) ?? null;
  }

  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(translate(sql), params);
    return r.rows as T[];
  }

  async exec(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rowsAffected: number }> {
    const r = await this.pool.query(translate(sql), params);
    return { rowsAffected: r.rowCount ?? 0 };
  }

  async batch(statements: DbStatement[]): Promise<void> {
    if (statements.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of statements) {
        await client.query(translate(s.sql), s.params);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txDb = makeTxDb(client);
      const result = await fn(txDb);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

function makeTxDb(client: PoolClient): Db {
  return {
    async one<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
      const r = await client.query(translate(sql), params);
      return (r.rows[0] as T) ?? null;
    },
    async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
      const r = await client.query(translate(sql), params);
      return r.rows as T[];
    },
    async exec(sql, params = []) {
      const r = await client.query(translate(sql), params);
      return { rowsAffected: r.rowCount ?? 0 };
    },
    async batch(statements) {
      // Already inside a transaction — sequence the statements;
      // any failure bubbles to the outer transaction's ROLLBACK.
      for (const s of statements) {
        await client.query(translate(s.sql), s.params);
      }
    },
    async transaction() {
      throw new Error('Nested transactions are not supported');
    },
  };
}

/** SQLite/D1 helpers use two flavors of placeholder, both of which
 *  Postgres expresses as `$N`:
 *
 *   - **Plain `?`** (positional, in order): used by `db/chunks.ts`,
 *     `db/api-keys.ts`, etc. Each `?` consumes the next param slot.
 *   - **`?N` (numbered positional)**: SQLite shorthand for "reuse
 *     param slot N." Used by `ingestion/lease.ts` where the same
 *     value (e.g., `now`) lands in multiple places and an explicit
 *     index is clearer than passing the same value 5×.
 *
 *  The two flavors don't mix in a single statement (every consumer
 *  picks one). Translate them in one pass:
 *   - `?N`     →  `$N`   (preserve the index)
 *   - bare `?` →  `$<n>` (running counter)
 *
 *  Earlier versions only handled bare `?`; `?N` would translate to
 *  `$<counter>N` (e.g., `?1` → `$11`), which Postgres parses as
 *  parameter index 11 — usually unbound — and reports as "operator
 *  is not unique: unknown + unknown" when used in arithmetic.
 *  Regression test: `lease.test.ts`. */
function translate(sql: string): string {
  let positional = 0;
  return sql.replace(/\?(\d*)/g, (_match, indexed: string) =>
    indexed ? `$${indexed}` : `$${++positional}`,
  );
}
