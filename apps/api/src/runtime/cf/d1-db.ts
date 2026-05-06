// D1 → Db adapter. Translates the runtime-shared `Db` interface
// onto the Cloudflare D1 binding API.
//
// One per-request instance is built in `buildCfBindings`. The class
// itself is stateless (the wrapped binding is the only field) so
// the cost of instantiation is one allocation per request.

import type { Db, DbStatement } from '../shared/interfaces.js';

// D1's `bind(...)` accepts string | number | boolean | null |
// ArrayBuffer (undefined coerces to null). Widen to match the actual
// contract — the previous narrower type masked legitimate boolean
// params at compile time.
type D1Param = string | number | boolean | null | ArrayBuffer;

export class D1Db implements Db {
  constructor(private readonly d1: D1Database) {}

  async one<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    const row = await this.d1
      .prepare(sql)
      .bind(...(params as D1Param[]))
      .first<T>();
    return row ?? null;
  }

  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const out = await this.d1
      .prepare(sql)
      .bind(...(params as D1Param[]))
      .all<T>();
    return out.results ?? [];
  }

  async exec(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rowsAffected: number }> {
    const res = await this.d1
      .prepare(sql)
      .bind(...(params as D1Param[]))
      .run();
    return { rowsAffected: res.meta.changes ?? 0 };
  }

  async batch(statements: DbStatement[]): Promise<void> {
    if (statements.length === 0) return;
    const prepared = statements.map((s) =>
      this.d1.prepare(s.sql).bind(...(s.params as D1Param[])),
    );
    await this.d1.batch(prepared);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // D1's binding API has no explicit BEGIN/COMMIT. The existing
    // db helpers already operate without multi-statement transactions;
    // this is a no-op wrapper for shape parity with PgDb.
    return fn(this);
  }
}
