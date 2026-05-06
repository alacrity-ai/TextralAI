# Textral MCP — Quickstart

Two paths, depending on where Textral runs and which client you use.

The MCP server exposes 16 tools, 3 workflow prompts, and 3 read-only
resources. Every tool routes through the canonical REST API at
`/v1/*`, so tenant scoping, redaction, and audit policies apply
identically to both surfaces.

## Path A — local Claude Code (stdio)

### A.1 — Local workspace checkout (Phase 1, today)

`@textral/mcp` is `private: true` in Phase 1 — `npm publish` happens
in Phase 2. Until then, point Claude Code at the bin shim in your
checkout. The shim uses tsx's programmatic API to run the TypeScript
source directly; you don't need a build step.

```bash
claude mcp add textral \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=tx_live_… \
  -- node /absolute/path/to/textral/packages/mcp/bin/textral-mcp.mjs
```

e.g.
```bash
claude mcp add textral \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=tx_live_01KQV8KFHF83QRTQNC86AQ619G_WYHSUF4XHNF3ASY3RBVEZWRLSFN4JRK4 \
  -- node /home/leif/textral/TEXTRAL_REFACTOR_WIP/packages/mcp/bin/textral-mcp.mjs
```

Prerequisite: `pnpm install` from the workspace root (puts `tsx` in
`packages/mcp/node_modules`).

### A.2 — Published package (Phase 2 onward)

After `@textral/mcp` ships to npm:

```bash
claude mcp add textral \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=tx_live_… \
  -- npx @textral/mcp
```

The MCP process holds the key in env. Claude Code never sees it.
Each request from the agent flows out as `X-Textral-Api-Key: $TEXTRAL_API_KEY`
to your Textral deploy.

## Path B — Cursor / Windsurf / Cline (JSON config)

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

## Path C — embedded `/mcp` (production self-host)

The Node-runtime self-host stack mounts the MCP server in-process at
`POST /v1/mcp`. Same auth (`X-Textral-Api-Key`) as `/v1/*`; no
separate process, no separate container.

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

The Cloudflare runtime returns 501 NOT_IMPLEMENTED on `/v1/mcp` in
Phase 1 — use Path A or B against a CF-managed Textral. Embedded CF
support arrives once we've validated the Streamable HTTP transport
against workerd's long-lived stream semantics.

## Tool surface (Phase 1 ship list)

| Surface | Tools |
|---|---|
| Namespaces | `create_namespace`, `list_namespaces`, `get_namespace` |
| Documents + ingest | `ingest_file`, `list_documents`, `get_document`, `list_chunks`, `get_chunk` |
| Query | `query`, `list_query_events`, `get_query_event`, `get_query_response` |
| Provider keys (BYOK) | `register_provider_key`, `list_provider_keys` |
| Operations | `list_failing_jobs`, `retry_failing_job` |

`ingest_file` is the headline: it collapses the four-step REST chain
(register → upload → finalize → ingest) into one call. Pass
`wait=true` to block until the resulting ingestion job reaches a
terminal state, with progress notifications emitted on every stage
transition.

`ingest_file` accepts file content as **base64 bytes** only — the
MCP server never reads the local filesystem. The agent (Claude Code's
fs tools, a co-mounted filesystem MCP server) handles file IO.

## Workflow prompts

| Prompt | What it does |
|---|---|
| `ingest_directory` | Walks the agent through a bulk-ingest of a local directory into a namespace. |
| `compare_retrieval_configs` | Runs the same query under two retrieval configs and produces a markdown diff. |
| `evaluate_namespace` | Phase 2 placeholder — full implementation lands with sandbox eval support. |

## Resources

| URI | Returns |
|---|---|
| `textral://openapi` | The full `/openapi.json` document. |
| `textral://profiles` | Corpus profile registry (`/v1/profiles`). |
| `textral://error-catalog` | Error catalog (`/v1/error-catalog`). |

## Auth

Auth is end-to-end the same as REST: `X-Textral-Api-Key` for embedded
and stdio (passed via env on stdio). The MCP server never elevates
privileges — if your API key is scoped to a tenant, the agent can do
exactly what that scope allows. No OAuth / device-flow yet; that's
Phase 3.

## Audit

Every tool invocation lands a row in `mcp_tool_calls`. The Sandbox
**Admin → MCP** tab surfaces recent rows. Args are subject to the
same `tenants.audit_mode` redaction policy as `query_events` —
`ingest_file.bytes` is always redacted (size kept), and
`register_provider_key.key` is always redacted regardless of mode.

## Local dev loop

```bash
# 1. Bring up the self-host stack.
make selfhost-up
make selfhost-seed-cookbook   # prints SELFHOST_API_KEY=...

# 2. Sanity-check the embedded transport.
export SELFHOST_API_KEY=tx_live_...
make mcp-validate

# 3. Or wire it into Claude Code.
claude mcp add textral \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=$SELFHOST_API_KEY \
  -- npx @textral/mcp
```

`make mcp-validate` runs the cookbook validator
(`tools/mcp-validator/`) against the local stack via the embedded
transport. It walks six phases: namespace listed → query →
audit-row visible → mirror replay → document list → chunk fetch.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `INVALID_API_KEY` 401 | Env var missing/typo, or the key's been revoked. |
| Embedded `/v1/mcp` returns 501 | You're hitting the CF runtime; Phase 1 ships embedded only on Node. Switch to stdio (Path A). |
| `ingest_file` rejects with `BAD_REQUEST: too large` | Default cap is 25 MiB; chunk the upload. |
| Tool not visible in client | Confirm you're on the latest `@textral/mcp` and that your client revalidates the tool list per session. |
| Claude Code shows "Failed to reconnect to textral" with `npx @textral/mcp` | Phase 1: the package is `private: true`. Use Path A.1 above (`node /absolute/path/.../bin/textral-mcp.mjs`) until Phase 2 publishes. |
| `failed to load tsx loader` from the shim | Run `pnpm install` from the workspace root — `tsx` is a devDep of `@textral/mcp` and must be present in `packages/mcp/node_modules`. |
