# Textral MCP — Implementation Steps

> Companion to `docs/mcp/TEXTRAL_MCP_DESIGN.md`. Concrete, ordered
> steps. A dev follows this end-to-end and at the close has shipped
> Phase 1 of the MCP server: `packages/sdk` + `packages/mcp`, an
> embedded `/mcp` route in `apps/api` (Node runtime), the stdio CLI,
> 16 tools, 3 prompts, 3 resources, the `mcp_tool_calls` audit table,
> the cookbook validator, CI integration, and operator docs.
>
> **No open questions.** Where the design doc left a choice tentative,
> this document commits to it.
>
> ## Open-question decisions (locked)
>
> | # | Decision | Source |
> |---|---|---|
> | 1 | Embedded `/mcp` ships first on the **Node runtime** (self-host). CF runtime gets it post-MVP after a verification spike against Workers `Streamable HTTP Transport`. | Design §15.1 |
> | 2 | Tool input schemas use Zod **`.strict()`** — extra fields are rejected, not silently passed. | Design §15.2 |
> | 3 | `ingest_file` accepts `bytes` (base64) only, not `file_path`. The MCP server never reads the local filesystem. | Design §15.3 |
> | 4 | Tool descriptions cap at **200 characters**. Rich examples live in workflow prompts, not tool descs. | Design §15.4 |
> | 5 | `mcp_tool_calls.args_redacted` uses the **same redaction policy** as `query_events.request_config` (`tenants.audit_mode`). | Design §15.5 |
>
> ## Status
>
> Not started. Steps below describe the as-shipped target.
>
> The 19 steps split into three milestones:
>
> - **M1 — Server + tools + audit (Steps 1–13)**: ~5 days. Stdio CLI
>   + every tool / prompt / resource + audit table + sandbox tab.
>   The MVP cookbook flow works end-to-end.
> - **M2 — Embedded route + CI + tests (Steps 14–17)**: ~2 days.
>   `/mcp` mounted in `apps/api`, full test coverage, CI integration.
> - **M3 — Documentation + ship (Steps 18–19)**: ~1 day. Quickstart,
>   `npm publish` rehearsal, close-out verification.

---

## At completion, you will have

- `packages/sdk/` — a typed Textral REST client built on `fetch`
  + `packages/contracts` Zod schemas. ~300 LoC. Both the MCP server
  and (eventually) the sandbox consume it.
- `packages/mcp/` — the MCP server. Single package, four directories
  (`tools/`, `prompts/`, `resources/`, plus entrypoints). Built on
  `@modelcontextprotocol/sdk`. Tool input schemas derived from
  `packages/contracts` via `zod-to-json-schema`.
- `bin/textral-mcp` — the stdio CLI entrypoint published to npm as
  `@textral/mcp`. Operators run `npx @textral/mcp` from a Claude
  Code config and the server boots.
- An embedded `/mcp` route on the Node runtime of `apps/api`,
  mounted under the same `requireApiKey` middleware as `/v1/*`. CF
  runtime gets it post-MVP.
- 16 tools across namespaces / documents / ingest / query /
  provider keys / operations.
- 3 workflow prompts: `ingest_directory`, `compare_retrieval_configs`,
  `evaluate_namespace`.
- 3 resources: `textral://openapi`, `textral://profiles`,
  `textral://error-catalog`.
- A new `mcp_tool_calls` audit table (migrations 0008 in both
  SQLite and Postgres flavors). Every tool invocation writes a row.
- An MCP cookbook validator (`tools/mcp-cookbook-validator.ts`)
  driving canonical agent flows through both stdio and embedded
  transports. Sister to `validate-cookbook.ts`.
- A new sandbox **MCP** tab on the Admin page surfacing recent
  `mcp_tool_calls` rows.
- CI coverage: typecheck + build + test against `packages/mcp` in
  the Node lane. Failure is a release blocker.
- Operator docs: `docs/mcp/QUICKSTART.md`, README layout row, the
  `docs/QUICKSTART.md` chooser, a `docs/SELF_HOSTING.md` §2.6
  walkthrough, and a synthetic `MCP` tag in Scalar `/docs`.

---

## What this implementation specifically does NOT do

- **No CF embedded `/mcp`.** Phase 1 ships embedded only on the Node
  runtime. CF gets it after a verification spike against Workers
  `Streamable HTTP Transport`. Stdio works against either runtime.
- **No destructive tools.** `delete_namespace`, `delete_document`,
  `revoke_provider_key`, `reembed_namespace` are Phase 2 with
  elicitation. Phase 1 is read-or-create only.
- **No eval tooling.** `evaluate_namespace` ships as a placeholder
  prompt with an explanatory message; the underlying `run_eval_set`
  tool lands in Phase 2 alongside sandbox eval support.
- **No OAuth / device-flow.** Auth is env-driven (stdio) or
  `X-Textral-Api-Key` header forwarding (embedded). Phase 3.
- **No filesystem reads on the MCP server.** `ingest_file` accepts
  `bytes` only. The agent (Claude Code, etc.) reads files via its
  own filesystem tool and passes bytes through.
- **No internal-only tools.** Anything that doesn't have a
  corresponding REST surface doesn't get a tool — including any
  cross-tool orchestration that would benefit from server-side
  state. Workflow prompts handle multi-step flows by instructing
  the agent.

---

## Prerequisites

- Node 24, pnpm 10 (already in workspace).
- A running Textral deploy to point the MCP server at — `make
  selfhost-up` is the default development path.
- A Textral API key minted via `make selfhost-seed-cookbook` (or
  any tenant-scoped key with `*` scope).
- Claude Code or another MCP client for end-to-end smoke tests
  during M1 close-out.

---

## Locked-in technology choices

