// Global Vitest setup. Applies D1 migrations to the in-memory D1 instance
// before any test runs, and patches the test `env` with the runtime-shared
// Bindings shape (db, blobs, kv, …) so tests can call the new helpers
// without going through the worker fetch path.
//
// vitest-pool-workers v0.8 does not auto-apply migrations from
// wrangler.toml's `migrations_dir`. We do it here.

import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import type { D1Migration } from '@cloudflare/vitest-pool-workers/config';
import type { Env } from '../src/types.js';
import { buildCfBindings } from '../src/runtime/cf/bindings.js';

beforeAll(async () => {
  const e = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);

  // Patch the test env with the runtime-shared Bindings shape
  // (db, blobs, kv, …) so tests that call helpers expecting `env.db`
  // (and friends) work without going through buildCfBindings per call.
  // The patched env is the same object the cloudflare:test fixture
  // returns, so `import { env }` from any test sees these fields.
  //
  // The env-level patch deliberately uses `NoopBackgroundTasks`
  // (passing `null` for ctx). Per-request paths through `worker.fetch`
  // rebuild bindings with a real ExecutionContext. Any test that calls
  // a helper directly (outside fetch) and expects `bg.spawn` to keep
  // a promise alive will silently lose it — but every `bg.spawn` call
  // site reads `c.env.bg`, never bare `env.bg`, so this is theoretical
  // today.
  const built = buildCfBindings(e, null);
  Object.assign(env, built);

  // The cf-pool `[env.test]` block in `wrangler.toml` does not bind
  // Vectorize (no local emulator), so `env.VECTORIZE_OPENAI_LARGE`
  // and therefore `bindings.vectorize` are undefined. Phase 2 G-2 made
  // `vectorStoreFor` fail-fast when the vectorize handle is missing,
  // which is the right runtime behavior — but the test path for
  // `vector_backend: 'vectorize'` namespace creation never actually
  // exercises upsert/query, so we stub a minimal handle here so the
  // namespace-create flow's `vectors.forBinding(...)` resolves cleanly.
  // The stub matches `VectorizeIndexHandle` structurally; tests that
  // exercise upsert/query mock `globalThis.fetch` and never reach
  // these methods.
  if (!(env as { vectorize?: unknown }).vectorize) {
    (env as { vectorize?: unknown }).vectorize = {
      upsert: async () => ({ mutationId: 'test-stub' }),
      query: async () => ({ matches: [] }),
      deleteByIds: async () => ({ count: 0 }),
    };
  }
});
