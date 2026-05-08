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
          // The MCP_SMOKE_* + RUN_LIVE_TESTS forwards expose the parent
          // process's gating env vars as bindings inside the workers
          // pool, so module-scope `process.env.MCP_SMOKE_CF` reads in
          // gated test files (mcp-cf-smoke.test.ts, live-smoke.test.ts)
          // see them. Without this passthrough miniflare runs with an
          // empty process.env and the tests silently no-op.
          bindings: {
            TEST_MIGRATIONS: migrations,
            MCP_SMOKE_CF: process.env.MCP_SMOKE_CF ?? '',
            MCP_SMOKE_KEY: process.env.MCP_SMOKE_KEY ?? '',
            MCP_SMOKE_BASE_URL: process.env.MCP_SMOKE_BASE_URL ?? '',
            MCP_SMOKE_NAMESPACE: process.env.MCP_SMOKE_NAMESPACE ?? '',
            RUN_LIVE_TESTS: process.env.RUN_LIVE_TESTS ?? '',
          },
        },
      },
    },
  },
});
