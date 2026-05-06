# Textral MCP — Design

> **Audience:** developer building the MCP server. **Status:** design
> draft; nothing implemented yet. Companion to:
>
> - `docs/mcp/PLANNING_CONVERSATION.md` (the GPT-5.5 conversation that
>   seeded this work — context, not source of truth)
> - `docs/mcp/FEEDBACK.md` (the evaluation of GPT's draft, which this
>   document supersedes)
> - `docs/v3/TEXTRAL_SANDBOX_FRONTEND_DESIGN.md` (the sibling
>   "human operator UI" — same backend, different consumer)

---

## 1. Goal

Make Textral a **first-class capability provider for LLM-driven
agents** by exposing it as an MCP server. Operators running Claude
Code, Cursor, Windsurf, Cline, Continue.dev, or any internal agent
runtime should be able to ask:

> "Ingest the PDFs in `./contracts` into a `vendor-contracts` namespace,
> then identify the top-10 vendor obligations and write
> `./summary.md`."

…and have it executed against a Textral deploy without the operator
writing glue code, without the LLM having to read OpenAPI, and without
either side managing the upload-finalize-ingest state machine by hand.

The MCP layer is an **adapter, not a parallel implementation**. Every
tool call routes through the canonical `apps/api` REST surface so all
of Textral's invariants — tenant scoping, redaction policy, audit
rows, profile resolution, citation validation — apply identically.

The sandbox (built in V3 Phase 2.x) is the **human operator UI**. The
MCP server is the **agent operator interface**. They consume the same
backend.

---

## 2. Why now

Three signals say *now*:

1. **The backend surface stabilized.** V3 Phase 2 + Phase 2.1 shipped
   ingest, query, audit replay (`/v1/query-events/{id}/response`),
   chunk inspection (`/v1/chunks/{id}`, `/v1/documents/{id}/chunks`),
   and document browsing (`/v1/namespaces/{slug}/documents`). The
   reads an agent needs to inspect-and-decide are all there.
2. **`packages/contracts` is the source of truth.** Every input shape
   the API enforces is a Zod schema. The MCP tool input schemas can
   derive directly from those — no second mouth to feed, no drift
   class to fight.
3. **Ecosystem reach.** MCP is the de-facto interop layer for LLM
   tools. Every coding-agent client (Claude Code, Cursor, Windsurf,
   Zed, Cline) consumes MCP. Skipping it means writing per-client
   integrations forever.

---

## 3. Audit of the existing surface

What's already there that the MCP server can lean on:

### 3.1 Schemas — `packages/contracts/src/`

```
contracts/
├── error.ts             ErrorEnvelope, error code enum
├── id.ts                newId() for typed prefixes
├── namespace.ts         Namespace, NamespaceCreate, VectorBackend
├── provider-key.ts      ProviderKey, ProviderKeyCreate, ProviderName
├── ingest.ts            EmbeddingConfig, ChunkingConfig, IngestRequest, Document, IngestionJob, StageAttempt
├── chunk.ts             Chunk, ChunkEmbeddingStatus
├── query.ts             QueryRequest, QueryResponse, QueryEvent, QueryAudit, RerankerAudit, Citation
└── eval.ts              EvalSet, EvalRun, EvalQuestion, EvalScore
```

These are MCP tool input schemas with a haircut. `QueryRequest` is
already exactly what `query` should accept — we just convert Zod →
JSON Schema for the wire.

### 3.2 Routes — `apps/api/src/routes/`

| Surface | Routes the MCP layer wraps |
|---|---|
| Tenancy | `GET /v1/me` |
| Namespaces | full CRUD on `/v1/namespaces` |
| Documents | register / get / list / list-chunks / re-ingest |
| Chunks | `GET /v1/chunks/{id}` |
| Ingestion | `POST /v1/documents/{id}/ingest`, `GET /v1/ingestion-jobs/{id}`, retry |
| Query | `POST /v1/query`, list/get/response on `/v1/query-events` |
| Provider keys | full CRUD + `/test` |
| Eval | `/v1/namespaces/{slug}/eval-sets/...` |
| Admin | DLQ list, retry, enrichment runs |

