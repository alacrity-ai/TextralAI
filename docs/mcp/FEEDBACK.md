# MCP Planning — Feedback on the GPT-5.5 Conversation

> Companion to `PLANNING_CONVERSATION.md`. Read this before drafting
> `TEXTRAL_MCP_DESIGN.md`.

---

## 1. Executive summary of the goal

You want Textral to participate in **agentic pipelines** — not just as a
UI/CLI consumer of an HTTP API, but as a first-class capability provider
that any MCP-compatible agent (Claude Code, Cursor, Windsurf, internal
orchestrators) can compose into larger workflows. Concretely:

- **Day-one win**: a developer running Claude Code can say "ingest the
  PDFs in `./contracts` into a `vendor-contracts` namespace and
  summarize the top-10 obligations" and have it executed against a
  Textral deploy without writing any glue code.
- **Strategic win**: orgs that self-host Textral can drop it into their
  existing agentic infrastructure as a *node* (ingester + query surface
  + audit) rather than as a standalone product. The vector-backend-
  agnostic, BYOK, audit-rich nature of Textral becomes the
  differentiator: it's a RAG primitive that fits inside larger agent
  decision graphs.
- **Implicit win**: MCP gives you a discovery-and-tool-contract surface
  that's becoming the standard glue layer for LLM tools. Skipping it
  means writing per-client integrations forever.

The framing is correct. The question isn't *whether* to add MCP — it's
*what shape*.

---

## 2. Evaluation of GPT's proposed design

### What it gets right

| Decision | Take |
|---|---|
| MCP layer = thin adapter, not a parallel implementation | ✅ Correct. Textral's audit rows, redaction policy, profile resolution, etc. all live in the API. Bypassing them would be a disaster. |
| Default to `stdio` first, HTTP/SSE later, embedded `/mcp` last | Mostly right. Reorder — see §3. |
| Anti-goals list ("MCP must NOT chunk / embed / re-implement retrieval") | ✅ Critical. Worth pinning in the actual design doc as load-bearing. |
| Filesystem stays in Claude Code's native fs tools, not Textral MCP | ✅ Right boundary. Textral has no business with `./contracts/*`. |
| Tools / Resources / Prompts as the three primitives | ✅ Matches the MCP spec; these are the right axes. |
| `textral_wait_for_ingestion` as an MCP-native convenience over polling | ✅ Exactly the kind of "agent ergonomics" value MCP should add. |
| Tenant isolation via API key | ✅ Right. Don't reinvent auth in the MCP layer. |

### Where it's weak or wrong

**a. Tool granularity is mismatched.** The 4-step ingest chain
(`register_document` → `create_upload` → `finalize_upload` →
`ingest_document` → `wait_for_ingestion`) exposes the REST state
machine to the agent. That's REST-shaped, not agent-shaped. An LLM will
burn turns and tokens stitching the chain together, and it'll get the
order wrong sometimes. The right tool is one **`ingest_file`** that
runs the whole chain internally and returns either a job_id (async) or
a completed result (sync option). Agents shouldn't care about upload
intents.

**b. No reuse of `packages/contracts`.** GPT proposed `packages/sdk` +
`packages/mcp-server` as if they were greenfield. Textral already has
`packages/contracts` with every Zod schema needed (`QueryRequest`,
`Chunk`, `Document`, `IngestRequest`, etc.). The MCP server's tool
input schemas should be **derived from the same Zod schemas the API
uses**, not re-declared — that's the only way to guarantee they don't
drift. This is the same lesson the sandbox just proved: one-source-of-
truth or you pay forever.

**c. Tool naming is bloated.** `textral_create_namespace`,
`textral_list_namespaces`, etc. — MCP servers already have a name
(`textral`) which the client namespaces. Repeating `textral_`
everywhere is noise. Use `create_namespace`, `query`, `ingest_file`.
The MCP client surface will read `textral.create_namespace`.

**d. Phasing puts embedded `/mcp` last; that may be wrong.** For
**self-host operators**, an embedded `/mcp` route inside the existing
Hono app means one container instead of two — material simplicity. For
**Cloudflare**, embedded MCP is also straightforward (the official
`@modelcontextprotocol/sdk` has Workers support). Stdio remains the
local-dev path. **The package should support both transports** — same
tool definitions, different bootstrap. Make transport a one-line
choice, not a phase boundary.

**e. Missing primitives MCP gives us for free that GPT didn't mention:**

- **Progress notifications** — long-running ingests should push
  progress, not require the agent to poll. Saves tokens, better UX.
- **Elicitation** (newer MCP spec) — for confirm-before-destructive
  operations like `reembed_namespace`. Beats "are you sure" parameters.
- **Cancellation** — agents should be able to cancel a running
  ingestion or rerun.

**f. The "Why MCP matters" framing is dated.** Claude Code in 2026 can
read an OpenAPI spec and call REST APIs. The actual wins for Textral
are sharper:

- **Stable, named tool contract** vs. "the LLM has to figure out which
  4 endpoints to call."
- **Workflow prompts as macros** — `ingest_directory` becomes one tool
  call instead of a 6-step sequence the LLM has to remember.
- **Ecosystem reach** — Cursor, Windsurf, Cline, Continue.dev, Zed,
  etc. all consume MCP; none of them auto-consume an OpenAPI spec the
  way Claude Code does.
- **Auth boundary** — the MCP server holds the key, the agent never
  sees it. Dropping a Textral key into a Claude Code config is much
  safer than handing the key to a model context.

