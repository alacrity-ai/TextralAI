# Bug: `ajv` parse error blocks every `@textral/api` test suite

Filed 2026-05-06.

## Symptom

`pnpm --filter '@textral/api' test` fails to load **every** test file (60/60).
Each suite errors at module-load time with:

```
SyntaxError: Unexpected token ':'
 ❯ home/leif/.../node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/core.js?mf_vitest_no_cjs_esm_shim:21:24
 ❯ home/leif/.../node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/ajv.js?mf_vitest_no_cjs_esm_shim:4:16

 Test Files  60 failed (60)
      Tests  no tests
```

No tests run. CI for `apps/api` is wedged.

## Where it comes from

- `ajv@8.20.0` is pulled in by `@modelcontextprotocol/sdk@1.29.0`
  (declared in `packages/mcp/package.json`).
- `apps/api/src/routes/mcp.ts` imports `@textral/mcp` (`packages/mcp`),
  which transitively imports `@modelcontextprotocol/sdk/server/*`,
  which loads `ajv`.
- `apps/api` tests build from `apps/api/src/app.ts`, which mounts
  `mcpRoute` — so the MCP SDK's import graph reaches every test.
- The `?mf_vitest_no_cjs_esm_shim` query suffix is the
  `@cloudflare/vitest-pool-workers@0.8.71` CJS→ESM shim. It rewrites
  CJS modules so Miniflare's V8 isolate can `import` them, but the
  shim mishandles `ajv`'s `dist/core.js` and `dist/ajv.js` (CJS builds
  with no `"type": "module"` and no `"exports"` field).
- `ajv` ships only `dist/*.js` (CommonJS). The shim's tokenizer trips
  on the file at column 24 of line 21 (`core.js`) — most likely on a
  `Type:` annotation or an `Object.defineProperty` shape the rewriter
  doesn't normalize.

This is not caused by the bug fixes from `5-6-2026.md` /
`5-6-2026-SOLUTION-PLAN.md`; the same import graph ran the MCP SDK
before those landed. Verifiable by reverting the bug-fix branch and
re-running the test command — failures persist.

## Why every suite fails

Vitest evaluates a test file's import graph before any test runs.
The first `import` chain that reaches `app.ts` (or any module that
mounts the MCP route) loads `@textral/mcp` → MCP SDK → `ajv`, throws
`SyntaxError`, and the suite is reported as failed with `no tests`.

## Reproducing

```bash
pnpm install
pnpm --filter '@textral/api' test 2>&1 | grep -A 5 "Failed Suites"
# All 60 test files report the same ajv shim SyntaxError.
```

`@textral/contracts`, `@textral/sdk`, `@textral/mcp`, and
`@textral/sandbox` typecheck and (where applicable) test cleanly —
the failure is scoped to the api package's `vitest-pool-workers`
config.

## Investigation surface

- `apps/api/vitest.config.ts` — Workers pool config; sets
  `defineWorkersConfig`. The shim runs inside the pool.
- `node_modules/.pnpm/@cloudflare+vitest-pool-workers@0.8.71/...` —
  search for `mf_vitest_no_cjs_esm_shim` to see the rewriter.
- `packages/mcp/src/transport-stdio.ts`,
  `packages/mcp/src/transport-http.ts`,
  `packages/mcp/src/server.ts` — entry points that pull the MCP SDK.
- `apps/api/src/routes/mcp.ts` — the api-side seam that drags MCP
  into the test graph.

## Possible fixes (sketch — verify before committing)

1. **Pin `ajv` to a version the shim handles.** `ajv@8.12.0` shipped
   before some of the syntax constructs that trip the rewriter. Add
   a `pnpm.overrides` entry in the root `package.json`:
   ```json
   "pnpm": { "overrides": { "ajv": "8.12.0" } }
   ```
   Verify the MCP SDK's runtime behavior is unchanged.

2. **Bump `@cloudflare/vitest-pool-workers`.** 0.8.71 is current as
   of this filing; check the changelog for shim fixes against
   ajv-shaped CJS. If a newer release lands, prefer that over a
   pinned ajv.

3. **Move MCP route loading behind a runtime guard in `app.ts`.**
   The MCP HTTP route is Node-runtime-only (see the 501 in
   `mcp.ts:29`). If the import itself can be deferred to runtime
   (dynamic `import()` inside the handler), the test graph never
   touches the MCP SDK and ajv falls out of the test path entirely.
   Trade-off: the route's openapi metadata may need a different
   registration path so it still appears in the spec.

4. **Add a Vite alias that resolves `ajv` to a pre-compiled ESM
   build** (e.g. `ajv/dist/ajv.bundle.js` if one exists, or a
   bundled fork via `tsup`). Last-resort; brittle on upgrades.

Recommended first step: try (1), it's the lowest-blast-radius
diagnostic. If it works, ship the override with a comment pointing
back to this bug and an upgrade path. If it doesn't, escalate to (3).

## Acceptance criteria

- [ ] `pnpm --filter '@textral/api' test` loads all 60 suites without
      a syntax error in `ajv`.
- [ ] At least one previously-failing suite (e.g. `test/health.test.ts`)
      runs to a green pass.
- [ ] No regression in `pnpm --filter '@textral/mcp' typecheck` or
      stdio/http MCP smoke tests.
- [ ] If `pnpm.overrides` is used, root `package.json` carries a
      comment referencing this bug + the upstream issue (open one
      against `@cloudflare/vitest-pool-workers` if no fix is in
      flight).

## Notes

- The same `?mf_vitest_no_cjs_esm_shim` token appears in several open
  issues against `vitest-pool-workers` for other CJS deps; check
  their tracker before opening a new one.
- This bug is independent of the three bugs in `5-6-2026.md`; those
  were runtime fixes (gpt-5 inference, dimension mismatch UX, model
  registry) and don't touch the test infrastructure.
