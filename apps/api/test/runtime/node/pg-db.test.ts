// PgDb integration test — uses a real testcontainers Postgres.
//
// Covers each Db method:
//   - exec  → INSERT, returns rowsAffected
//   - one   → first row or null
//   - all   → row array
//   - batch → atomic BEGIN/COMMIT (failure → ROLLBACK rolls back prior writes)
//   - transaction → fn-scoped txn
//
// The `?` → `$N` placeholder translation is exercised throughout.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { Pool } from 'pg';
import { PgDb } from '../../../src/runtime/node/pg-db.js';

let container: StartedTestContainer;
let pool: Pool;
let db: PgDb;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_PASSWORD: 'test',
      POSTGRES_USER: 'test',
      POSTGRES_DB: 'test',
    })
    .withExposedPorts(5432)
    // Postgres logs the readiness message twice during init; waiting
    // for the second occurrence avoids the "init phase ready, but
    // accepting-connections phase still racing" cold-start window
    // that occasionally yields ECONNREFUSED on the first connect.
    .withWaitStrategy(
      Wait.forAll([
        Wait.forLogMessage('database system is ready to accept connections', 2),
        Wait.forListeningPorts(),
      ]),
    )
    .withStartupTimeout(60_000)
    .start();

  pool = new Pool({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user: 'test',
    password: 'test',
    database: 'test',
    max: 4,
  });
  db = new PgDb(pool);

  await db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, val TEXT NOT NULL)`);
}, 90_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
}, 30_000);

describe('PgDb', () => {
  it('exec inserts and reports rowsAffected', async () => {
    const r = await db.exec(`INSERT INTO t (id, val) VALUES (?, ?)`, ['a', 'x']);
    expect(r.rowsAffected).toBe(1);
  });

  it('one returns the first row or null', async () => {
    await db.exec(`INSERT INTO t (id, val) VALUES (?, ?)`, ['b', 'y']);
    const row = await db.one<{ id: string; val: string }>(
      `SELECT id, val FROM t WHERE id = ?`,
      ['b'],
    );
    expect(row).toEqual({ id: 'b', val: 'y' });

    const miss = await db.one(`SELECT * FROM t WHERE id = ?`, ['nope']);
    expect(miss).toBeNull();
  });

  it('all returns every row', async () => {
    const rows = await db.all<{ id: string }>(
      `SELECT id FROM t WHERE id IN (?, ?) ORDER BY id`,
      ['a', 'b'],
    );
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('batch is atomic: all-or-nothing', async () => {
    // First batch succeeds.
    await db.batch([
      { sql: `INSERT INTO t (id, val) VALUES (?, ?)`, params: ['c', 'z'] },
      { sql: `INSERT INTO t (id, val) VALUES (?, ?)`, params: ['d', 'w'] },
    ]);
    expect((await db.all(`SELECT id FROM t WHERE id IN ('c', 'd')`)).length).toBe(2);

    // Second batch has a duplicate-key collision on the second statement.
    // Both writes must roll back — the table state should be unchanged.
    await expect(
      db.batch([
        { sql: `INSERT INTO t (id, val) VALUES (?, ?)`, params: ['e', 'q'] },
        { sql: `INSERT INTO t (id, val) VALUES (?, ?)`, params: ['a', 'dup'] },
      ]),
    ).rejects.toThrow();
    const e = await db.one(`SELECT id FROM t WHERE id = ?`, ['e']);
    expect(e).toBeNull();
  });

  it('batch with empty statements is a no-op', async () => {
    await expect(db.batch([])).resolves.toBeUndefined();
  });

  it('transaction: fn-scoped commit on success', async () => {
    await db.transaction(async (tx) => {
      await tx.exec(`INSERT INTO t (id, val) VALUES (?, ?)`, ['f', 'p']);
      await tx.exec(`INSERT INTO t (id, val) VALUES (?, ?)`, ['g', 'r']);
    });
    expect((await db.all(`SELECT id FROM t WHERE id IN ('f', 'g')`)).length).toBe(2);
  });

  it('?N numbered placeholders translate to $N (not $<counter>N)', async () => {
    // SQLite supports `?1`, `?2`, … to reuse param slots in a
    // statement (e.g., the same `now` value at multiple SET
    // positions). The earlier translate() turned `?1` into `$11`
    // (counter=1 + literal "1"), which Postgres parses as parameter
    // index 11 — usually unbound — surfacing as "operator is not
    // unique: unknown + unknown". This test pins the corrected
    // translation by reusing `?1` at three positions.
    await db.exec(
      `CREATE TABLE lease_test (
         id TEXT PRIMARY KEY,
         locked_at BIGINT,
         heartbeat_at BIGINT,
         lease_expires_at BIGINT
       )`,
    );
    await db.exec(`INSERT INTO lease_test (id) VALUES (?)`, ['j1']);
    // Mirror the lease.ts pattern: `?1` reused for `now` across
    // multiple SET positions plus the WHERE clause. No arithmetic
    // (Postgres can't infer types on `$1 + $2` without column
    // anchoring — that's why lease.ts now precomputes the sum in JS).
    const r = await db.exec(
      `UPDATE lease_test
          SET locked_at = ?1,
              heartbeat_at = ?1,
              lease_expires_at = ?2
        WHERE id = ?3
          AND (lease_expires_at IS NULL OR lease_expires_at < ?1)`,
      [1_700_000_000_000, 1_700_000_300_000, 'j1'],
    );
    expect(r.rowsAffected).toBe(1);
    const row = await db.one<{
      locked_at: number;
      heartbeat_at: number;
      lease_expires_at: number;
    }>(
      `SELECT locked_at, heartbeat_at, lease_expires_at
         FROM lease_test WHERE id = ?`,
      ['j1'],
    );
    expect(row).not.toBeNull();
    expect(row!.locked_at).toBe(1_700_000_000_000);
    expect(row!.heartbeat_at).toBe(1_700_000_000_000);
    expect(row!.lease_expires_at).toBe(1_700_000_300_000);
  });

  it('JSON/JSONB columns return as raw strings, not pre-parsed objects', async () => {
    // Cross-runtime parity: D1 stores JSON-shaped payloads in TEXT
    // columns, so call sites do `JSON.parse(row.config_json)`.
    // node-postgres auto-parses JSONB into a JS object by default,
    // which makes `JSON.parse(<object>)` throw
    // `'"[object Object]" is not valid JSON'`. PgDb registers a
    // pass-through type parser for OID 114 (json) and 3802 (jsonb)
    // so callers receive a string in both runtimes. This test pins
    // that behavior.
    await db.exec(
      `CREATE TABLE jsoncols (id TEXT PRIMARY KEY, j JSON, jb JSONB)`,
    );
    await db.exec(`INSERT INTO jsoncols (id, j, jb) VALUES (?, ?, ?)`, [
      'r1',
      JSON.stringify({ a: 1, b: ['x', 'y'] }),
      JSON.stringify({ profile: 'narrative', dims: 1536 }),
    ]);
    const row = await db.one<{ id: string; j: string; jb: string }>(
      `SELECT id, j, jb FROM jsoncols WHERE id = ?`,
      ['r1'],
    );
    expect(row).not.toBeNull();
    expect(typeof row!.j).toBe('string');
    expect(typeof row!.jb).toBe('string');
    expect(JSON.parse(row!.j)).toEqual({ a: 1, b: ['x', 'y'] });
    expect(JSON.parse(row!.jb)).toEqual({ profile: 'narrative', dims: 1536 });
  });

  it('BIGINT columns return as JS numbers, not strings', async () => {
    // Cross-runtime parity: D1's INTEGER comes back as `number`;
    // node-postgres returns BIGINT (int8) as a `string` by default,
    // which silently breaks every numeric comparison in the route
    // layer (e.g., `body.byteLength !== intent.declared_size`).
    // PgDb registers a type parser for OID 20 → parseInt to fix this
    // at the boundary; this test pins that behavior.
    await db.exec(
      `CREATE TABLE big (id TEXT PRIMARY KEY, n BIGINT NOT NULL, ts BIGINT NOT NULL)`,
    );
    await db.exec(`INSERT INTO big (id, n, ts) VALUES (?, ?, ?)`, [
      'x',
      652,
      Date.now(),
    ]);
    const row = await db.one<{ id: string; n: number; ts: number }>(
      `SELECT id, n, ts FROM big WHERE id = ?`,
      ['x'],
    );
    expect(row).not.toBeNull();
    expect(typeof row!.n).toBe('number');
    expect(row!.n).toBe(652);
    expect(typeof row!.ts).toBe('number');
    expect(row!.ts).toBeGreaterThan(1_700_000_000_000);
  });

  it('transaction: rollback on throw', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.exec(`INSERT INTO t (id, val) VALUES (?, ?)`, ['h', 's']);
        throw new Error('rollback me');
      }),
    ).rejects.toThrow('rollback me');
    const h = await db.one(`SELECT id FROM t WHERE id = ?`, ['h']);
    expect(h).toBeNull();
  });
});