Everything tenant-scoped. Cross-tenant access already returns 404 by
design, not 403 — the MCP server inherits that posture for free.

### 3.3 Patterns to reuse

- **Cookbook validator** (`apps/api/scripts/validate-cookbook.ts`) —
  drives the live API through canonical patterns. The MCP cookbook
  validator is its sibling.
- **Redaction policy** — `tenants.audit_mode` (`full` / `redacted` /
  `metadata_only`) governs what `query_events.request_config`
  persists. MCP tool calls inherit this. No extra knobs.
- **Background work** — `c.env.bg.spawn(...)` for fire-and-forget. MCP
  progress notifications use the same primitive.
- **The sandbox** — proves that the React-19 + Zod-driven shape works.
  MCP is the same idea, different consumer.

---

## 4. Mental model — REST vs MCP

```
REST API answers:        "How do I call Textral?"
                         Stable, versioned, OpenAPI-described,
                         consumer-agnostic.

MCP answers:             "What capabilities does Textral expose to
                         an autonomous agent?"
                         Stable named tools, schema-validated,
                         orchestrated as multi-step workflows.
```

The two surfaces should always agree on outcomes. They differ on
*shape*: REST is a state machine the developer drives; MCP is a
capability table the agent picks from.

Every MCP tool ultimately resolves to one or more REST calls. The
MCP server is **stateless** — it holds no session, caches nothing,
maintains no shadow store. It is a thin translation layer.

---

## 5. Topology and transport

### 5.1 Two transports out of the gate

| Transport | Use case | Bootstrap |
|---|---|---|
| **stdio** (CLI binary) | Local Claude Code / Cursor / Windsurf | `npx @textral/mcp` with `TEXTRAL_BASE_URL` + `TEXTRAL_API_KEY` env vars |
| **embedded `/mcp` route** | Production deploys (CF + self-host) | Mount inside the Hono app; clients hit `https://api.textral.example.com/mcp` with `X-Textral-Api-Key` header |

Same tool table, same code, different bootstrap. The MCP server is one
package; transport is a one-line choice at startup.

```
┌─ stdio ──────────────────────────────────────────────────────────────┐
│ Claude Code                                                          │
│    │  MCP / JSON-RPC over stdio                                      │
│    ▼                                                                 │
│ npx @textral/mcp        (process holds TEXTRAL_BASE_URL/API_KEY)     │
│    │                                                                 │
│    │  HTTPS REST                                                     │
│    ▼                                                                 │
│ Textral API (CF or self-host)                                        │
└──────────────────────────────────────────────────────────────────────┘

┌─ embedded /mcp ──────────────────────────────────────────────────────┐
│ Cursor / Windsurf / hosted agent                                     │
│    │  MCP / JSON-RPC over HTTP+SSE                                   │
│    ▼                                                                 │
│ Textral API .../mcp     (same tenant_id resolution as /v1/*)         │
│    │  in-process call into the same handlers /v1 uses                │
│    ▼                                                                 │
│ Textral API services + storage (Postgres/D1, Redis, Qdrant, …)       │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 Why both at once

- **stdio is required** for the day-one Claude Code experience. The
  thing operators want is "add this to my IDE."
- **Embedded is required for self-host**. Self-hosters already run
  `make selfhost-up`; we cannot ask them to run a second container or
  configure a separate process. One container, one healthcheck.
- **The same code serves both** because MCP is transport-agnostic by
  design. The `@modelcontextprotocol/sdk` exposes
  `StdioServerTransport` and `StreamableHTTPServerTransport` against
  the same `Server` instance.

### 5.3 What we're not building (yet)

- Standalone HTTP/SSE service deployed separately from the API.
  Self-hosters get embedded `/mcp`; managed users get the CF deploy's
  embedded `/mcp`. A separate service is dead weight until proven
  otherwise.
- A hosted multi-tenant gateway with per-session OAuth. That's Phase
  3 territory if it ever lands.

---

## 6. Architecture

### 6.1 Repository layout

```
packages/contracts          # existing — Zod source of truth (no changes)
packages/sdk                # NEW — typed REST client (~300 LoC)
packages/mcp                # NEW — MCP server: tools, prompts, resources