| Layer | Choice |
|---|---|
| MCP SDK | `@modelcontextprotocol/sdk` (TypeScript, latest stable) |
| JSON Schema generation | `zod-to-json-schema` (canonical Zod → JSON Schema) |
| HTTP client (in `packages/sdk`) | Native `fetch` (no axios, no undici) |
| Test runner | Vitest (matches the workspace) |
| Bundler for the CLI | esbuild via existing `apps/api` build scripts pattern |
| Node version | 24 (matches workspace) |
| Output format | ESM only (matches the rest of the workspace) |
| Tool input strictness | Zod `.strict()` — extra fields rejected |

---

## Naming and locations

- `packages/sdk/` — package name `@textral/sdk`. Default export
  `TextralClient`.
- `packages/mcp/` — package name `@textral/mcp`. CLI binary
  `textral-mcp`. Default export the assembled `Server` instance.
- `apps/api/src/routes/mcp.ts` — embedded route mount. ~80 LoC.
- `apps/api/src/audit/mcp.ts` — `mcp_tool_calls` writer. Sister to
  `audit/query-events.ts`.
- `apps/api/migrations/{sqlite,postgres}/0008_mcp_tool_calls.sql` —
  the new table.
- `apps/sandbox/src/pages/Admin.tsx` — gains a third tab, **MCP**.
- `tools/mcp-cookbook-validator.ts` — sister to
  `validate-cookbook.ts`.

---

# M1 — Server + tools + audit

## Step 1 — Scaffold `packages/sdk`

The MCP server depends on a typed REST client. We extract one now;
the sandbox can adopt it later.

### 1.1 `packages/sdk/package.json`

```json
{
  "name": "@textral/sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "dependencies": {
    "@textral/contracts": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

### 1.2 `packages/sdk/src/client.ts`

```ts
import {
  Namespace, NamespaceCreate, Document, IngestionJob,
  QueryRequest, QueryResponse, QueryEvent,
  ProviderKey, ProviderKeyCreate, Chunk,
  UploadResponse, FinalizeResponse,
  IngestRequest, type ProviderName,
} from '@textral/contracts';

export interface TextralClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export class TextralClient {
  // namespaces
  namespaces = {
    list: () => this._call<{ data: Namespace[] }>('GET', '/v1/namespaces'),
    create: (body: NamespaceCreate) => this._call<Namespace>('POST', '/v1/namespaces', body),
    get: (slug: string) => this._call<Namespace>('GET', `/v1/namespaces/${slug}`),
    listDocuments: (slug: string, q: { limit?: number; cursor?: string } = {}) =>
      this._call<{ data: Document[]; next_cursor: string | null }>(
        'GET', `/v1/namespaces/${slug}/documents${qs(q)}`,
      ),
  };

  // documents
  documents = {
    register: (slug: string, body: { title?: string; doc_type?: string }) =>
      this._call<Document>('POST', `/v1/namespaces/${slug}/documents`, body),
    get: (id: string) => this._call<Document>('GET', `/v1/documents/${id}`),
    createUpload: (id: string, body: { content_type: string; size_bytes: number }) =>
      this._call<UploadResponse>('POST', `/v1/documents/${id}/uploads`, body),
    putUploadBytes: (uploadUrl: string, body: Uint8Array, contentType: string) =>
      this._raw('PUT', uploadUrl, body, contentType),
    finalize: (id: string, uploadId: string) =>
      this._call<FinalizeResponse>('POST', `/v1/documents/${id}/uploads/${uploadId}/finalize`, {}),
    ingest: (id: string, body: IngestRequest) =>
      this._call<{ job_id: string; status: string; version_index_id: string }>(
        'POST', `/v1/documents/${id}/ingest`, body,
      ),
    listChunks: (id: string, q: { limit?: number; cursor?: string; artifact_type?: string; version_id?: string } = {}) =>
      this._call<{ data: Chunk[]; next_cursor: string | null }>(
        'GET', `/v1/documents/${id}/chunks${qs(q)}`,
      ),
  };

  chunks = {
    get: (id: string) => this._call<Chunk>('GET', `/v1/chunks/${id}`),
  };

  ingestionJobs = {
    get: (id: string) => this._call<IngestionJob>('GET', `/v1/ingestion-jobs/${id}`),
    retry: (id: string) => this._call<void>('POST', `/v1/ingestion-jobs/${id}/retry`),
  };

  query = (body: QueryRequest) => this._call<QueryResponse>('POST', '/v1/query', body);

  queryEvents = {
    list: (q: { limit?: number; cursor?: string; namespace_slug?: string; status?: string } = {}) =>
      this._call<{ data: QueryEvent[]; next_cursor: string | null }>('GET', `/v1/query-events${qs(q)}`),
    get: (id: string) => this._call<QueryEvent>('GET', `/v1/query-events/${id}`),
    getResponse: (id: string) => this._call<QueryResponse>('GET', `/v1/query-events/${id}/response`),
  };

  providerKeys = {
    list: () => this._call<{ data: ProviderKey[] }>('GET', '/v1/provider-keys'),
    create: (body: ProviderKeyCreate) => this._call<ProviderKey>('POST', '/v1/provider-keys', body),
    test: (id: string) => this._call<{ ok: boolean; error_code?: string; error_message?: string }>(
      'POST', `/v1/provider-keys/${id}/test`,
    ),
  };

  admin = {
    listFailingJobs: (q: { limit?: number; cursor?: string } = {}) =>
      this._call<{ items: IngestionJob[]; next_cursor: string | null }>(
        'GET', `/v1/admin/ingestion-jobs?dead_lettered=1${qs(q, '&')}`,
      ),
  };

  me = () => this._call<{ tenant: { id: string; display_name: string }; api_key_id: string }>(
    'GET', '/v1/me',
  );

  // ——— core ———
  constructor(private opts: TextralClientOptions) {}

