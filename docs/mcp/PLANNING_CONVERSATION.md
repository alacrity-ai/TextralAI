# MCP Planning Conversation

Our goal is to add MCP support for Textral, so that users can interact with textral using Claude code.  This provides an ergonomic, developer friendly way for users to interact with Textral - allowing Textral to ultimately become a node within a real Agentic pipeline.  The possibilities for this are that an org could deploy textral in their infrastructure, and whatever agentic flows they may have in their org could leverage textral as a document ingester, query surface, etc.  That's a potential big area where textral could become a powerful tool, because it's vector DB agnostic, has surfaces for ingest, enrichment, auditability etc.  Imagine textral as a node in a larger decision making pipeline.

Below is a planning conversation that the developer for Textral had with Chat GPT 5.5

Please note that while the GPT model had access to Textral's openapi spec, it did not have access to the file/folder structure or the actual codebase, or any other context about the application.  It also may not fully understand the context around MCP/Textral.

# Dev Question 1:
(TEXTRAL OPENAPI SPEC IS ATTACHED)
Help me understand what the actual features of an MCP server are. Specifically, imagine I have a RAG application with an openapi spec like: ATTACHED JSON SPEC: -- So I'm trying to imagine what MCP would give me if I were to add MCP support to this rag app. E.g. imagine a user would be able to use claude code in this app.. and ask claude stuff like: "Upload the documents in ./tmp/docs_to_be_ingested in a new namespace" "Query the namespace asking for the top 10 most important initiatives proposed in the docs, and then synthesize them into a summary md for me" That's what I'm imagining in my head MCP gives me. But I don't really understand how that's different from claude just being aware of the API spec of my RAG application, and just making API calls to the service based on those above prompts. What makes MCP different? What exactly is an MCP server? and what's the code look like underlying an MCP server? Are my above situations characteristic of MCP like operations in this context?

# Model responds to Dev Question 1:
Either is valid. **MCP is a protocol surface, not necessarily a separate service.**

You have three plausible deployment shapes:

### 1. Separate MCP adapter process/container

```txt
Claude Code ──MCP/stdio or HTTP──> textral-mcp
textral-mcp ──REST──> textral-api
```

Best for local developer tooling. The MCP server holds `TEXTRAL_BASE_URL` and `TEXTRAL_API_KEY`, wraps Textral REST calls, and can run via `npx`, Docker, or a sidecar container.

### 2. MCP routes inside Textral API runtime

```txt
Claude/client ──MCP HTTP/SSE──> textral-api /mcp
```

Best if you want Textral itself to be an MCP server. Your Hono/Worker/Node runtime exposes MCP endpoints alongside `/v1/*`. Internally, tools call the same services/controllers as REST.

### 3. Hybrid

```txt
Local Claude Code ──stdio──> local textral-mcp
local textral-mcp ──REST──> hosted Textral
```

Best early product path. It avoids entangling MCP lifecycle with your core API, and you can ship it as a lightweight companion package.

For **Textral**, I’d start with **a separate `packages/textral-mcp` adapter** that calls the existing OpenAPI-backed REST API. Later, once the tool contract stabilizes, you can embed `/mcp` into the Textral API runtime.

Architecturally:

```txt
apps/api               # canonical Textral REST API
packages/contracts     # shared schemas/types
packages/sdk           # typed Textral REST client
packages/mcp-server    # MCP tools/resources/prompts wrapping SDK
```

The MCP server should be thin. It should not duplicate ingestion/query logic. It should translate agent-friendly operations into your existing API calls.

# Dev Question 2
Write an MCP proposed design in markdown for me for textral.

# Model responds to Question 2
# TEXTRAL_MCP_DESIGN.md

## Overview

Textral already exposes a comprehensive REST/OpenAPI surface for:

* tenancy
* namespaces
* document registration
* upload orchestration
* ingestion
* retrieval
* citation-grounded synthesis
* evaluations
* operational recovery flows

The goal of the MCP layer is **not** to replace Textral’s REST API.

The goal is to expose Textral as an **agent-native capability surface** consumable by:

