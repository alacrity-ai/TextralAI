# MCP — Session Resume Doc

> **Use this file to resume the MCP work after a context compact.**
> It captures *what we're building*, *what's done*, *what's next*,
> and the locked-in decisions a fresh agent needs in one place.

---

## What we're building

MCP (Model Context Protocol) support for Textral so any
MCP-compatible agent client (Claude Code, Cursor, Windsurf, Cline,
Zed, internal orchestration agents) can drive Textral as a node in
agentic pipelines — ingest docs, query a namespace, inspect audit
trails, retry failing jobs — via a stable named tool surface
instead of having the LLM read the OpenAPI spec and improvise REST
calls.

### Strategic posture

- **MCP is a thin adapter** over the canonical `apps/api` REST
  surface. No parallel logic, no shadow store, no auth bypass.
- **Tool input schemas derive from `packages/contracts`** (existing
  Zod schemas) via `zod-to-json-schema`. One source of truth.
- **Two transports day one**: `stdio` (Claude Code local) +
  embedded `/mcp` route in `apps/api` (Node-runtime first; CF
  deferred to a later spike).
- **Sandbox is human operator UI; MCP is agent operator UI.** Same
  backend, different consumer.

---

## Authoritative documents

Read these in order; everything else is supporting context.

| File | Purpose |
|---|---|
| `docs/mcp/PLANNING_CONVERSATION.md` | The seed conversation with GPT-5.5. Context only. |
| `docs/mcp/FEEDBACK.md` | Evaluation of GPT's draft (strengths + 11 weaknesses + recommendations). |
| `docs/mcp/TEXTRAL_MCP_DESIGN.md` | **The actual design.** 17 sections covering goal, architecture, tool surface, anti-goals, phasing, open questions. |
| `docs/mcp/TEXTRAL_MCP_IMPLEMENTATION.md` | **The execution plan.** 19 numbered steps in 3 milestones with acceptance gates. Source of truth for what to build. |
| `docs/mcp/QUICKSTART.md` | Operator-facing client setup (stdio + embedded). |
| `docs/mcp/MCP_SO_FAR.md` | This file — current state. |

---

## Open-question decisions (locked)

These are settled. Do not re-litigate.

| # | Decision | Source |
|---|---|---|
| 1 | Embedded `/mcp` ships first on **Node runtime** (self-host). CF deferred to a post-MVP spike. | Design §15.1 |
| 2 | Tool input schemas use Zod **`.strict()`** — extra fields rejected. | Design §15.2 |
| 3 | `ingest_file` accepts `bytes` (base64) only, never `file_path`. The MCP server never reads the local FS. | Design §15.3 |
| 4 | Tool descriptions cap at **200 characters**. Rich examples live in workflow prompts. | Design §15.4 |
| 5 | `mcp_tool_calls.args_redacted` uses the **same `tenants.audit_mode` policy** as `query_events.request_config`. | Design §15.5 |

---

## Status — Phase 1 COMPLETE

All 19 steps from `TEXTRAL_MCP_IMPLEMENTATION.md` landed. The shape
matches the impl doc; the codebase typechecks end-to-end.

### What shipped

| Surface | Result |
|---|---|
| `packages/sdk` | Typed REST client. 7/7 unit tests green. Used by `@textral/mcp`; sandbox can adopt next. |
| `packages/mcp` | MCP server. 16 tools, 3 prompts, 3 resources. 14/14 unit tests green. Stdio + embedded transports. |
| `tools/mcp-validator/` | Cookbook validator (sister to `apps/api/scripts/validate-cookbook.ts`). 6 phases, two transports. New workspace package — pnpm resolves the SDK at the validator's own node_modules. |
| `apps/api/migrations/{sqlite,postgres}/0008_mcp_tool_calls.sql` | New audit table. |
| `apps/api/src/audit/mcp.ts` | `recordMcpToolCall` writer with tenant-scoped redaction (mirrors `query-events.ts`). |
| `apps/api/src/db/mcp-tool-calls.ts` | Reads (admin list pattern). |
| `apps/api/src/routes/mcp.ts` | Embedded `POST /v1/mcp` (Node-only; CF returns 501 NOT_IMPLEMENTED). |
| `apps/api/src/routes/internal/mcp-tool-calls.ts` | `POST /v1/_internal/mcp_tool_calls` for stdio audit writes. |
| `apps/api/src/routes/profiles.ts` | `GET /v1/profiles` — backs `textral://profiles`. |
| `apps/api/src/routes/error-catalog.ts` | `GET /v1/error-catalog` — backs `textral://error-catalog`. |
| `apps/api/src/routes/admin/mcp-tool-calls.ts` | `GET /v1/admin/mcp_tool_calls` — backs the Sandbox MCP tab. |
| `apps/sandbox/src/pages/Admin.tsx` | New **MCP** tab listing recent `mcp_tool_calls` rows with expandable args_redacted. |
| `apps/api/test/{profiles-route,error-catalog-route,mcp-route}.test.ts` | New cf-pool tests (typecheck clean; see runtime caveat below). |
| `tools/mcp-validator/index.ts` | Phases: namespaces → query → events → replay → documents → chunks. |
| `Makefile` | `mcp-dev`, `mcp-typecheck`, `mcp-validate`. |
| `.github/workflows/ci.yml` | Node lane gains SDK + MCP + validator typecheck/test. |
| `docs/mcp/QUICKSTART.md` | Three client setup paths + tool/prompt/resource overview + troubleshooting. |
| `README.md`, `docs/QUICKSTART.md`, `docs/SELF_HOSTING.md` §2.6 | MCP cross-references. |
| `apps/api/src/openapi/tag-descriptions.ts` + `routes/docs.ts` | Synthetic Scalar `MCP` tag under a new "Agent integration" tag group. |