apps/api                    # existing — gains src/routes/mcp.ts (~80 LoC mount)
```

Three new entities:

#### `packages/sdk`

A typed thin wrapper over `fetch`. One function per public route the
MCP layer calls. Returns Zod-validated response objects. No retry
logic, no caching — just a typed RPC façade.

```ts
import { TextralClient } from '@textral/sdk';

const client = new TextralClient({
  baseUrl: process.env.TEXTRAL_BASE_URL!,
  apiKey: process.env.TEXTRAL_API_KEY!,
});

const ns = await client.namespaces.create({ slug: 'acme', corpus_profile: 'legal' });
const job = await client.documents.ingest(docId, { embedding: { ... } });
const result = await client.query({ namespace: 'acme', query: '…', embedding: { ... }, inference: { ... } });
```

The sandbox should also adopt this client (currently it uses bespoke
`api()` + `apiRaw()`); that's a small follow-up after MCP lands. For
now the MCP package is the only consumer.

#### `packages/mcp`

The MCP server itself. Built on `@modelcontextprotocol/sdk` (TypeScript
SDK from the spec authors). Holds:

```
packages/mcp/
├── src/
│   ├── server.ts          MCP Server instance + capabilities declaration
│   ├── tools/             one file per tool, ~12 tools
│   ├── prompts/           one file per workflow prompt, 3 to start
│   ├── resources/         one file per static resource, 3 to start
│   ├── transport-stdio.ts wraps Server in StdioServerTransport
│   ├── transport-http.ts  exports a Hono handler for the embedded /mcp route
│   └── audit.ts           writes mcp_tool_calls rows
├── bin/
│   └── textral-mcp.ts     stdio entrypoint (the npx package binary)
└── package.json
```

#### `apps/api/src/routes/mcp.ts`

A Hono route mount. ~80 LoC. Imports `httpHandler` from
`packages/mcp` and exposes it at `/mcp`. Auth uses the same
`requireApiKey` middleware as `/v1/*`, so `X-Textral-Api-Key` flows
through the existing tenant-resolution path. Not registered with the
OpenAPI spec (it's a different protocol), but Scalar `/docs` gets a
synthetic `MCP` tag pointing at it.

### 6.2 Why a single `packages/mcp`, not three

GPT proposed `mcp-server` + `mcp-tools` + `mcp-prompts` as separate
packages. For our codebase size — ~12 tools, 3 prompts, 3 resources,
~1200 LoC total — splitting into three packages is overkill and adds
internal-import friction. One package, four directories
(`tools/`, `prompts/`, `resources/`, plus the entrypoints) is the
right granularity.

### 6.3 Tool input schemas — derivation, not duplication

This is load-bearing. Every tool's input schema is derived from
`packages/contracts`:

```ts
import { QueryRequest } from '@textral/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const queryTool = {
  name: 'query',
  description: '…',
  inputSchema: zodToJsonSchema(QueryRequest, { target: 'jsonSchema7' }),
  handler: async (args) => {
    const validated = QueryRequest.parse(args); // server-side re-validate
    return await client.query(validated);
  },
};
```

When `QueryRequest` evolves on the API side, the MCP tool input shape
evolves with it. No second mouth to feed. `zod-to-json-schema` is the
canonical converter (used by `@hono/zod-openapi` already, so we have
it).

Where the MCP tool *needs to differ* from the REST request shape (for
example, `ingest_file` takes a local file path that the API doesn't
know about), we declare a **`McpInput`** schema in
`packages/mcp/src/tools/<tool>.ts` that wraps or extends the REST
shape. The wrapping is explicit and minimal.

---

## 7. Auth model

### 7.1 stdio (local)

```bash
claude mcp add textral \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=tx_live_… \
  -- npx @textral/mcp
```

The MCP process holds the key in env. Claude Code never sees it. The
SDK adds `X-Textral-Api-Key: $TEXTRAL_API_KEY` to every outbound REST
call.

### 7.2 Embedded `/mcp` (production)

Clients hit `https://api.textral.example.com/mcp` with the same
`X-Textral-Api-Key` header they use for `/v1/*`. The MCP server's
HTTP handler reuses `apps/api/src/auth/middleware.ts:requireApiKey`,
so tenant resolution is identical to the REST path.

### 7.3 Phase 2: OAuth device-flow

The MCP spec (2025-11-25) defines authorization endpoints and
device-flow. We adopt this when:

- A managed Textral cloud appears and needs per-user-not-per-tenant
  keys, *or*
- A self-hoster asks for it (likely not before then)

Phase 1 ships header-based auth only. The OAuth flow is documented
as deferred.

### 7.4 What we explicitly do not do

- The MCP server **never** has its own credential store. No "MCP
  password," no key rotation independent of the API.
- The MCP server **never** elevates privileges. If the API key has
  scope `*`, the agent can do everything; if it's narrower, the agent
  is correspondingly narrower.
- The MCP server **never** bypasses redaction. `query_events.request_config`
  is still subject to `tenants.audit_mode`.

---

## 8. Tool surface

Twelve tools, organized by Textral surface. Names use snake_case and
omit the `textral_` prefix — MCP clients namespace by server name
already (`textral.query`, `textral.ingest_file`).

### 8.1 Namespaces

#### `create_namespace`

Creates a new namespace. Auto-creates the upstream backing store
(Qdrant collection or Pinecone reachability check), so the agent
doesn't need to think about it.

| Input | Type | Notes |
|---|---|---|
| `slug` | string | required, unique within tenant |
| `corpus_profile` | string | default `generic` |
| `default_embedding_profile` | string | default `openai-text-embedding-3-large` |
| `vector_backend` | enum | `vectorize` / `qdrant` / `pinecone` — defaults to runtime (cf → vectorize, node → qdrant) |
| `vector_index_name` | string | required when backend is `qdrant` or `pinecone` |

Returns: `Namespace` (the canonical contract type).

REST: `POST /v1/namespaces`.

#### `list_namespaces`

Lists tenant namespaces. No inputs. Returns `Namespace[]`.

REST: `GET /v1/namespaces`.

#### `get_namespace`

Single-namespace fetch. Input: `slug`. Returns `Namespace` or 404.

REST: `GET /v1/namespaces/{slug}`.

### 8.2 Documents and ingest

#### `ingest_file` *(the headline tool)*

This is where the most leverage lives. Replaces the four-step REST
chain (register → upload → finalize → ingest) with one tool that
does it all.

| Input | Type | Notes |
|---|---|---|
| `namespace` | string | namespace slug |
| `file_path` *or* `bytes` | string \| Uint8Array | one or the other; `file_path` reads from the agent's filesystem (Claude Code resolves it) |
| `title` | string | optional; defaults to filename |
| `doc_type` | string | optional; defaults to `passage` |
| `embedding` | EmbeddingConfig | provider/model/dims/key_ref |
| `chunking` | ChunkingConfig | profile/target_tokens/overlap_tokens |
| `mode` | enum | `full` / `embed_only` / `enrichment_only` |
| `wait` | boolean | when true, block until the job completes; emits progress notifications |
| `wait_timeout_ms` | number | default 5min |

Returns: `{ document: Document, version_id: string, job_id: string, job?: IngestionJob }` — `job` populated only when `wait=true`.

Internally:

1. `POST /v1/namespaces/{slug}/documents` (register)
2. `POST /v1/documents/{id}/uploads` (mint upload)
3. `PUT` bytes (worker-proxied path)
4. `POST /v1/documents/{id}/uploads/{upload_id}/finalize`
5. `POST /v1/documents/{id}/ingest`
6. If `wait`: poll `GET /v1/ingestion-jobs/{job_id}` every 1.5s, emit
   `progressNotification` per stage transition, return when status is
   `completed` or `failed`.

The `wait=true` path uses MCP's progress notifications, so the agent
can see "fetched ✓ → normalized ✓ → chunked ✓ → embedding…" without
polling.

#### `list_documents`

Lists documents in a namespace, paginated.

| Input | Type | Notes |
|---|---|---|
| `namespace` | string | slug |
| `limit` | number | 1..200, default 50 |
| `cursor` | string | from previous page |

Returns: `{ data: Document[], next_cursor: string \| null }`.

REST: `GET /v1/namespaces/{slug}/documents`.

#### `get_document`

Single-document fetch. Input: `id`. Returns `Document` or 404.

REST: `GET /v1/documents/{id}`.

#### `list_chunks`

Lists chunks in a document, paginated.

| Input | Type |
|---|---|
| `document_id` | string |
| `limit` | number (1..500, default 100) |
| `cursor` | string |
| `artifact_type` | string (optional filter) |
| `version_id` | string (optional; defaults to current) |

Returns: `{ data: Chunk[], next_cursor: string \| null }`.

REST: `GET /v1/documents/{id}/chunks`.

#### `get_chunk`

Single-chunk fetch with full text + metadata. Input: `id`. Returns
`Chunk` or 404.

REST: `GET /v1/chunks/{id}`.

### 8.3 Query

#### `query` *(the workhorse)*

Full retrieval + synthesis, citation-grounded. Mirrors the REST
`POST /v1/query` shape one-to-one — the input schema is derived from
`QueryRequest`.

`output.mode = 'structured'` is a flag, not a separate tool. A single
`query` tool handles both text and structured output; the response
discriminates via `answer.mode`.

Returns: `QueryResponse` (full audit + citations + degradation level).

REST: `POST /v1/query`.

#### `list_query_events`

Recent queries for the tenant. Same shape as the sandbox's QueryHistory.

| Input | Type |
|---|---|
| `limit` | 1..200, default 50 |
| `cursor` | string |
| `namespace_slug` | string (filter) |
| `status` | enum (filter) |

Returns: `{ data: QueryEvent[], next_cursor: string \| null }`.

REST: `GET /v1/query-events`.

#### `get_query_event`

Single audit row.

REST: `GET /v1/query-events/{id}`.

#### `get_query_response`

The full mirrored `QueryResponse` for a historical run — the same
endpoint that powers the sandbox's replay flow.

Returns the original answer/citations/audit, or surfaces the 410
`QUERY_RESPONSE_UNAVAILABLE` reason as a structured error.

REST: `GET /v1/query-events/{id}/response`.

### 8.4 Provider keys (BYOK)

#### `register_provider_key`

| Input | Type |
|---|---|
| `provider` | enum (`openai` / `anthropic` / `cohere` / `voyage` / `workers_ai`) |
| `label` | string |
| `key` | string (raw secret — never re-emitted) |

Returns: `ProviderKey` metadata only (no `key`).

REST: `POST /v1/provider-keys`.

#### `list_provider_keys`

Returns: `{ data: ProviderKey[] }`. No inputs.

REST: `GET /v1/provider-keys`.

### 8.5 Operations

#### `list_failing_jobs`

DLQ inspector — mirrors the sandbox's Admin tab.

| Input | Type |
|---|---|
| `limit` | 1..200 |
| `cursor` | string |

Returns: `{ items: IngestionJob[], next_cursor: string \| null }`.

REST: `GET /v1/admin/ingestion-jobs?dead_lettered=1`.

#### `retry_failing_job`

| Input | Type |
|---|---|
| `job_id` | string |
| `wait` | boolean |

When `wait=true`, blocks with progress notifications until the retry
either re-completes or re-fails. Otherwise returns immediately with
the new job state.

REST: `POST /v1/ingestion-jobs/{id}/retry`.

### 8.6 Tools we deliberately do not ship in Phase 1

| Tool | Reason for deferral |
|---|---|
| `delete_namespace` | Soft-deletes the entire namespace. High blast radius. Phase 2 with elicitation confirmation. |
| `delete_document` | Same — adds in Phase 2 with confirmation. |
| `revoke_provider_key` | Same — destructive and easy to do in the sandbox. |
| `reembed_namespace` | Re-embeds every chunk. Bulk-destructive. Phase 2 with elicitation + dry-run flag. |
| `run_eval_set` | Eval contract is real but the sandbox doesn't expose it yet. Add when sandbox surfaces it. |
| `update_namespace` (PATCH) | Available via REST; agents rarely need to mutate namespace defaults. Add on demand. |

---

## 9. Workflow prompts

MCP prompts are reusable, parameterized message templates. They're
not tools — they don't *do* anything. They give the agent a curated
starting point for multi-step workflows. Three to start.

### 9.1 `ingest_directory`

Bulk ingest local files into a namespace.

**Arguments:**

| Name | Type | Notes |
|---|---|---|
| `directory` | string | absolute path |
| `namespace` | string | slug — created if missing |
| `corpus_profile` | string | optional |
| `embedding_profile` | string | optional |

**Generated message** (rendered to the client's LLM):

```
You are ingesting files from {directory} into namespace {namespace}
on a Textral deploy.

Steps:
1. Use the filesystem MCP server (or Claude Code's native fs tools)
   to list every file under {directory}. Filter to supported types
   (md/txt/pdf).
2. If {namespace} doesn't exist, call textral.create_namespace.
3. For each file: call textral.ingest_file with wait=false; collect
   the job_ids.
4. Poll each job_id (or rely on textral.ingest_file with wait=true if
   the corpus is small).
5. Once all jobs are completed, return a markdown summary: file →
   chunk count → embedding cost.

Halt and report any failures rather than retrying blindly.
```

This prompt encapsulates the orchestration the LLM would otherwise
have to invent every time.

### 9.2 `compare_retrieval_configs`

The sandbox's Compare page, exposed as a prompt. The agent runs the
same query against two retrieval configurations and produces a
markdown diff.

**Arguments:**

| Name | Type |
|---|---|
| `namespace` | string |
| `query` | string |
| `config_a` | object (RetrievalConfig) |
| `config_b` | object (RetrievalConfig) |

The generated message walks the agent through `query` ×2 → diff → write
report.

### 9.3 `evaluate_namespace`

Runs an eval set over a namespace and synthesizes a quality report.

**Arguments:**

| Name | Type |
|---|---|
| `namespace` | string |
| `eval_set` | string (slug or id) |

Phase 1: this prompt is a placeholder until eval tooling lands in the
sandbox. We declare it now to set expectations; the underlying tool
(`run_eval_set`) ships in Phase 2.

---

## 10. Resources

Resources are read-only contextual surfaces the agent can fetch when
it needs *system knowledge*, not *tenant data*. Tenant data is what
tools are for. Three resources to start.

### 10.1 `textral://openapi`

Returns the live `/openapi.json` document. The agent can discover
exotic endpoints we haven't wrapped as tools.

### 10.2 `textral://profiles`

Returns the corpus profile registry — the same data
`packages/corpus-profiles` exposes. Lets the agent answer "what does
the `legal` profile do?" without an extra REST call.

### 10.3 `textral://error-catalog`

The error catalog from `apps/api/src/openapi/error-catalog.ts`. The
agent uses this to interpret error codes ("`PROVIDER_QUOTA_EXHAUSTED`
means rotate the key, not retry").

### 10.4 What we deliberately do not expose as resources

- `textral://namespaces` and `textral://documents/{id}` — these are
  *tenant data*, not *system knowledge*. They belong as tools, not
  resources, because (a) they need parameters and (b) they should
  produce audit rows.

---

## 11. Anti-goals (load-bearing)

The MCP layer **must not**:

- Embed vectors, chunk text, run retrieval, or call providers
  directly.
- Maintain its own data store, cache, or session state.
- Implement authorization rules (the API enforces tenant + scope; MCP
  inherits).
- Bypass `tenants.audit_mode` redaction.
- Bypass `query_events` audit row creation.
- Hold credentials beyond what's needed to call the REST API.
- Access the local filesystem directly (Claude Code or a separate
  filesystem MCP server does that; `ingest_file` accepts bytes or a
  path the agent supplies).
- Expose any operation that doesn't have a corresponding REST surface.
  If something is "MCP-only," it doesn't exist.

If a future feature can't be built without breaking one of these,
that's a signal to add the feature to the REST surface first.

---

## 12. Observability

### 12.1 New table: `mcp_tool_calls`

```sql
CREATE TABLE mcp_tool_calls (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    api_key_id      TEXT,
    tool_name       TEXT NOT NULL,
    transport       TEXT NOT NULL,       -- 'stdio' | 'http'
    args_redacted   TEXT NOT NULL,       -- JSON, redaction-aware
    rest_call_count INTEGER NOT NULL,    -- how many REST calls the tool fanned out to
    latency_ms      INTEGER NOT NULL,
    outcome         TEXT NOT NULL,       -- 'ok' | 'tool_error' | 'rest_error' | 'cancelled'
    error_code      TEXT,
    error_message   TEXT,
    created_at      INTEGER NOT NULL
);
CREATE INDEX idx_mcp_calls_tenant ON mcp_tool_calls(tenant_id, created_at DESC);
```

Same redaction policy as `query_events`. Same write-path
(`audit/mcp.ts`) so future redaction tweaks apply uniformly.

### 12.2 Sandbox surfaces

The sandbox gets a new **MCP** tab in the Admin page (or its own page
if it grows). Lists recent tool calls, latency, outcome. Click a row
→ see the resolved REST calls.

This is free observability: humans use the sandbox to verify what
agents are doing on their tenant.

### 12.3 Progress notifications

Every long-running tool (`ingest_file` with `wait=true`,
`retry_failing_job` with `wait=true`) emits `progressNotification`
events to the MCP client at every state transition. The client (Claude
Code) renders them as a live progress bar without an extra polling
turn.

### 12.4 Cancellation

MCP supports `notifications/cancelled`. Long-running tools must check
the cancellation token between polls and abort. The corresponding REST
operation isn't cancelled (the ingestion pipeline finishes whether the
agent waits or not), but the tool returns `outcome=cancelled` and
stops emitting progress events.

---

## 13. Phasing

### Phase 1 — MVP (~1 week)

**Goal:** an operator can `claude mcp add textral …`, ingest a file,
query it, inspect the audit, all without leaving Claude Code.

- `packages/sdk` typed REST client (~300 LoC).
- `packages/mcp` server scaffold + stdio transport.
- 12 tools (§8.1–8.5 — the full ship list).
- 3 prompts (§9).
- 3 resources (§10).
- `mcp_tool_calls` table + audit write path.
- `apps/api/src/routes/mcp.ts` mount + `requireApiKey` reuse for
  embedded `/mcp`.
- `make mcp-dev` Makefile target.
- `tools/mcp-cookbook-validator.ts` — drives the MCP server through
  agent flows, mirrors `validate-cookbook.ts`.
- `apps/api/test/mcp-route.test.ts` — embedded `/mcp` tool listing +
  invocation tests, cf-pool.

**Ship gate:** the cookbook validator passes against both stdio and
embedded transports, on both runtimes (CF + self-host).

### Phase 2 — Production polish (~3 days)

- Destructive tools with elicitation: `delete_namespace`,
  `delete_document`, `revoke_provider_key`, `reembed_namespace`.
- `run_eval_set` tool once eval tooling lands in the sandbox.
- Sandbox **MCP** tab for `mcp_tool_calls` inspection.
- Scalar `/docs` synthetic `MCP` tag pointing at the embedded route.
- `npm publish @textral/mcp` — first public release.

### Phase 3 — Hosted multi-tenant (deferred)

- OAuth device-flow per the MCP 2025-11-25 spec.
- Per-session keys vs. tenant-bound keys.
- Hosted MCP gateway (separate service) only if a customer asks.

---

## 14. Documentation deliverables

| Doc | Purpose |
|---|---|
| `docs/mcp/QUICKSTART.md` | `claude mcp add textral …` + JSON snippet for other clients |
| `README.md` | New layout row pointing at `packages/mcp` |
| `docs/QUICKSTART.md` | New row in "What's identical between modes" — same MCP surface in both |
| `docs/SELF_HOSTING.md` | New §2.6 — embedded `/mcp` for self-hosters |
| `docs/development/v3/TEXTRAL_SANDBOX_FRONTEND_IMPLEMENTATION.md` | "Delivered post-M3" extension noting the sandbox MCP tab |
| Scalar `/docs` | New `MCP` tag with one synthetic operation, plus a tag description |

---

## 15. Open questions

1. **Embedded `/mcp` on Cloudflare**: the `@modelcontextprotocol/sdk`
   has Workers support, but Workers `Streamable HTTP Transport`
   semantics around long-lived SSE need verification. Worst case we
   ship stdio-only on day 1 of CF and ship embedded after a verification
   spike. **Tentative decision:** ship embedded on self-host first
   (Node runtime, well-trodden path); CF gets it once verified.
2. **Tool input strict-mode**: do we allow agents to pass extra fields
   that the API will ignore? Zod's default is `passthrough`. Lean
   toward `strict()` so the LLM can't drift into hallucinated fields
   silently. Easy to relax later.
3. **`ingest_file` `bytes` vs `file_path`**: stdio MCP has no native
   "file path" concept. The agent (Claude Code) reads bytes via its
   own filesystem tool, then passes them to `ingest_file`. If we
   accept `file_path` on the MCP server side, only the embedded
   transport can reasonably resolve it (via a server-side filesystem
   read), which is a security minefield. **Tentative decision:**
   accept only `bytes` (base64 over JSON-RPC) at the protocol layer.
   The `ingest_directory` prompt explains the chain to the agent.
4. **MCP tool `description` length**: longer descriptions improve
   agent reasoning but inflate the prompt context. Cap at ~200 chars
   per tool, with rich examples in the prompts not the tool descs.
5. **Redaction in `mcp_tool_calls.args_redacted`**: same policy as
   `query_events.request_config`, or stricter? **Tentative:** same
   policy. Operators expect one redaction knob, not two.

---

## 16. What this is NOT

- A replacement for the REST API. The REST surface stays canonical.
- A pure wrapper over the OpenAPI spec. We pick a curated tool surface
  with workflow-shaped names; we don't auto-generate one tool per
  endpoint.
- An auth boundary. Tenant scoping, scopes, redaction, and audit all
  live in the API. MCP inherits.
- A hosted multi-tenant gateway. Phase 3 territory.
- A second SDK. `packages/sdk` is the typed REST client; the MCP
  server is the agent-facing adapter on top of it. One client, two
  consumers (sandbox eventually + MCP today).

---

## 17. References

- MCP specification (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25
- `@modelcontextprotocol/sdk` (TypeScript): https://github.com/modelcontextprotocol/typescript-sdk
- Sandbox design (sibling project, same backend):
  `docs/v3/TEXTRAL_SANDBOX_FRONTEND_DESIGN.md`
- Sandbox implementation (the steps-doc style we'll mirror):
  `docs/development/v3/TEXTRAL_SANDBOX_FRONTEND_IMPLEMENTATION.md`
- The conversation that seeded this: `docs/mcp/PLANNING_CONVERSATION.md`
- The evaluation that informed it: `docs/mcp/FEEDBACK.md`