* Claude Code
* Claude Desktop
* Cursor
* Windsurf
* OpenAI-compatible agent runtimes
* internal orchestration agents
* future multi-agent systems

The MCP layer acts as a thin orchestration adapter over the canonical Textral REST API.

---

# Architectural Goals

## Primary Goals

### 1. Agent-Native Interaction

Allow agents to perform high-level semantic operations such as:

```txt
"Ingest all PDFs in ./contracts into a new namespace."

"Run a retrieval analysis against the namespace."

"Generate a citation-grounded markdown summary."

"Evaluate retrieval quality using the existing eval set."

"Re-embed the namespace using Voyage embeddings."
```

---

### 2. Preserve Existing REST Surface

Textral REST remains:

* canonical
* stable
* externally documented
* SDK-compatible
* infrastructure-independent

The MCP server is an adapter layer only.

---

### 3. Thin Translation Layer

The MCP server should contain:

* minimal business logic
* no vector logic
* no ingestion logic
* no retrieval orchestration logic

It should:

* validate MCP inputs
* translate MCP tool invocations into Textral REST calls
* normalize responses into MCP-compatible content

---

### 4. Runtime-Agnostic Deployment

Support:

| Mode     | Use Case                       |
| -------- | ------------------------------ |
| stdio    | Claude Code local execution    |
| HTTP/SSE | remote MCP runtime             |
| embedded | future integrated `/mcp` route |

---

# Mental Model

## REST API

REST answers:

```txt
"How do I call Textral?"
```

---

## MCP

MCP answers:

```txt
"What capabilities does Textral expose to an autonomous agent?"
```

---

# High-Level Topology

## Recommended Initial Architecture

```txt
Claude Code
    │
    │ MCP (stdio)
    ▼
textral-mcp
    │
    │ HTTPS REST
    ▼
Textral API
    │
    ├── Postgres / D1
    ├── Redis
    ├── Vector DB
    ├── Object Storage
    └── Provider APIs
```

---

# Repository Layout

```txt
/apps
  /api
    Textral canonical REST API

/packages
  /contracts
    Shared zod/types/OpenAPI contracts

  /sdk
    Typed REST SDK used by MCP layer

  /mcp-server
    MCP server implementation

  /mcp-tools
    Shared MCP tool definitions

  /mcp-prompts
    Reusable workflow prompts
```

---

# MCP Server Responsibilities

## Responsibilities

### Tool Exposure

Expose Textral operations as MCP tools.

---

### Resource Exposure

Expose inspectable contextual resources.

---

### Prompt Templates

Expose reusable retrieval workflows.

---

### Authentication Bridging

Resolve:

```txt
TEXTRAL_BASE_URL
TEXTRAL_API_KEY
```

for outbound REST calls.

---

### Progress Polling

Convert asynchronous ingestion jobs into agent-friendly flows.

Example:

```txt
upload_document
→ ingest_document
→ wait_for_ingestion
→ query_namespace
```

---

## Non-Responsibilities

The MCP layer must NOT:

* embed vectors
* chunk documents
* implement retrieval
* perform reranking
* manage providers
* contain corpus logic
* implement authorization rules independently
* duplicate Textral business logic

All core logic remains inside Textral API services.

---

# Core MCP Tool Surface

## Namespace Tools

### `textral_create_namespace`

Creates a namespace.

#### Inputs

```json
{
  "slug": "acme-contracts",
  "corpus_profile": "legal",
  "default_embedding_profile": "openai-text-embedding-3-large"
}
```

#### Underlying REST

```txt
POST /v1/namespaces
```

---

### `textral_list_namespaces`

Lists tenant namespaces.

#### REST

```txt
GET /v1/namespaces
```

---

# Document Tools

## `textral_register_document`

Registers document metadata before upload.

---

## `textral_create_upload`

Creates presigned upload URL.

---

## `textral_finalize_upload`

Finalizes uploaded bytes into immutable version.

---

## `textral_ingest_document`

Triggers ingestion pipeline.

Supports:

```txt
full
embed_only
enrichment_only
```

---

## `textral_wait_for_ingestion`

Polls ingestion job until completion/failure.