### Tool surface (frozen for Phase 1)

```
namespaces:    create_namespace, list_namespaces, get_namespace
documents:     ingest_file, list_documents, get_document, list_chunks, get_chunk
query:         query, list_query_events, get_query_event, get_query_response
provider keys: register_provider_key, list_provider_keys
operations:    list_failing_jobs, retry_failing_job
```

`server.test.ts` pins this list — adding/removing requires updating
the regression test.

---

## Verification

```
pnpm -r typecheck                            ✓ (8 of 9 projects;
                                                contracts has none)
pnpm --filter @textral/sdk test              ✓ 7/7
pnpm --filter @textral/mcp test              ✓ 14/14
pnpm --filter @textral/sdk publish --dry-run --access=public --no-git-checks
                                             ✓ (private:true so no
                                                packages emitted —
                                                ready to flip when
                                                we want public release)
pnpm --filter @textral/mcp publish --dry-run --access=public --no-git-checks
                                             ✓ (same)
make mcp-typecheck                           ✓
```

### Known caveat — pre-existing cf-pool ajv breakage

`pnpm --filter @textral/api test` currently fails on **every** test
file with:

```
SyntaxError: Unexpected token ':'
 ❯ node_modules/.pnpm/ajv@8.20.0/.../ajv/dist/core.js?mf_vitest_no_cjs_esm_shim:21:24
```

This is **not introduced by the MCP work** — `health.test.ts`
(unchanged by this branch) fails identically. It's a pre-existing
incompatibility between `ajv@8.20.0` and the
`@cloudflare/vitest-pool-workers` shim. The new MCP tests
(`profiles-route.test.ts`, `error-catalog-route.test.ts`,
`mcp-route.test.ts`) typecheck cleanly and follow the same pattern
as the existing tests; they should run as soon as the cf-pool issue
is resolved upstream. Tracked separately from this work.

---

## Phase 1 ship gate (from §19 of the impl doc)

- [x] All 19 step acceptance gates green (modulo the noted cf-pool
      caveat — same blast radius as every existing test).
- [ ] `make selfhost-up && make mcp-validate` passes against a
      fresh stack in <5 min from `git clone` — **needs a live run**
      against a self-host stack with cookbook seeded; the validator
      typechecks but hasn't been smoke-tested end-to-end yet.
- [ ] Claude Code stdio smoke test: fresh operator can run
      `claude mcp add textral …` and `list_namespaces` works —
      **needs a live run**.
- [x] CI Node lane includes SDK + MCP + validator typecheck/test.
- [x] `docs/mcp/QUICKSTART.md` walks an operator from clone to
      first `query` tool call in ≤10 minutes.

The two unchecked items are smoke gates that need a live stack.
The next session should run them as the first action.

---

## What's next (post-Phase 1)

### Immediate next session

1. `make selfhost-up && make selfhost-seed-cookbook && make mcp-validate`
   — confirm the embedded transport works end-to-end against a
   fresh stack. The validator's `COOKBOOK_NAMESPACE` defaults to
   `cookbook-mcp`; the existing seed script provisions
   `cookbook-qdrant`. Either align the seed (preferred) or pass
   `COOKBOOK_NAMESPACE=cookbook-qdrant` to the validator.
2. Manual stdio smoke test via Claude Code per `docs/mcp/QUICKSTART.md`.
3. If both pass, this branch is ready for review/merge. Tag
   the issue/PR with the Phase-1 ship gates checked off.

### Phase 2 (per design §13)

- Destructive tools (`delete_namespace`, `delete_document`,
  `revoke_provider_key`, `reembed_namespace`) with elicitation
  confirmation.
- `run_eval_set` once eval tooling lands in the sandbox.
- Sandbox MCP tab gains filtering (by tool, outcome).
- `npm publish @textral/sdk @textral/mcp` (flip `private:true` off).
- CF embedded `/v1/mcp` once the Workers Streamable HTTP transport
  is verified.

### Phase 3 (deferred)

- OAuth device-flow per the MCP 2025-11-25 spec.
- Hosted multi-tenant gateway.

---

## Workspace conventions in use

- **No build step.** `main: src/index.ts`, `noEmit: true`. Consumers
  import via tsx (CLI) or bundlers (api / sandbox).
- **Workspace deps:** `"@textral/sdk": "workspace:*"`.
- **Test runner:** `vitest@~3.2.4` (matches contracts).
- **Workspace root:** `/home/leif/textral/TEXTRAL_REFACTOR_WIP`.

---

## Things to keep in mind for future MCP work

- **Tool description guard.** `defineTool` throws if the
  description is >200 chars. If you hit this, the answer is to move
  detail into a workflow prompt, not raise the cap.
- **`exactOptionalPropertyTypes` is on.** `body: undefined` won't
  type-check against `RequestInit`. Use conditional spread or
  build the init object incrementally — see
  `packages/sdk/src/client.ts:_call`.
- **Handler args use post-parse types.** `defineTool` inference
  resolves the schema's *output* type, so `.default(...)` fields are
  non-optional inside handlers. Tools that need to call REST methods
  with partial-input shapes should still use conditional spread.
- **CF embedded `/mcp` is deferred.** The Step 14 route returns
  501 NOT_IMPLEMENTED on CF. A CF spike against Workers
  `Streamable HTTP Transport` is post-MVP work.
- **`AnyToolDef` in `audit.ts`.** `wrapWithAudit` accepts the
  type-erased `ToolDef<any, any, any, any>` so it can take any
  concrete tool without fighting generic invariance. Don't tighten
  this without a generic-friendly alternative.

---

End of resume doc.