**g. Missing: relationship with the sandbox.** The sandbox is the human
operator UI; MCP is the agent operator interface. They consume the
same backend. There's a design opportunity here — **a "View as MCP
transcript" toggle in the sandbox** would make MCP feel less alien,
and at minimum the same response shapes (`Chunk`, `QueryResponse`,
`QueryEvent`) should flow to both. The post-M3 endpoints we just shipped
for the sandbox (`/v1/chunks/{id}`, `/v1/documents/{id}/chunks`,
`/v1/query-events/{id}/response`, etc.) are *exactly* the read
endpoints the MCP server needs. Lucky us.

**h. Operational tools need rigor.** `textral_retry_dead_letter_job`
should be paired with `textral_list_failing_jobs` so "find what's stuck
and retry it" works as one prompt. `textral_reembed_namespace` is
destructive at scale and needs elicitation, not a parameter.

**i. Resource vs. Tool taxonomy needs more thought.** GPT proposed
`textral://documents/{id}` as a resource. But fetching one document by
ID is what you'd do with a tool (`get_document`). Resources shine when
the LLM is *browsing* — small lists, system prompts, OpenAPI specs
themselves. Shrink the resources surface to: `textral://openapi`,
`textral://profiles` (corpus profile registry), `textral://models`
(provider/model registry). Everything else should be tools.

**j. No deployment / testing story.** No `make mcp-dev` analog. No
cookbook validator equivalent. We need:

- A test harness that exercises the canonical agent flows (ingest →
  query → audit) end-to-end against a live MCP server, mirroring
  `validate-cookbook.ts`.
- A way to run the MCP server in development without spinning up
  Claude Code (something like `tsx packages/mcp/scripts/repl.ts`).

**k. No telemetry / observability story.** Every tool call should
produce something audit-shaped — either a `query_events` row (for
queries) or a new `mcp_tool_calls` row capturing tool name, tenant,
latency, outcome. Otherwise we'll be blind to which tools agents
actually use, where they fail, etc.

---

## 3. Feedback for the actual design

When drafting `TEXTRAL_MCP_DESIGN.md`, the design should make these
decisions explicitly:

### Architecture

- New `packages/mcp` (singular, not `mcp-server` + `mcp-tools` +
  `mcp-prompts` — overkill for the codebase size).
- It depends on `packages/contracts` and re-uses every input schema.
  Tool input validation = `QueryRequest.parse(...)`.
- It uses an existing typed REST client (need to add one —
  `packages/sdk` is fine, ~300 LoC).
- **Two transports out of the gate**: stdio (CLI binary) + embedded
  `/mcp` route in `apps/api`. Same tool table, different bootstrap.
  No HTTP/SSE separate-service unless self-hosters explicitly ask.
- The CF deploy gets `/mcp` for free (Workers MCP). Self-host gets
  `/mcp` mounted in the Hono Node entry. Local devs get
  `npx @textral/mcp` over stdio.

### Tool surface (~12 tools, not 20+)

- `create_namespace`, `list_namespaces`, `get_namespace` (resources
  alone aren't enough — agents call tools)
- `ingest_file` (one call: register + upload + finalize + ingest, with
  optional `wait` flag)
- `list_documents`, `get_document`, `list_chunks`, `get_chunk` — all
  reads already added for the sandbox
- `query` (the workhorse — full retrieval+synthesis, structured output
  is a flag, not a separate tool)
- `list_query_events`, `get_query_event`, `get_query_response` —
  replay/audit
- `register_provider_key`, `list_provider_keys` — BYOK first-run
- `retry_failing_jobs`, `list_failing_jobs` — operational

### Workflow prompts (3 to start, not 4-6)

- `ingest_directory` — local files → namespace
- `compare_retrieval_configs` — the sandbox's Compare page, exposed as
  an MCP prompt
- `evaluate_namespace` — kicks off the eval set

### Resources (small)

- `textral://openapi` — the live spec
- `textral://profiles` — corpus profile registry (so agents know what
  `legal` vs `narrative` does)
- `textral://error-catalog` — the same catalog shipped in `/docs`

### Auth (Phase 1)

- env-driven `TEXTRAL_BASE_URL` + `TEXTRAL_API_KEY` for stdio
- header forwarding `X-Textral-Api-Key` for embedded `/mcp`
- (Phase 2: OAuth device-flow + per-session keys for hosted
  multi-tenant)

### Observability

- A new `mcp_tool_calls` table — minimal: `(id, tenant_id, tool_name,
  args_redacted, latency_ms, outcome, error_code, created_at)`. Same
  redaction policy as `query_events`.
- The sandbox gets an Admin tab to inspect MCP traffic. Free
  observability.

### Testing

- `apps/api/test/mcp-route.test.ts` — exercises the embedded `/mcp`
  route's tool listing + invoke handlers (cf-pool).
- New `tools/mcp-cookbook-validator.ts` — sister to
  `validate-cookbook.ts`, drives the MCP server through agent flows.
- `make mcp-dev` Makefile target.

### Documentation deliverable

- `docs/mcp/QUICKSTART.md` — `claude mcp add textral …` plus the JSON
  snippet form.
- A row in the README's Layout section. A row in QUICKSTART's "common
  to both modes" list.
- Scalar `/docs` gets a `MCP` tag with one synthetic operation
  describing the embedded `/mcp` endpoint, even though it's not a
  regular REST route — so MCP discoverability shows up next to OpenAPI
  discoverability.

---

## Next step

If aligned with the above, draft:

- `docs/mcp/TEXTRAL_MCP_DESIGN.md` (rationale, architecture, tool
  surface, anti-goals, phasing — modeled on
  `docs/v3/TEXTRAL_SANDBOX_FRONTEND_DESIGN.md`)
- `docs/mcp/TEXTRAL_MCP_IMPLEMENTATION.md` (ordered steps with
  acceptance gates, modeled on the sandbox implementation doc)

Push back on any of the above before we commit to it.