This is an MCP-native convenience abstraction over:

```txt
GET /v1/ingestion-jobs/:id
```

---

## `textral_list_documents`

Lists documents inside namespace.

---

# Query Tools

## `textral_query_namespace`

Primary retrieval/synthesis operation.

### Inputs

```json
{
  "namespace": "acme-contracts",
  "query": "Summarize vendor obligations",
  "top_k_dense": 20,
  "top_k_sparse": 20,
  "structured_output": false
}
```

### REST

```txt
POST /v1/query
```

---

## `textral_query_structured`

Convenience wrapper over:

```txt
output.mode = structured
```

Useful for:

* extraction
* JSON synthesis
* schema-constrained workflows
* downstream agent pipelines

---

## `textral_get_query_event`

Retrieves audit details.

---

# Evaluation Tools

## `textral_run_eval_set`

Runs retrieval evaluation suite.

---

## `textral_list_eval_runs`

Lists historical runs.

---

# Administrative Tools

## `textral_retry_dead_letter_job`

Operational recovery flow.

---

## `textral_reembed_namespace`

Bulk namespace re-index helper.

---

# MCP Resources

Resources expose read-only contextual surfaces.

---

## Namespace Resources

```txt
textral://namespaces
textral://namespaces/{slug}
```

---

## Document Resources

```txt
textral://namespaces/{slug}/documents
textral://documents/{id}
```

---

## Query Resources

```txt
textral://query-events/{id}
```

---

## Operational Resources

```txt
textral://ingestion-jobs/{id}
```

---

## Metadata Resources

```txt
textral://profiles
textral://models
textral://openapi
```

---

# MCP Prompt Templates

Prompt templates provide reusable orchestrations.

---

## `ingest_directory`

### Purpose

Bulk ingest local files into namespace.

### Example User Prompt

```txt
Ingest all PDFs from ./contracts into a namespace called vendor-contracts.
```

### Agent Workflow

```txt
filesystem:list_directory
→ textral_create_namespace
→ textral_register_document
→ textral_create_upload
→ filesystem:read_file
→ upload bytes
→ textral_finalize_upload
→ textral_ingest_document
→ textral_wait_for_ingestion
```

---

## `summarize_namespace`

Produces citation-grounded markdown summaries.

---

## `extract_initiatives`

Useful for strategic analysis workflows.

Example:

```txt
Identify the top 10 strategic initiatives across the corpus.
```

---

## `run_retrieval_eval`

Runs evaluation suites and summarizes retrieval quality.

---

# Authentication Strategy

## Initial Design

Environment-driven:

```txt
TEXTRAL_BASE_URL
TEXTRAL_API_KEY
```

---

## Future

Potential OAuth/device-auth flows.

---

# Transport Modes

## stdio (Primary Initial Target)

Best for:

* Claude Code
* local workflows
* developer tooling

---

## HTTP/SSE

Future remote shared MCP deployment.

---

## Embedded `/mcp`

Future possibility:

```txt
POST /mcp
```

inside Textral API runtime.

Not recommended initially due to coupling concerns.

---

# Example End-to-End Workflow

## User Prompt

```txt
Upload the docs in ./tmp/docs_to_be_ingested into a namespace called board-materials.

Then identify the top 10 proposed initiatives and generate a markdown executive summary.
```

---

## Agent Execution Plan

```txt
filesystem:list_directory
→ textral_create_namespace
→ for each file:
    → textral_register_document
    → textral_create_upload
    → upload file
    → textral_finalize_upload
    → textral_ingest_document
→ textral_wait_for_ingestion
→ textral_query_namespace
→ filesystem:write_file("./summary.md")
```

---

# Why MCP Matters For Textral

Without MCP:

```txt
LLM reads OpenAPI spec
→ attempts arbitrary REST orchestration
```

Problems:

* inconsistent tool semantics
* weak discoverability
* poor orchestration abstraction
* client incompatibilities
* fragile prompting
* no standardized resources/prompts/tools
* no agent ecosystem integration

---

With MCP:

```txt
Textral becomes a first-class agent capability provider.
```

Benefits:

