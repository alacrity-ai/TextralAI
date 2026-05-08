# Textral

> **Citation-grounded retrieval-augmented generation as a service —
> with first-class MCP integration so agents can drive ingest and
> retrieval end-to-end.**

[![License: Elastic License 2.0](https://img.shields.io/badge/license-Elastic%20License%202.0-005571.svg)](./LICENSE.md)
[![Node 24](https://img.shields.io/badge/node-24-43853d.svg)](https://nodejs.org)
[![pnpm 10](https://img.shields.io/badge/pnpm-10-orange.svg)](https://pnpm.io)

Textral is a multi-tenant RAG platform: tenants register namespaces,
ingest documents, and query them with citation-grounded answers.
Profile-driven enrichment, hybrid retrieval (dense vector + sparse
keyword + RRF), pluggable vector backends, BYOK provider keys,
explicit degradation semantics, and a per-namespace eval contract
— all behind a single REST surface, with a parallel **Model
Context Protocol (MCP)** server so LLM agents can drive the same
operations as named tool calls.

```text
                           ┌───────────────────────────────┐
                           │ Claude Code / Cursor / Cline  │
                           │ (any MCP client)              │
                           └─────────────┬─────────────────┘
                                         │ MCP / stdio or HTTP
                                         ▼
                           ┌───────────────────────────────┐
                           │   Textral MCP server          │  19 tools
                           │   (@textral/mcp)              │  3 prompts
                           └─────────────┬─────────────────┘  3 resources
                                         │ HTTPS REST
                                         ▼
                           ┌───────────────────────────────┐
                           │   Textral API (Hono)          │
                           │   /v1/* — namespaces,         │
                           │   ingest, query, audit        │
                           └─┬──────┬──────┬──────────┬───┘
                             │      │      │          │
                             ▼      ▼      ▼          ▼
                        Postgres  Redis  MinIO   Vectorize / Qdrant / Pinecone
                          / D1   / KV    / R2
```

## Why Textral

Most RAG stacks make you wire ten things together yourself: a loader,
an embedder, a vector store, a retriever, a synthesis prompt, an
audit trail, a multi-tenant boundary. Each one is its own decision,
and the glue rots. Textral is opinionated about the boundaries that
are hard to get right, and parameterized about everything else.

- **Citation-grounded by default.** Every answer carries source
  citations; degradation is *explicit* (`full` / `no_citations` /
  `partial` / `cannot_answer`) — never silent fabrication.
- **Multi-tenant from the wire down.** Every storage boundary —
  Postgres rows, vector metadata, blob prefixes, Pinecone native
  namespaces — enforces tenant + namespace scope. Cross-tenant
  probes return `404` by design.
- **Auditable.** Every `/v1/query` and every MCP tool call writes
  a row (`query_events`, `mcp_tool_calls`) with the full
  configuration that produced it, redaction-aware per
  `tenants.audit_mode`. Replay the answer, replay the run.
- **Pluggable backends.** Vectorize, Qdrant, or Pinecone — chosen
  per-namespace at create time, transparent on the query path. On
  Pinecone we use native namespaces for tenant isolation, so many
  Textral namespaces share one Pinecone index.
- **Profile-driven.** Five shipped corpus profiles (`generic`,
  `narrative`, `legal`, `support`, `technical`) declare chunking +
  enrichment + retrieval defaults. Per-request overrides win when
  supplied.
- **Agent-native.** The MCP layer publishes the same operations as
  curated, schema-validated tools. The agent doesn't have to read
  OpenAPI; it picks from a capability table.

## Quickstart

Two interchangeable runtimes — same `/v1/*` surface, same OpenAPI
spec, same audit shape. Pick whichever fits.

| Mode | What you run | Stack | Best for |
|---|---|---|---|
| **Cloudflare-managed** | A Cloudflare account | Workers + D1 + R2 + Vectorize V2 + Containers + AI Gateway | Zero-ops; default Vectorize backend; free Workers AI tier for smoke tests |
| **Self-hostable** | `docker compose up` on any Docker host | Hono on Node 24 + Postgres + Redis + MinIO + Qdrant | Data residency; air-gapped deploys; running on your own infrastructure |

```bash
# Self-host — fastest path to a running stack
git clone <this-repo> && cd textral
make install
make selfhost-up               # postgres + redis + qdrant + minio + api + ingest + sandbox
make selfhost-seed-cookbook    # provisions a tenant + cookbook namespace; prints SELFHOST_API_KEY=tx_…

# Hit the API
curl -H "X-Textral-Api-Key: $SELFHOST_API_KEY" http://localhost:8787/v1/me

# Open the operator UI
open http://localhost:5173

# Or wire it into Claude Code:
claude mcp add textral --scope user \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=$SELFHOST_API_KEY \
  -- npx -y @textral/mcp
```

For multi-environment users, drop a `~/.textral/profiles.toml` and add the MCP without env vars; see [`docs/mcp/QUICKSTART.md`](docs/mcp/QUICKSTART.md) for the resolution chain.

Detailed setup paths:

- **Cloudflare:** [`docs/CLOUDFLARE_QUICKSTART.md`](docs/CLOUDFLARE_QUICKSTART.md) — ~5 min
- **Self-host:** [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) — ~10 min
- **MCP integration:** [`docs/mcp/QUICKSTART.md`](docs/mcp/QUICKSTART.md)

## A flavor of the agent integration

Once you've added Textral as an MCP server, an agent can do the
whole loop in a single turn:

```
USER:  Ingest the lighthouse story I have on my desktop, then ask
       it who the lighthouse keeper is.

AGENT: [reads the file via its filesystem tool]
       [calls textral.create_namespace(slug="stories", backend="pinecone", ...)]
       [calls textral.ingest_file(namespace="stories", bytes=…, wait=true)]
       [calls textral.query(namespace="stories", query="Who is the lighthouse keeper?")]

       The lighthouse keeper is Iola Brennick, who has tended the lamp
       at Pernell's Cove for forty-three winters [1].

       [1] /the-lighthouse-keeper-of-pernell-s-cove
```

Same path against a Cloudflare-managed Textral; same path against
self-host; same audit row in `mcp_tool_calls`. The agent doesn't
know or care which vector backend sits underneath.

The MCP surface ships:

| Tools (16) | Prompts (3) | Resources (3) |
|---|---|---|
| Namespaces — `create_namespace`, `list_namespaces`, `get_namespace` | `ingest_directory` | `textral://openapi` |
| Documents — `ingest_file`, `list_documents`, `get_document`, `list_chunks`, `get_chunk` | `compare_retrieval_configs` | `textral://profiles` |
| Query — `query`, `list_query_events`, `get_query_event`, `get_query_response` | `evaluate_namespace` | `textral://error-catalog` |
| BYOK keys — `register_provider_key`, `list_provider_keys` | | |
| Operations — `list_failing_jobs`, `retry_failing_job` | | |

See [`docs/mcp/QUICKSTART.md`](docs/mcp/QUICKSTART.md) for client
setup (Claude Code, Cursor, Windsurf, Cline) and the workflow
patterns.

## What you get

- **Hybrid retrieval.** Dense vectors fused with sparse FTS5 /
  Postgres full-text via Reciprocal Rank Fusion. Optional rerank
  via Voyage / Cohere with a graceful audited fallback when keys
  aren't set.
- **Five corpus profiles** out of the box — each declaring chunker
  choice, enrichment passes (e.g., narrative gets character
  dossiers + scene + theme + section summary; legal gets clause
  extraction; support gets troubleshooting-step extraction), and
  retrieval defaults. Override any of it per request.
- **BYOK provider keys** for OpenAI, Anthropic, Voyage, Cohere,
  with a Cloudflare-only Workers AI no-key tier for smoke tests.
  AI Gateway in front of every external provider call (CF mode);
  LiteLLM / Helicone is the self-host equivalent.
- **Pluggable vector backends** — Vectorize (CF default), Qdrant
  (self-host default), Pinecone (managed serverless). Pinecone
  uses native namespaces for partitioning, so many Textral
  namespaces can share one Pinecone index.
- **SSE streaming** on `/v1/query?stream=sse`.
- **Per-namespace eval contract.** Golden sets, three built-in
  judges (correctness, citation accuracy, refusal calibration),
  hooks for tenant-supplied prompts. CLI in `packages/eval-cli`.
- **A retrieval-quality sandbox UI** (`apps/sandbox/`) — paste
  API key, pick namespace, run queries with full audit + candidate
  inspection. Drag-drop ingest. Compare-page diffs two retrieval
  configs side-by-side. Admin tab for the DLQ + MCP audit trail.
- **Daily cost rollups** in `usage_records` for tenant-side billing.

## Architecture at a glance

```
apps/api/              Hono app. Public + internal back-channel.
                       Two runtime entrypoints:
                         src/index.ts                       (Cloudflare Worker)
                         src/runtime/node/index.mjs         (Node self-host)
                       Adapters under src/runtime/{cf,node,shared}/.

apps/ingest/           FastAPI Container — ingestion stages
                       (fetch / normalize / chunk / embed / index / enrich).
                       Same image, both modes.

apps/sandbox/          Vite + React 19 + TS — operator console.
                       `make sandbox-dev` for local; ships under
                       `make selfhost-up` at http://localhost:5173.

packages/contracts/    Zod schemas — single source of truth for shapes.
                       Drives both REST OpenAPI and MCP tool input
                       schemas (via zod-to-json-schema).
packages/sdk/          Typed REST client (@textral/sdk).
packages/mcp/          MCP server (@textral/mcp). Stdio CLI + embedded
                       /v1/mcp route. Tools/prompts/resources derived
                       from contracts.
packages/corpus-profiles/  YAML profile registry + Zod loader.
packages/eval-cli/     `textral eval` CLI for the eval contract.

infrastructure/docker/
  docker-compose.yml         Full self-host stack
                             (postgres + redis + qdrant + minio +
                             api + ingest-worker + ingest + sandbox).
  docker-compose.dev.yml     CF-dev local helper (Qdrant + ingest only).

docs/                  Design notes, runbooks, MCP quickstart, fix plans,
                       threat model. See the table below.

tools/                 CI guards (no inline SQL, CF/Node import
                       boundaries), MCP cookbook validator, billing
                       reconciliation, load-test scripts.
```

The CI matrix (`[cf, node] × [unit, integration]`) enforces parity
between the two runtimes. Behavioral divergence is a release
blocker.

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/QUICKSTART.md`](docs/QUICKSTART.md) | Pick your path: Cloudflare vs self-host |
| [`docs/CLOUDFLARE_QUICKSTART.md`](docs/CLOUDFLARE_QUICKSTART.md) | Cloudflare-managed deploy in 5 minutes |
| [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) | Self-host operator runbook (compose, secrets, TLS, backups, V2 migration, MCP integration) |
| [`docs/mcp/QUICKSTART.md`](docs/mcp/QUICKSTART.md) | Wire Textral into Claude Code / Cursor / Windsurf / Cline as an MCP server |
| [`docs/API.md`](docs/API.md) | Public API reference + auto-generated OpenAPI link |
| [`docs/1-DESIGN.md`](docs/1-DESIGN.md) | System architecture and core invariants |
| [`docs/runbooks/`](docs/runbooks/) | Deploy, incidents, alerts, cost reconciliation |
| [`docs/security/THREAT_MODEL.md`](docs/security/THREAT_MODEL.md) | STRIDE-by-component threat model |
| [`docs/ideas/`](docs/ideas/) | Exploratory designs (e.g., upcoming Integrations support) |

The Scalar API reference at `/docs` (on either runtime) covers
"how do I call the API once it's running"; this README + the
quickstarts cover "how do I stand it up."

## Status

Production-ready for both deploy modes:

- **V3 Phase 2** — self-host runtime shipped alongside the
  Cloudflare deploy. Both modes pass CI's parity matrix.
- **MCP Phase 1** — 16 tools, 3 workflow prompts, 3 resources via
  stdio + embedded HTTP transport. Ships against either runtime.
- **Pinecone native-namespace partitioning** — many Textral
  namespaces share one Pinecone index, idiomatic multi-tenancy.
- **Sandbox UI** — operator console with drag-drop ingest, compare
  diffs, audit drawer, DLQ + MCP audit tabs.

What's not in scope today:

- Not a fine-tuning service. Models are upstream.
- Not multi-region in self-host mode (single-host compose stack;
  operators wire their own HA). Cloudflare-managed mode rides
  Cloudflare's edge.
- Not yet an OAuth-flow integration platform — see
  [`docs/ideas/INTEGRATIONS.md`](docs/ideas/INTEGRATIONS.md) for
  the upcoming first-class connectors design (Confluence, Jira,
  GitHub, Notion, Slack).

## Contributing

Contributions are welcome. Before opening a pull request:

1. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) — covers the DCO
   sign-off requirement, code conventions, and test expectations.
2. Sign your commits with `git commit -s` (Developer Certificate
   of Origin v1.1).
3. For non-trivial features, open an issue or drop a design note
   under `docs/ideas/` or `docs/fixes/` first.

For security issues, follow [`SECURITY.md`](SECURITY.md) — do not
open a public issue.

## License

Textral is licensed under the [Elastic License 2.0](LICENSE.md).

In short:

| You may | You may not |
|---|---|
| Use Textral internally, in production, modify it, build commercial products on top | Offer Textral (or a substantially-equivalent fork) to third parties as a hosted, managed, or SaaS service |

For commercial licensing — including hosting Textral as a service —
contact **leif@alacrity.ai**.

Third-party attributions live in [`NOTICE`](NOTICE).

## Acknowledgements

Textral builds on:

- [Hono](https://hono.dev/) (HTTP framework)
- [Zod](https://zod.dev) (schema validation; the source of truth for every contract)
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) (the MCP server runtime)
- [Cloudflare Workers + Vectorize V2 + Containers](https://workers.cloudflare.com/) (the managed deploy substrate)
- [Qdrant](https://qdrant.tech/), [Pinecone](https://pinecone.io), [MinIO](https://min.io), [Postgres](https://www.postgresql.org/), [Redis](https://redis.io)

---

Copyright (c) 2026 Alacrity AI Solutions LLC. "Textral" is a
trademark of Alacrity AI Solutions LLC.
