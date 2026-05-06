// Global setup for the Node-runtime test suite. Each spec under
// `test/runtime/node/**` already owns its own testcontainers
// lifecycle (beforeAll/afterAll); per-spec ownership keeps each
// test independently runnable and avoids the shared-state pitfalls
// that come with cross-spec fixtures.
//
// This file exists for two reasons:
//   1. The design doc (V3 Phase 2 Step 21.2) names it as part of
//      the deliverable.
//   2. Future runtime-agnostic route tests can hang shared bindings
//      (a Postgres + Redis + MinIO triple) here once they exist;
//      today there's no such test, so the file is a no-op.
//
// Docker daemon required for the testcontainers-backed specs (4 of 8).
// Pure-unit specs (bg-tasks, node-crypto-hasher, stdout-metrics,
// http-container-invoker) run anywhere.