* standardized tool discovery
* strongly typed operations
* reusable prompts
* ecosystem compatibility
* portable orchestration
* cleaner permission boundaries
* composable multi-agent workflows
* lower prompt complexity
* better operational determinism

---

# Security Considerations

## Scope Isolation

MCP server should never expand privileges beyond Textral API scopes.

---

## Tenant Isolation

All calls remain tenant-scoped via Textral API keys.

---

## Filesystem Boundaries

Textral MCP server should NOT directly access arbitrary local files unless explicitly configured.

Filesystem access should generally come from:

* Claude Code native filesystem tools
* separate filesystem MCP server

---

## Auditability

All retrieval/query operations continue generating canonical Textral audit rows.

MCP must not bypass audit infrastructure.

---

# Recommended Initial Implementation Strategy

## Phase 1 — Minimal Viable MCP

Implement:

* namespace creation
* document upload orchestration
* ingestion
* query
* polling helpers

stdio transport only.

---

## Phase 2 — Resources + Prompts

Add:

* resources
* prompt templates
* eval tooling

---

## Phase 3 — Remote MCP

Add:

* HTTP/SSE transport
* auth/session support
* multi-user deployment

---

## Phase 4 — Embedded Runtime (Optional)

Evaluate embedding MCP directly into Textral runtime.

Only after tool contracts stabilize.

---

# Final Recommendation

Textral should treat MCP as:

```txt
An agent-native orchestration surface over the canonical Textral API.
```

Not:

```txt
A replacement for the REST platform.
```

The strongest architectural posture is:

```txt
Textral REST API = canonical business platform
Textral MCP = agent interaction adapter
```

That separation preserves:

* API stability
* operational clarity
* testability
* transport flexibility
* ecosystem interoperability
* future agent platform compatibility


# Dev Question 3
and once textral exposes this.. I don't need to install some additional textral plugin for claude code or anything? Claude just needs to know of its existence? or is there some canonical definition or something I need to make?

# Model Response to Question 3
Correct: **Claude Code does not magically discover Textral.** You still need to **register the MCP server with the client**.

There is no “Textral plugin” in the old browser-extension sense. There is:

```txt
1. Textral MCP server exists
2. Claude Code is configured to connect to it
3. Claude Code discovers its tools/resources/prompts via MCP
```

For a local stdio MCP server, that usually means something like:

```bash
claude mcp add textral \
  --env TEXTRAL_BASE_URL=https://api.textral.example.com \
  --env TEXTRAL_API_KEY=tx_... \
  -- npx @textral/mcp-server
```

For a remote MCP server, it is more like:

```bash
claude mcp add textral https://api.textral.example.com/mcp \
  --header "Authorization: Bearer ..."
```

The canonical definition is **not OpenAPI**. The MCP server itself advertises its capabilities through the MCP protocol: tools have names, descriptions, and input schemas; resources have URIs; prompts have names and argument schemas. MCP’s current spec defines servers as exposing **tools, resources, and prompts** to clients. ([Model Context Protocol][1])

So for Textral you would ship one or both of these:

```txt
@textral/mcp-server        # npm package, stdio/local use
https://.../mcp            # hosted MCP endpoint
```

Then document “add this MCP server to Claude Code.”

After that, Claude Code can inspect the server and see tools like:

```txt
textral_create_namespace
textral_upload_document
textral_ingest_document
textral_query_namespace
textral_get_query_event
```

The extra artifact you may want, but is not the protocol itself, is a simple config snippet:

```json
{
  "mcpServers": {
    "textral": {
      "command": "npx",
      "args": ["@textral/mcp-server"],
      "env": {
        "TEXTRAL_BASE_URL": "https://api.textral.example.com",
        "TEXTRAL_API_KEY": "tx_..."
      }
    }
  }
}
```

So the rule of thumb:

```txt
OpenAPI = describes your HTTP API to developers
MCP server = advertises executable agent tools to MCP clients
Claude Code config = tells Claude Code where that MCP server is
```

Once configured, there is no additional plugin logic needed.

[1]: https://modelcontextprotocol.io/specification/2025-11-25?utm_source=chatgpt.com "Specification"


