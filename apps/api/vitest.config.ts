// Vitest config for @cloudflare/vitest-pool-workers v0.8.
//
// `readD1Migrations` loads SQL migration files at config-resolution time
// and stuffs them into a TEST_MIGRATIONS binding the test setup file
// then applies via `applyD1Migrations`. (vitest-pool-workers does not
// auto-apply migrations; it just makes the tooling for it ergonomic.)

import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsPath = path.join(__dirname, 'migrations', 'sqlite');
const migrations = await readD1Migrations(migrationsPath);

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // The Node-runtime adapter tests live under `test/runtime/node/`
    // and use testcontainers (real Postgres/Redis/MinIO) + node:crypto.
    // They run under the separate `vitest.node.config.ts` pool — exclude
    // them here so the cf vitest pool doesn't try to load them.
    exclude: ['**/node_modules/**', 'test/runtime/node/**'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml', environment: 'test' },
        miniflare: {
          // Migrations are read at config time and applied via setup.ts.
          bindings: {
            TEST_MIGRATIONS: migrations,
          },
        },
      },
    },
  },
});
