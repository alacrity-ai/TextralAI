# Textral

Multi-tenant, citation-grounded retrieval-augmented generation as a
service. Embedding-aware retrieval, profile-driven enrichment,
citation-grounded synthesis, and a per-namespace eval contract —
exposed behind a single REST surface.

## Two ways to run it

| Mode | What you run | Stack | Best for |
|---|---|---|---|
| **Cloudflare-managed** | A Cloudflare account | Workers + D1 + R2 + Vectorize V2 + Containers + AI Gateway | Zero-ops; default Vectorize backend; free Workers AI tier for smoke tests |
| **Self-hostable** | `docker compose up` on any Docker host | Hono on Node 24 + Postgres + Redis + MinIO + Qdrant | Data residency; air-gapped deploys; running on your own infrastructure |

Same Hono app, same `/v1/*` routes, same OpenAPI surface, same
audit shape across both modes — CI's `[cf, node] × [unit,
integration]` matrix enforces parity. The runtime decision picks
adapters; everything else flows through `runtime/shared/Bindings`.

## Quickstart

Pick your path in [`docs/QUICKSTART.md`](docs/QUICKSTART.md), or
jump straight in:

- **Cloudflare:** [`docs/CLOUDFLARE_QUICKSTART.md`](docs/CLOUDFLARE_QUICKSTART.md) — ~5 min
- **Self-host:** [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) — ~10 min

```bash
make install               # pnpm install
make typecheck lint test   # all TS workspaces (cf-pool tests)
make test-node             # Node-runtime adapter tests (testcontainers; Docker required)
make test-ingest           # Container pytest
```

## What it is

- A managed RAG service. Tenants register namespaces, ingest
  documents, and query them with citation-grounded answers.
- Five shipped corpus profiles (`generic`, `narrative`, `legal`,
  `support`, `technical`) declare chunking + enrichment + retrieval
  defaults. Per-request overrides win when supplied.
- BYOK provider keys (OpenAI, Anthropic, Voyage, Cohere) plus a
  Cloudflare-only Workers AI no-key tier. AI Gateway in front of
  every external provider call for per-tenant tagging + caching +
  rate limits (Cloudflare-managed mode); LiteLLM / Helicone is the
  self-host equivalent.
- Pluggable vector backends — Vectorize (Cloudflare-managed
  default), Qdrant (self-host default; or Qdrant Cloud), Pinecone
  (managed serverless). Backend choice is per-namespace at create
  time and transparent to the query path.
- Eval contract: per-namespace golden sets, three built-in judges,
  hooks for tenant-supplied prompts. CLI in `packages/eval-cli`.
- SSE streaming for `/v1/query?stream=sse`.
- Daily cost rollups in `usage_records` for tenant-side billing.

## What it isn't (yet)

- Not a fine-tuning service. Models are upstream.
- Not multi-region in self-host mode (single-host compose stack;
  operators wire their own HA). Cloudflare-managed mode rides
  Cloudflare's edge.

## Status

V3 Phase 2 — self-host runtime shipped alongside the Cloudflare
deploy. See `docs/development/v3/PHASE_2_IMPLEMENTATION.md` for the
delivery shape. `docs/SIGNOFF.md` carries the original v0.1.0
sign-off checklist.

## Layout

```
apps/api               Hono app — public API + internal back-channel.
                       Two runtime entrypoints:
                         src/index.ts                       (Cloudflare Worker)
                         src/runtime/node/index.mjs         (Node self-host)
                       Adapters under src/runtime/{cf,node,shared}/.
apps/ingest            FastAPI Container — ingestion stages
                       (fetch / normalize / chunk / embed / index / enrich).
                       Same image, both modes.
apps/sandbox           Retrieval-quality sandbox UI (Vite + React 19 + TS).
                       Operator console — paste API key, pick namespace,
                       run queries with full audit + candidate inspection.
                       `make sandbox-dev` for local dev; ships under
                       `make selfhost-up` at http://localhost:5173.
infrastructure/docker/
  docker-compose.yml         Full self-host stack (postgres + redis + qdrant
                             + minio + api + ingest-worker + ingest).
  docker-compose.dev.yml     CF-dev local helper (Qdrant + ingest only).
packages/contracts     Shared Zod schemas + IDs + error catalog.
packages/corpus-profiles  YAML profile registry + Zod loader (mirrored
                       Pydantic on the Container).
packages/eval-cli      `textral eval` CLI for the eval contract.
docs/                  Design, phase implementation guides, runbooks.
tools/                 CI guards (D1 placement, CF/Node import boundaries),
                       load test, billing reconciliation.
```

## Documentation

| Doc | Purpose |
|-----|---------|
| `docs/QUICKSTART.md` | Pick your path: Cloudflare vs self-host |
| `docs/mcp/QUICKSTART.md` | Wire Textral into Claude Code / Cursor / Windsurf as an MCP server |
| `docs/CLOUDFLARE_QUICKSTART.md` | Cloudflare-managed deploy in 5 minutes |
| `docs/SELF_HOSTING.md` | Self-host operator runbook (compose, secrets, TLS, backups, V2 migration) — includes the sandbox UI at http://localhost:5173 |
| `docs/v3/TEXTRAL_SANDBOX_FRONTEND_DESIGN.md` | Sandbox design rationale + page sketches |
| `docs/development/v3/TEXTRAL_SANDBOX_FRONTEND_IMPLEMENTATION.md` | 23-step sandbox build plan + acceptance gates |
| `docs/0-MIGRATION_PLAN_DRAFT.md` | Original migration goal |
| `docs/1-DESIGN.md` | System architecture |
| `docs/2-PHASES.md` | Phase-by-phase delivery plan |
| `docs/development/PHASE_*_IMPLEMENTATION.md` | One per phase: ordered steps + locked-in choices |
| `docs/development/v3/PHASE_2_IMPLEMENTATION.md` | The self-host runtime delivery |
| `docs/v3/PHASE-2_DETAILED_DESIGN.md` | Self-host design rationale (audience: contributors) |
| `docs/API.md` | Public API reference + auto-generated OpenAPI link |
| `docs/runbooks/DEPLOY.md` | Production deploy checklist (Cloudflare) |
| `docs/runbooks/INCIDENTS.md` | Common incidents + responses |
| `docs/runbooks/ALERTS.md` | Alert wiring + manual-fire recipes |
| `docs/runbooks/COST_RECONCILIATION.md` | Per-tenant cost reconciliation |
| `docs/security/THREAT_MODEL.md` | STRIDE-by-component threat model |
| `docs/SIGNOFF.md` | MVP sign-off checklist |

The Scalar API reference at `/docs` (on either runtime) covers
"how do I call the API once it's running"; this README + the
quickstarts cover "how do I stand it up."

## Reference repos

`reference_repos/home-app` and `reference_repos/landlord-contracts`
show how we structure Cloudflare projects. Containers and Vectorize
V2 are Textral-new; see `docs/third-party/` for background.
