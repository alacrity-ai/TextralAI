// Vitest config for the Node-runtime adapter + integration tests.
//
// The cf-pool config (`vitest.config.ts`) drives the `pnpm test`
// flow — it boots miniflare and runs every route-level test against
// the in-memory D1 + R2 + KV + Vectorize stubs. Those tests rely on
// `cloudflare:test`'s `env`/`fetch` exports and aren't runnable
// under plain Node.
//
// This config is the inverse: plain-Node pool, `test/runtime/node/**`
// only. The Step-20 adapter tests live there (real Postgres / Redis /
// MinIO via testcontainers). Future Node-side route tests would
// also land under this tree once a runtime-agnostic harness is
// built (post-Phase-2 follow-up). Test-count parity with cf-pool
// is aspirational and not required for Phase 2 acceptance.
//
// Docker daemon required: the four testcontainers-backed specs
// (pg-db, s3-blob-store, redis-kv, redis-queue) skip cleanly — but
// each spec assumes a running Docker. CI provides one via the
// `docker` service.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/runtime/node/**/*.test.ts'],
    environment: 'node',
    // testcontainers cold-start (image pull + boot) can dominate the
    // first run on CI; per-test timeout is generous to absorb that.
    testTimeout: 90_000,
    hookTimeout: 120_000,
    // Each spec owns its own container. Sequencing them serially
    // keeps Docker resource usage bounded on small CI runners.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
