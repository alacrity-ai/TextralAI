// migrate-postgres.ts — apply the Postgres migration tree.
//
// Sequential file-by-file applier. Each file in
// `apps/api/migrations/postgres/` (sorted by name → numeric prefix
// drives order) runs inside a single connection, idempotent against
// a `_pg_migrations` ledger table.
//
// Usage:
//   POSTGRES_URL=postgres://textral:textral_dev@localhost:5432/textral \
//     pnpm --filter @textral/api exec tsx scripts/migrate-postgres.ts
//
// Or set POSTGRES_HOST/POSTGRES_PORT/POSTGRES_USER/POSTGRES_PASSWORD/
// POSTGRES_DB individually.

import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from 'pg';

// Path to the Postgres migration tree.
//   - Source / tsx mode: `apps/api/scripts/` → `..` → `apps/api/` →
//     `apps/api/migrations/postgres/`. Works out of the box.
//   - Bundled mode (Docker image): the bundle lives at
//     `/app/dist/scripts/`, but migrations are copied to
//     `/app/migrations/`. The env var override pins the right path.
//     The Dockerfile sets POSTGRES_MIGRATIONS_DIR=/app/migrations/postgres
//     for the runtime image; operators using a non-standard layout
//     can override.
const MIGRATIONS_DIR =
  process.env.POSTGRES_MIGRATIONS_DIR ??
  join(resolve(import.meta.dirname, '..'), 'migrations', 'postgres');

function buildUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const u = encodeURIComponent(process.env.POSTGRES_USER ?? 'textral');
  const p = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? 'textral_dev');
  const host = process.env.POSTGRES_HOST ?? 'localhost';
  const port = process.env.POSTGRES_PORT ?? '5432';
  const db = process.env.POSTGRES_DB ?? 'textral';
  return `postgres://${u}:${p}@${host}:${port}/${db}`;
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: buildUrl() });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS _pg_migrations (
      name      TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const all = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = new Set(
    (await client.query<{ name: string }>(`SELECT name FROM _pg_migrations`)).rows.map(
      (r) => r.name,
    ),
  );

  let applied_count = 0;
  for (const name of all) {
    if (applied.has(name)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
    process.stdout.write(`applying ${name} ... `);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(`INSERT INTO _pg_migrations (name) VALUES ($1)`, [name]);
      await client.query('COMMIT');
      applied_count++;
      process.stdout.write('ok\n');
    } catch (e) {
      await client.query('ROLLBACK');
      process.stdout.write('FAILED\n');
      throw e;
    }
  }

  await client.end();
  console.log(`migrate-postgres: ${applied_count} applied, ${all.length - applied_count} already-applied`);
}

await main();