  private async _call<T>(method: string, path: string, body?: unknown): Promise<T> { /* ... */ }
  private async _raw(method: string, url: string, body: BodyInit, contentType: string): Promise<Response> { /* ... */ }
}
```

`_call` is ~40 LoC: builds headers (`X-Textral-Api-Key`, `content-type`),
serializes body, parses JSON, throws `TextralApiError` on non-2xx.
Mirrors `apps/sandbox/src/api/client.ts`.

`qs(obj, sep='?')` is a 5-line helper that serializes a query object,
omitting undefined values.

### 1.3 `packages/sdk/src/index.ts`

```ts
export { TextralClient, type TextralClientOptions } from './client.js';
export { TextralApiError } from './errors.js';
```

### Acceptance — Step 1

- [ ] `pnpm --filter @textral/sdk typecheck` clean.
- [ ] `pnpm --filter @textral/sdk build` produces `dist/`.
- [ ] A smoke test (`packages/sdk/test/client.test.ts`) constructs a
      client against a mock fetch and verifies headers + body
      shape on a `/v1/namespaces` GET and POST.

---

## Step 2 — Scaffold `packages/mcp`

### 2.1 `packages/mcp/package.json`

```json
{
  "name": "@textral/mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "bin": { "textral-mcp": "./dist/bin/textral-mcp.js" },
  "exports": {
    ".": "./dist/index.js",
    "./http": "./dist/transport-http.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.20.0",
    "@textral/contracts": "workspace:*",
    "@textral/sdk": "workspace:*",
    "zod": "^3.23.8",
    "zod-to-json-schema": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

### 2.2 `packages/mcp/src/server.ts`

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { TextralClient } from '@textral/sdk';
import { allTools } from './tools/index.js';
import { allPrompts } from './prompts/index.js';
import { allResources } from './resources/index.js';
import { wrapWithAudit, type AuditWriter } from './audit.js';

export interface ServerContext {
  client: TextralClient;
  audit: AuditWriter;
  transport: 'stdio' | 'http';
}

export function createServer(ctx: ServerContext): Server {
  const server = new Server(
    { name: 'textral', version: '0.0.0' },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = allTools.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
    return await wrapWithAudit(ctx, tool, req.params.arguments ?? {});
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: allPrompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = allPrompts.find((p) => p.name === req.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${req.params.name}`);
    return prompt.render(req.params.arguments ?? {});
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: allResources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const resource = allResources.find((r) => r.uri === req.params.uri);
    if (!resource) throw new Error(`Unknown resource: ${req.params.uri}`);
    return await resource.read(ctx);
  });

  return server;
}
```

### 2.3 `packages/mcp/src/audit.ts`

`AuditWriter` interface — when running stdio, writes via the SDK
(`POST /v1/_internal/mcp_tool_calls` — Step 13 adds the route).
When running embedded, writes directly via `c.env.db`.

```ts
export interface AuditWriter {
  record(event: {
    tool_name: string;
    transport: 'stdio' | 'http';
    args_redacted: unknown;
    rest_call_count: number;
    latency_ms: number;
    outcome: 'ok' | 'tool_error' | 'rest_error' | 'cancelled';
    error_code?: string;
    error_message?: string;
  }): Promise<void>;
}

export async function wrapWithAudit(
  ctx: ServerContext, tool: ToolDef, args: unknown,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const start = Date.now();
  const counter = { rest: 0 };
  const tracedClient = traceFetchCount(ctx.client, counter);
  let outcome: 'ok' | 'tool_error' | 'rest_error' = 'ok';
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  try {
    const validated = tool.inputSchemaZod.parse(args);
    const result = await tool.handler({ args: validated, client: tracedClient });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    outcome = e instanceof TextralApiError ? 'rest_error' : 'tool_error';
    errorCode = e instanceof TextralApiError ? e.code : 'INTERNAL';
    errorMessage = (e as Error).message;
    throw e;
  } finally {
    await ctx.audit.record({
      tool_name: tool.name,
      transport: ctx.transport,
      args_redacted: redactToolArgs(tool.name, args),
      rest_call_count: counter.rest,
      latency_ms: Date.now() - start,
      outcome,
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(errorMessage ? { error_message: errorMessage } : {}),
    });
  }
}
```

`redactToolArgs(toolName, args)` mirrors
`redactRequestConfig` from `apps/api/src/audit/query-events.ts` —
same `tenants.audit_mode` policy. Step 13 wires this through.

### 2.4 `packages/mcp/src/transport-stdio.ts`

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TextralClient } from '@textral/sdk';
import { createServer } from './server.js';
import { ApiAuditWriter } from './audit.js';

export async function startStdio(opts: { baseUrl: string; apiKey: string }): Promise<void> {
  const client = new TextralClient({ baseUrl: opts.baseUrl, apiKey: opts.apiKey });
  const audit = new ApiAuditWriter(client);
  const server = createServer({ client, audit, transport: 'stdio' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

### 2.5 `packages/mcp/bin/textral-mcp.ts`

```ts
#!/usr/bin/env node
import { startStdio } from '../src/transport-stdio.js';

const baseUrl = process.env.TEXTRAL_BASE_URL;
const apiKey = process.env.TEXTRAL_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('TEXTRAL_BASE_URL and TEXTRAL_API_KEY must be set.');
  process.exit(2);
}
await startStdio({ baseUrl, apiKey });
```

### 2.6 `packages/mcp/src/index.ts`

```ts
export { createServer, type ServerContext } from './server.js';
export { startStdio } from './transport-stdio.js';
```

### Acceptance — Step 2

- [ ] `pnpm --filter @textral/mcp typecheck` clean (with empty
      tools/prompts/resources arrays).
- [ ] `pnpm --filter @textral/mcp build` produces `dist/` and a
      `bin/textral-mcp.js` shebanged file.
- [ ] `node packages/mcp/dist/bin/textral-mcp.js` exits 2 with the
      env-vars-required message when run without env.

---

## Step 3 — `mcp_tool_calls` migrations

### 3.1 `apps/api/migrations/sqlite/0008_mcp_tool_calls.sql`

```sql
CREATE TABLE mcp_tool_calls (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    api_key_id      TEXT,
    tool_name       TEXT NOT NULL,
    transport       TEXT NOT NULL,        -- 'stdio' | 'http'
    args_redacted   TEXT NOT NULL,        -- JSON
    rest_call_count INTEGER NOT NULL,
    latency_ms      INTEGER NOT NULL,
    outcome         TEXT NOT NULL,        -- 'ok' | 'tool_error' | 'rest_error' | 'cancelled'
    error_code      TEXT,
    error_message   TEXT,
    created_at      INTEGER NOT NULL
);
CREATE INDEX idx_mcp_calls_tenant_created ON mcp_tool_calls(tenant_id, created_at DESC);
CREATE INDEX idx_mcp_calls_tool ON mcp_tool_calls(tenant_id, tool_name, created_at DESC);
```

### 3.2 `apps/api/migrations/postgres/0008_mcp_tool_calls.sql`

Same as SQLite, with `BIGINT` for the timestamp columns and
`JSONB` for `args_redacted`.

### 3.3 Apply on both runtimes

- CF: append to wrangler migrations or run via the existing migrate
  script.
- Self-host: `make migrate-postgres-selfhost` picks it up
  automatically.

### Acceptance — Step 3

- [ ] Migration runs cleanly on both SQLite and Postgres.
- [ ] `SELECT * FROM mcp_tool_calls` succeeds with empty result.

---

## Step 4 — Tool input schema derivation

### 4.1 `packages/mcp/src/zod-to-input-schema.ts`

```ts
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export function toInputSchema(schema: z.ZodTypeAny): unknown {
  // strict() rejects unknown fields — locked-in decision.
  const strict = schema instanceof z.ZodObject ? schema.strict() : schema;
  const json = zodToJsonSchema(strict, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  });
  // Strip $schema, definitions wrapper that confuse some MCP clients.
  delete (json as Record<string, unknown>).$schema;
  return json;
}
```

### 4.2 Tool registration shape — `packages/mcp/src/tools/types.ts`

```ts
import { z } from 'zod';
import type { TextralClient } from '@textral/sdk';

export interface ToolDef<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;          // ≤200 chars
  inputSchemaZod: z.ZodType<TInput>;
  inputSchema: unknown;         // JSON Schema, derived from inputSchemaZod
  handler: (ctx: { args: TInput; client: TextralClient }) => Promise<TOutput>;
}

export function defineTool<TInput, TOutput>(
  args: Omit<ToolDef<TInput, TOutput>, 'inputSchema'>,
): ToolDef<TInput, TOutput> {
  return { ...args, inputSchema: toInputSchema(args.inputSchemaZod as z.ZodTypeAny) };
}
```

### Acceptance — Step 4

- [ ] A throwaway tool `defineTool({ ..., inputSchemaZod: z.object({ x: z.number() }) })`
      produces `inputSchema` matching `{ type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false }`.
- [ ] Validating `{ x: 1, y: 2 }` against the strict schema rejects
      `y`.

---

## Step 5 — Namespace tools

`packages/mcp/src/tools/namespaces.ts`:

```ts
import { z } from 'zod';
import { Namespace, NamespaceCreate } from '@textral/contracts';
import { defineTool } from './types.js';

export const createNamespace = defineTool({
  name: 'create_namespace',
  description: 'Create a new namespace. Provisions the upstream vector backend (Qdrant collection or Pinecone reachability check).',
  inputSchemaZod: NamespaceCreate,
  handler: async ({ args, client }) => client.namespaces.create(args),
});

export const listNamespaces = defineTool({
  name: 'list_namespaces',
  description: 'List every namespace the calling tenant owns.',
  inputSchemaZod: z.object({}),
  handler: async ({ client }) => client.namespaces.list(),
});

export const getNamespace = defineTool({
  name: 'get_namespace',
  description: 'Fetch one namespace by slug.',
  inputSchemaZod: z.object({ slug: z.string() }),
  handler: async ({ args, client }) => client.namespaces.get(args.slug),
});
```

Each tool's description is ≤200 chars.

### Acceptance — Step 5

- [ ] All three tools present in `allTools`.
- [ ] Schemas valid JSON Schema 7 with `additionalProperties: false`.
- [ ] Handler smoke test (mock `TextralClient`) round-trips
      payloads.

---

## Step 6 — Document & ingest tools

`packages/mcp/src/tools/documents.ts`:

```ts
export const ingestFile = defineTool({
  name: 'ingest_file',
  description: 'Ingest a single file into a namespace. Runs register → upload → finalize → ingest internally. Optionally waits for the job to complete with progress notifications.',
  inputSchemaZod: z.object({
    namespace: z.string(),
    bytes: z.string().describe('base64-encoded file contents'),
    content_type: z.string().default('text/markdown'),
    title: z.string().optional(),
    doc_type: z.string().default('passage'),
    embedding: EmbeddingConfig,
    chunking: ChunkingConfig.default({}),
    mode: z.enum(['full', 'embed_only', 'enrichment_only']).default('full'),
    wait: z.boolean().default(false),
    wait_timeout_ms: z.number().int().positive().default(300_000),
  }),
  handler: async ({ args, client }) => {
    const bytes = Uint8Array.from(Buffer.from(args.bytes, 'base64'));
    const doc = await client.documents.register(args.namespace, {
      title: args.title ?? 'Untitled',
      doc_type: args.doc_type,
    });
    const upload = await client.documents.createUpload(doc.id, {
      content_type: args.content_type,
      size_bytes: bytes.length,
    });
    const putRes = await client.documents.putUploadBytes(upload.url, bytes, args.content_type);
    if (!putRes.ok) throw new Error(`upload PUT failed: ${putRes.status}`);
    const fin = await client.documents.finalize(doc.id, upload.upload_id);
    const ing = await client.documents.ingest(doc.id, {
      version_id: fin.version_id,
      embedding: args.embedding,
      chunking: args.chunking,
      mode: args.mode,
    });
    if (!args.wait) {
      return { document: doc, version_id: fin.version_id, job_id: ing.job_id };
    }
    // Poll with progress notifications.
    const final = await pollJobUntilTerminal(client, ing.job_id, args.wait_timeout_ms);
    return { document: doc, version_id: fin.version_id, job_id: ing.job_id, job: final };
  },
});

export const listDocuments = defineTool({ /* GET /v1/namespaces/{slug}/documents */ });
export const getDocument = defineTool({ /* GET /v1/documents/{id} */ });
export const listChunks = defineTool({ /* GET /v1/documents/{id}/chunks */ });
export const getChunk = defineTool({ /* GET /v1/chunks/{id} */ });
```

`pollJobUntilTerminal` lives in `packages/mcp/src/util/polling.ts`.
~30 LoC. Polls every 1.5s, emits `progressNotification` per stage
transition (it accepts the active `Server` instance from a context
store).

### Acceptance — Step 6

- [ ] `ingest_file` round-trips a markdown payload against the
      cookbook fixture in the validator (Step 15).
- [ ] `wait=true` emits at least one progress notification per
      stage transition.
- [ ] `list_chunks` and `get_chunk` return the same shape the
      sandbox SourcePanel renders.

---

## Step 7 — Query tools

`packages/mcp/src/tools/query.ts`:

```ts
export const query = defineTool({
  name: 'query',
  description: 'Run a citation-grounded query against a namespace. Returns answer + citations + full audit. output.mode=structured returns a JSON object instead of text.',
  inputSchemaZod: QueryRequest,
  handler: async ({ args, client }) => client.query(args),
});

export const listQueryEvents = defineTool({ /* GET /v1/query-events */ });
export const getQueryEvent = defineTool({ /* GET /v1/query-events/{id} */ });
export const getQueryResponse = defineTool({
  name: 'get_query_response',
  description: 'Fetch the original mirrored answer for a historical query event. Returns 410 reason if the mirror is missing.',
  inputSchemaZod: z.object({ id: z.string() }),
  handler: async ({ args, client }) => client.queryEvents.getResponse(args.id),
});
```

### Acceptance — Step 7

- [ ] `query` against the cookbook fixture returns
      `degradation_level: 'full'` with at least one citation.
- [ ] Replay flow: `list_query_events` → `get_query_response`
      yields the same payload the sandbox shows.

---

## Step 8 — Provider key tools

```ts
export const registerProviderKey = defineTool({
  name: 'register_provider_key',
  description: 'Register a BYOK provider key. The raw key is stored encrypted server-side and never re-emitted.',
  inputSchemaZod: ProviderKeyCreate,
  handler: async ({ args, client }) => client.providerKeys.create(args),
});

export const listProviderKeys = defineTool({ /* GET /v1/provider-keys */ });
```

### Acceptance — Step 8

- [ ] Registering a fake `sk-…` key returns metadata with no `key`
      field.
- [ ] List shows the new entry.

---

## Step 9 — Operations tools

```ts
export const listFailingJobs = defineTool({
  name: 'list_failing_jobs',
  description: 'List dead-lettered ingestion jobs for the calling tenant, paginated.',
  inputSchemaZod: z.object({ limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() }).strict(),
  handler: async ({ args, client }) => client.admin.listFailingJobs(args),
});

export const retryFailingJob = defineTool({
  name: 'retry_failing_job',
  description: 'Retry a dead-lettered ingestion job. wait=true blocks until the retry terminates.',
  inputSchemaZod: z.object({ job_id: z.string(), wait: z.boolean().default(false), wait_timeout_ms: z.number().int().positive().default(300_000) }),
  handler: async ({ args, client }) => {
    await client.ingestionJobs.retry(args.job_id);
    if (!args.wait) return { job_id: args.job_id, status: 'retrying' };
    return await pollJobUntilTerminal(client, args.job_id, args.wait_timeout_ms);
  },
});
```

### Acceptance — Step 9

- [ ] `list_failing_jobs` returns `[]` on a clean tenant.
- [ ] Retry round-trip works against a seeded DLQ row in the
      validator.

---

## Step 10 — Resources

`packages/mcp/src/resources/`:

- `openapi.ts` — fetches `/openapi.json` via the SDK and returns it
  as `mimeType: 'application/json'`.
- `profiles.ts` — fetches the corpus profile registry. New REST
  surface needed: `GET /v1/profiles` (~30 LoC route added in this
  step). Returns the same data `packages/corpus-profiles` exposes.
- `error-catalog.ts` — fetches the rendered error catalog markdown.
  Existing surface: the Scalar landing description appendix already
  renders it, but MCP needs a structured endpoint —
  `GET /v1/error-catalog` returning `Record<code, ErrorMeta>`. ~20
  LoC.

```ts
export const openapiResource: ResourceDef = {
  uri: 'textral://openapi',
  name: 'Textral OpenAPI spec',
  description: 'The full /openapi.json document.',
  mimeType: 'application/json',
  read: async ({ client }) => ({
    contents: [{
      uri: 'textral://openapi',
      mimeType: 'application/json',
      text: JSON.stringify(await client._raw('GET', '/openapi.json').then((r) => r.json()), null, 2),
    }],
  }),
};
```

### 10.1 Backend additions

Two small routes (~50 LoC total):

- `GET /v1/profiles` — returns `listProfiles()` from
  `packages/corpus-profiles`.
- `GET /v1/error-catalog` — returns `ERROR_CATALOG` from
  `apps/api/src/openapi/error-catalog.ts`.

Both registered in OpenAPI, tested in `apps/api/test/profiles-route.test.ts`
and `apps/api/test/error-catalog-route.test.ts`.

### Acceptance — Step 10

- [ ] Three resources discoverable via the MCP `resources/list`
      method.
- [ ] Each resource readable via `resources/read`.
- [ ] New `/v1/profiles` and `/v1/error-catalog` routes pinned in
      `openapi-coverage.test.ts`.

---

## Step 11 — Workflow prompts

`packages/mcp/src/prompts/`:

```ts
import { defineTool } from '../tools/types.js';

export const ingestDirectory: PromptDef = {
  name: 'ingest_directory',
  description: 'Ingest every file under a local directory into a namespace.',
  arguments: [
    { name: 'directory', description: 'Absolute path', required: true },
    { name: 'namespace', description: 'Target namespace slug', required: true },
    { name: 'corpus_profile', description: 'Optional corpus profile', required: false },
    { name: 'embedding_profile', description: 'Optional embedding profile', required: false },
  ],
  render: (args) => ({
    description: `Ingest ${args.directory} → ${args.namespace}`,
    messages: [
      { role: 'user', content: { type: 'text', text: `You are ingesting files from ${args.directory} ...` } },
    ],
  }),
};
```

(Full prompt body per design §9.1.)

`compare_retrieval_configs` and `evaluate_namespace` follow the same
pattern. `evaluate_namespace` returns a "this prompt is a Phase 2
placeholder" message when called.

### Acceptance — Step 11

- [ ] Three prompts discoverable via `prompts/list`.
- [ ] Each prompt renders to a non-empty `messages` array given
      valid arguments.
- [ ] Smoke test: invoke `ingest_directory` with sample args, assert
      the rendered text contains `textral.create_namespace` and
      `textral.ingest_file` references.

---

## Step 12 — Audit middleware (server-side)

`apps/api/src/audit/mcp.ts`:

```ts
export async function recordMcpToolCall(env: Env, args: {
  tenant_id: string; api_key_id: string | null; tool_name: string;
  transport: 'stdio' | 'http'; args_redacted: unknown;
  rest_call_count: number; latency_ms: number;
  outcome: 'ok' | 'tool_error' | 'rest_error' | 'cancelled';
  error_code?: string; error_message?: string;
}): Promise<void> {
  const id = newId('mcp');
  const auditMode = await getTenantAuditMode(env, args.tenant_id);
  const redacted = redactToolArgs(args.tool_name, args.args_redacted, auditMode);
  await env.db.exec(
    `INSERT INTO mcp_tool_calls (id, tenant_id, api_key_id, tool_name, transport,
        args_redacted, rest_call_count, latency_ms, outcome, error_code, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, args.tenant_id, args.api_key_id, args.tool_name, args.transport,
     JSON.stringify(redacted), args.rest_call_count, args.latency_ms, args.outcome,
     args.error_code ?? null, args.error_message ?? null, Date.now()],
  );
}

function redactToolArgs(toolName: string, args: unknown, mode: AuditMode): unknown { /* mirror redactRequestConfig */ }
```

### 12.1 Internal endpoint for stdio audit writes

When the MCP server runs over stdio, it doesn't have direct DB
access — it writes audit rows by calling a new internal endpoint:

`POST /v1/_internal/mcp_tool_calls` — auth-scoped. The tenant_id is
resolved from the API key. Body is the `recordMcpToolCall` args
minus `tenant_id` + `api_key_id`. ~30 LoC route.

(For embedded `/mcp`, the audit write happens in-process — no
internal call needed.)

### Acceptance — Step 12

- [ ] Stdio: invoking any tool inserts an `mcp_tool_calls` row
      visible via `SELECT *`.
- [ ] Embedded: same, written directly without the internal hop.
- [ ] Redaction: a tool with `query` arg containing `"my secret"`
      and `audit_mode='redacted'` produces a row with
      `args_redacted.query = '[REDACTED]'`.

---

## Step 13 — Sandbox MCP tab

`apps/sandbox/src/pages/Admin.tsx` gains a third tab. New page
`McpToolsTab` lists `mcp_tool_calls` rows from a new endpoint:
`GET /v1/admin/mcp_tool_calls?limit=100&cursor=…`.

The endpoint is sister to `GET /v1/admin/ingestion-jobs?dead_lettered=1` —
admin-scoped, cursor-paginated. ~50 LoC route. Pin in OpenAPI.

Sandbox tab columns: `created_at | tool_name | transport | latency_ms | outcome | rest_calls | error_code`.
Click a row → expands to show `args_redacted` JSON.

### Acceptance — Step 13

- [ ] Sandbox Admin page has tabs: **Ingestion jobs** /
      **Enrichment runs** / **MCP**.
- [ ] MCP tab populates from a real list endpoint.
- [ ] Cross-tenant isolation applies (operator sees own rows only).

---

# M2 — Embedded route + tests + CI

## Step 14 — Embedded `/mcp` route (Node runtime)

### 14.1 `packages/mcp/src/transport-http.ts`

```ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import type { ServerContext } from './server.js';

export async function handleHttpMcp(req: Request, ctx: ServerContext): Promise<Response> {
  const server = createServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);
  return await transport.handleRequest(req);
}
```

### 14.2 `apps/api/src/routes/mcp.ts`

```ts
import { Hono } from 'hono';
import { handleHttpMcp } from '@textral/mcp/http';
import { TextralClient } from '@textral/sdk';
import { recordMcpToolCall } from '../audit/mcp.js';
import type { Env, Variables } from '../types.js';

export const mcpRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

mcpRoute.all('/', async (c) => {
  // Phase 1: Node runtime only.
  if (c.env.runtime !== 'node') {
    return c.json(
      { error: { code: 'NOT_IMPLEMENTED', message: 'Embedded /mcp is Node-runtime-only in Phase 1; use the stdio CLI.' } },
      501,
    );
  }
  const tenantId = c.get('tenant_id')!;
  const apiKeyId = c.get('api_key_id') ?? null;
  const apiKey = c.req.header('x-textral-api-key')!;
  const baseUrl = new URL(c.req.url).origin;

  const client = new TextralClient({ baseUrl, apiKey });
  const audit = {
    record: (event: Parameters<AuditWriter['record']>[0]) =>
      recordMcpToolCall(c.env, { ...event, tenant_id: tenantId, api_key_id: apiKeyId }),
  };

  return await handleHttpMcp(c.req.raw, { client, audit, transport: 'http' });
});
```

Mounted in `app.ts` under `requireApiKey`:

```ts
v1.route('/mcp', mcpRoute);
```

### Acceptance — Step 14

- [ ] On the Node runtime: `POST /v1/mcp` with a valid
      `X-Textral-Api-Key` returns the MCP `initialize` handshake.
- [ ] On CF: returns 501 NOT_IMPLEMENTED with the documented
      message.
- [ ] All 16 tools listable via `tools/list` over HTTP.
- [ ] `tools/call` dispatches and writes an `mcp_tool_calls` row.

---

## Step 15 — MCP cookbook validator

`tools/mcp-cookbook-validator.ts` — sister to
`tools/validate-cookbook.ts`. Drives both transports through
canonical agent flows:

1. `list_namespaces` → confirms cookbook namespace exists.
2. `ingest_file` (with `wait=true`) on the cookbook fixture
   → confirms a job reaches `completed`.
3. `query` against the cookbook namespace
   → confirms `degradation_level: 'full'`.
4. `list_query_events?limit=5` → confirms the run lands.
5. `get_query_response` on the latest event → confirms the mirror
   returns intact.
6. `list_chunks` on the ingested doc → confirms ord ordering.

Runs against:

- `--transport=stdio` — spawns `node packages/mcp/dist/bin/textral-mcp.js`
  with env vars, drives it via JSON-RPC over stdio.
- `--transport=http` — POSTs to a running self-host stack at
  `http://localhost:8787/v1/mcp`.

### Acceptance — Step 15

- [ ] Both transports pass all 6 phases of the validator.
- [ ] Identical outputs across transports (the same tool calls
      yield the same payloads).

---

## Step 16 — Backend + package tests

### 16.1 `apps/api/test/mcp-route.test.ts`

cf-pool tests:

- `POST /v1/mcp` without auth → 401.
- `POST /v1/mcp` on the CF runtime → 501.
- `POST /v1/mcp/initialize` returns capabilities with all three
  features.
- `tools/list` returns 16 tools.
- `tools/call name=list_namespaces` returns the tenant's namespaces
  and writes one `mcp_tool_calls` row.
- Cross-tenant isolation: tenant B can't read tenant A's rows.

### 16.2 `apps/api/test/profiles-route.test.ts`

- 200 returns the corpus profile registry.
- 401 unauth.

### 16.3 `apps/api/test/error-catalog-route.test.ts`

- 200 returns the error catalog.
- Every `ErrorCode` enum member appears in the response.

### 16.4 `packages/mcp/test/`

- `server.test.ts` — `createServer({ ... })` exposes the right
  capabilities.
- `tools/namespaces.test.ts` — schemas validate, handlers call the
  right SDK method (mocked).
- `tools/ingest-file.test.ts` — the 4-step chain executes in order
  with a mocked SDK.
- `audit.test.ts` — `wrapWithAudit` records on success, failure,
  and exception paths.

### Acceptance — Step 16

- [ ] All new test files green.
- [ ] Full `pnpm -r test` green (zero new failures elsewhere).
- [ ] OpenAPI coverage includes `/v1/mcp`, `/v1/profiles`,
      `/v1/error-catalog`, `/v1/admin/mcp_tool_calls`.

---

## Step 17 — CI integration

### 17.1 `.github/workflows/ci.yml` Node lane

After the `Sandbox build (Vite)` step, add:

```yaml
      - name: SDK build + typecheck
        run: |
          pnpm --filter @textral/sdk typecheck
          pnpm --filter @textral/sdk build
          pnpm --filter @textral/sdk test

      - name: MCP build + typecheck
        run: |
          pnpm --filter @textral/mcp typecheck
          pnpm --filter @textral/mcp build
          pnpm --filter @textral/mcp test

      - name: MCP cookbook validator (embedded transport)
        run: pnpm --filter @textral/api exec tsx ../../tools/mcp-cookbook-validator.ts --transport=http
        env:
          TEXTRAL_BASE_URL: http://localhost:8787
          TEXTRAL_API_KEY: ${{ secrets.CI_TENANT_API_KEY }}
```

### 17.2 Makefile targets

```makefile
mcp-dev: ## MCP — start the stdio server with TEXTRAL_BASE_URL/TEXTRAL_API_KEY env
	@if [ -z "$$TEXTRAL_API_KEY" ]; then echo "ERROR: TEXTRAL_API_KEY env var unset" >&2; exit 1; fi
	$(PNPM) --filter @textral/mcp exec node ./dist/bin/textral-mcp.js

mcp-build: ## MCP — typecheck + build
	$(PNPM) --filter @textral/sdk build
	$(PNPM) --filter @textral/mcp build

mcp-typecheck: ## MCP — typecheck
	$(PNPM) --filter @textral/sdk typecheck
	$(PNPM) --filter @textral/mcp typecheck

mcp-validate: ## MCP — run the cookbook validator against the local stack
	@if [ -z "$$SELFHOST_API_KEY" ]; then echo "ERROR: SELFHOST_API_KEY env var unset" >&2; exit 1; fi
	TEXTRAL_BASE_URL=http://localhost:8787 TEXTRAL_API_KEY=$$SELFHOST_API_KEY \
	  $(PNPM) --filter @textral/api exec tsx ../../tools/mcp-cookbook-validator.ts --transport=http
```

### Acceptance — Step 17

- [ ] CI typecheck + build + test for both new packages on every
      PR.
- [ ] `make mcp-dev` starts the stdio server.
- [ ] `make mcp-validate` passes.

---

# M3 — Documentation + ship

## Step 18 — Documentation

### 18.1 `docs/mcp/QUICKSTART.md`

```markdown
# Textral MCP Quickstart

Two paths, depending on where Textral runs and which client you use.

## Path A: Local Claude Code (stdio)

```bash
claude mcp add textral \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=tx_live_… \
  -- npx @textral/mcp
```

## Path B: Cursor / Windsurf / Cline (JSON config)

```json
{
  "mcpServers": {
    "textral": {
      "command": "npx",
      "args": ["@textral/mcp"],
      "env": {
        "TEXTRAL_BASE_URL": "https://api.textral.example.com",
        "TEXTRAL_API_KEY": "tx_live_…"
      }
    }
  }
}
```

## Path C: Embedded /mcp (production self-host)

```json
{
  "mcpServers": {
    "textral": {
      "url": "https://api.textral.example.com/v1/mcp",
      "headers": { "X-Textral-Api-Key": "tx_live_…" }
    }
  }
}
```
```

### 18.2 README + QUICKSTART updates

- `README.md` Layout: new `packages/mcp/` row.
- `docs/QUICKSTART.md` "What's identical between modes": new row
  noting the same MCP surface ships both ways.
- `docs/SELF_HOSTING.md`: new §2.6 "Add Textral to your agent"
  walking through `npx @textral/mcp` → `claude mcp add textral`.

### 18.3 Scalar synthetic `MCP` tag

`apps/api/src/openapi/tag-descriptions.ts` — new entry:

```ts
MCP: `Textral exposes a Model Context Protocol server at
\`POST /v1/mcp\`. Tools, prompts, and resources are advertised via
the MCP protocol — not OpenAPI — so the operations don't appear in
this reference. See **docs/mcp/QUICKSTART.md** for client setup.`,
```

Add `'MCP'` to `TAG_GROUPS` under "Operations". One synthetic
operation in the spec at `POST /v1/mcp` describing the JSON-RPC
envelope.

### Acceptance — Step 18

- [ ] Quickstart doc renders correctly in markdown.
- [ ] README + QUICKSTART surface MCP visibly.
- [ ] Scalar `/docs` shows an MCP tag with the description.
- [ ] `docs-regression.test.ts` still green.

---

## Step 19 — Final close-out + verification

### 19.1 Cross-cutting

```bash
make typecheck && make lint && make test
make test-node
make selfhost-up
make selfhost-seed-cookbook
# Stdio:
make mcp-dev &
# Open Claude Code → "list textral namespaces" → confirms cookbook.
# Embedded:
make mcp-validate
make selfhost-down
```

All green is the close-out gate.

### 19.2 npm publish dry-run

```bash
pnpm --filter @textral/sdk publish --dry-run --access=public
pnpm --filter @textral/mcp publish --dry-run --access=public
```

Confirms package contents + entrypoints are correct. Actual publish
gated on the next external release.

### 19.3 Final tree audit

```bash
# No leftover GPT-doc references.
grep -rnE "TEXTRAL_MCP_DESIGN" docs/mcp/  # only in PLANNING/FEEDBACK

# Every MCP tool has a corresponding REST surface.
grep -rn 'client\.' packages/mcp/src/tools/ | sort -u  # all hit @textral/sdk

# Workspace typecheck clean.
pnpm -r typecheck
```

### 19.4 Ship gate

- [ ] All 19 step acceptance gates green.
- [ ] `make selfhost-up && make mcp-validate` passes against a
      fresh stack in <5 min from `git clone`.
- [ ] Claude Code stdio smoke test: a fresh operator can run
      `claude mcp add textral …` and `list_namespaces` works.
- [ ] CI Node lane includes SDK + MCP typecheck/build/test.
- [ ] `docs/mcp/QUICKSTART.md` walks an operator from clone to
      first `query` tool call in ≤10 minutes.

---

## Files added / modified — summary

**Added:**

```
packages/sdk/
├── package.json
├── tsconfig.json
└── src/{client,errors,index}.ts + test/

packages/mcp/
├── package.json
├── tsconfig.json
├── bin/textral-mcp.ts
└── src/
    ├── server.ts
    ├── audit.ts
    ├── transport-stdio.ts
    ├── transport-http.ts
    ├── zod-to-input-schema.ts
    ├── tools/{namespaces,documents,query,provider-keys,ops,types,index}.ts
    ├── prompts/{ingest-directory,compare-retrieval-configs,evaluate-namespace,index}.ts
    ├── resources/{openapi,profiles,error-catalog,index}.ts
    └── util/polling.ts
+ test/

apps/api/migrations/sqlite/0008_mcp_tool_calls.sql
apps/api/migrations/postgres/0008_mcp_tool_calls.sql
apps/api/src/audit/mcp.ts
apps/api/src/routes/mcp.ts
apps/api/src/routes/profiles.ts
apps/api/src/routes/error-catalog.ts
apps/api/src/routes/admin/mcp-tool-calls.ts
apps/api/test/mcp-route.test.ts
apps/api/test/profiles-route.test.ts
apps/api/test/error-catalog-route.test.ts

apps/sandbox/src/pages/Admin.tsx (modified — add MCP tab)

tools/mcp-cookbook-validator.ts

docs/mcp/QUICKSTART.md
```

**Modified:**

- `pnpm-workspace.yaml` — already includes `packages/*`; auto-discovered.
- `apps/api/src/app.ts` — mount `/v1/mcp`, `/v1/profiles`,
  `/v1/error-catalog`, `/v1/admin/mcp_tool_calls`.
- `apps/api/src/openapi/{tag-descriptions,components,registry}.ts` —
  new MCP tag, new schemas.
- `apps/api/test/openapi-coverage.test.ts` — pin new endpoints.
- `apps/sandbox/src/api/client.ts` — (optional) migrate to
  `@textral/sdk` after Phase 1 lands. Deferred.
- `Makefile` — `mcp-dev`, `mcp-build`, `mcp-typecheck`,
  `mcp-validate`.
- `.github/workflows/ci.yml` — SDK + MCP lane in Node job.
- `README.md`, `docs/QUICKSTART.md`, `docs/SELF_HOSTING.md` — MCP
  references.

---

End of Textral MCP Phase 1 implementation steps. Each step has a
clear acceptance gate. M1 (Steps 1–13) lands the server + tools +
audit; M2 (14–17) lands the embedded route + CI + tests; M3 (18–19)
ships docs + verification. The order is dependency-sound: every
step's prerequisites are completed by earlier steps.
