# Textral Quickstart

Textral runs in two interchangeable modes. **Same Hono app, same
routes, same OpenAPI spec, same audit shape** — the runtime
decision only affects who runs the infrastructure underneath.

Pick whichever fits your situation; you can switch later (the
[migration runbook](./SELF_HOSTING.md#9-migration-from-cloudflare-v2)
covers Cloudflare → self-host).

## Pick a path

| If you want… | Pick | Quickstart | Time to first query |
|---|---|---|---|
| **Managed, no infrastructure to run.** Cloudflare account; Workers + D1 + R2 + Vectorize handle storage and serving. Default vector backend is Vectorize. | **Cloudflare** | [`CLOUDFLARE_QUICKSTART.md`](./CLOUDFLARE_QUICKSTART.md) | ~5 min |
| **Run it yourself**, on your own hardware or VPC. Docker Compose stack with Postgres + Redis + MinIO + Qdrant. Default vector backend is Qdrant; Pinecone optional. Data stays where you run it. | **Self-host** | [`SELF_HOSTING.md`](./SELF_HOSTING.md#2-quickstart) | ~10 min |

## Why each path exists

**Cloudflare-managed.** The original target. Edge serving, no
ops burden, Cloudflare-tier security and rate limiting, free Workers
AI tier for smoke tests. You bring an OpenAI / Anthropic key for
production-quality embeddings + synthesis. If "I want a RAG service
without standing anything up" is the answer, this is the path.

**Self-host.** V3 Phase 2 added a parallel adapter set so the same
codebase runs on plain Docker. Postgres replaces D1, Redis replaces
KV + Queue, MinIO (or any S3-compatible store) replaces R2, and
Qdrant or Pinecone replaces Vectorize. Pick this when data
residency, air-gapped deploys, or running on existing infrastructure
matters more than zero-ops convenience.

## What's identical between modes

- The `/v1/*` REST surface — every route, request shape, response
  shape, and OpenAPI annotation.
- The audit trail (`audit.tokens.*`, `audit.degradation_level`,
  `audit.reranker.executed`, `audit.synthesis_model_id`).
- The five corpus profiles (`generic`, `narrative`, `legal`,
  `support`, `technical`) and the per-namespace eval contract.
- BYOK provider keys for OpenAI, Anthropic, Voyage, Cohere.
- Hybrid retrieval (dense vector + sparse keyword + RRF fusion).
- SSE streaming on `/v1/query?stream=sse`.
- The same retrieval-quality sandbox UI (Vite + React) — `make
  selfhost-up` ships it at `http://localhost:5173`; for the managed
  Cloudflare deploy, run `make sandbox-dev` locally and point it
  at your Worker (proxy in `apps/sandbox/vite.config.ts`).
- The MCP server surface (`@textral/mcp`) — same 16 tools / 3
  prompts / 3 resources work against either mode via the stdio CLI
  (`npx @textral/mcp`). Self-host additionally exposes the embedded
  `POST /v1/mcp` route. See `docs/mcp/QUICKSTART.md`.

CI's `[cf, node] × [unit, integration]` matrix enforces that any
behavioral divergence between modes is a release blocker.

## What's different

| Surface | Cloudflare | Self-host |
|---|---|---|
| Default vector backend | `vectorize` | `qdrant` |
| Workers AI no-key tier | ✓ | ✗ — BYOK only (or wire LiteLLM) |
| AI Gateway | Cloudflare AI Gateway native | Bring your own (LiteLLM / Helicone) |
| Secrets | Cloudflare Secrets Store | Env file or Vault / SOPS |
| TLS | Cloudflare-edge | Operator's reverse proxy (Caddy / Traefik / nginx) |
| Backups | Cloudflare-managed durability | Operator's `pg_dump` / `mc mirror` / Qdrant snapshots |
| Multi-region | Cloudflare edge geo-routing | Single-host (operator adds HA) |

## Common to both — local dev tooling

```bash
make install               # pnpm install
make typecheck lint test   # all TS workspaces (cf-pool tests)
make test-node             # Node-runtime adapter tests (testcontainers; Docker required)
make test-ingest           # Container's pytest suite
```

The cf-pool tests run against miniflare (in-memory D1/R2/KV/
Vectorize); the Node tests stand up real Postgres + Redis + MinIO
via testcontainers. Both must pass before merge.

## After you have something running

The Scalar API reference is hosted at `/docs` on whichever endpoint
you spun up — same content, same auth-field-paste-the-key-here
pattern, in both modes. Start there.
