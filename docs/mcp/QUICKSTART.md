# Textral MCP — Quickstart

Two paths, depending on where Textral runs and which client you use.

The MCP server exposes 16 tools, 3 workflow prompts, and 3 read-only
resources. Every tool routes through the canonical REST API at
`/v1/*`, so tenant scoping, redaction, and audit policies apply
identically to both surfaces.

## Cloudflare runtime compatibility

Every `@textral/mcp` tool works against both self-host (Node) and
Cloudflare deployments. The MCP V2 smoke harness
(`apps/api/test/mcp-cf-smoke.test.ts`) exercises every tool's
underlying REST call against a deployed worker; the green list
covers the full v0.1.0 tool surface:

| Tool | CF | Self-host | Notes |
|---|---|---|---|
| `list_models` | ✓ | ✓ | |
| `list_namespaces` | ✓ | ✓ | |
| `get_namespace` | ✓ | ✓ | |
| `create_namespace` | ✓ | ✓ | Vectorize provisioning is a no-op (binding is global). |
| `list_documents` | ✓ | ✓ | |
| `get_document` | ✓ | ✓ | |
| `list_chunks` | ✓ | ✓ | |
| `get_chunk` | ✓ | ✓ | |
| `ingest_file` | ✓ | ✓ | R2 streaming + Container handoff verified. |
| `query` | ✓ | ✓ | Hybrid retrieval + AI Gateway routing verified. |
| `get_query_event` | ✓ | ✓ | |
| `get_query_response` | ✓ | ✓ | 410 `QUERY_RESPONSE_UNAVAILABLE` is a documented response, not a CF gap. |
| `list_query_events` | ✓ | ✓ | |
| `list_provider_keys` | ✓ | ✓ | |
| `register_provider_key` | ✓ | ✓ | |
| `list_failing_jobs` | ✓ | ✓ | |
| `retry_failing_job` | ✓ | ✓ | |

The MCP server detects the runtime at profile-load time via
`/v1/me`'s `runtime: 'cf' | 'node'` field and surfaces clear errors
before dispatching any tool that has runtime-specific limitations.

The HTTP transport (`POST /v1/mcp`) is **only** available on the
Node self-host runtime; Cloudflare deploys use the stdio transport
exclusively. Stdio works against any HTTPS Textral URL — it covers
Claude Code, Cursor, Windsurf, Cline, and every other MCP client.

To re-run the smoke harness against the live deploy:

```bash
MCP_SMOKE_CF=1 \
MCP_SMOKE_KEY=tx_live_… \
  pnpm --filter @textral/api test mcp-cf-smoke
```

(Optional: `MCP_SMOKE_BASE_URL`, `MCP_SMOKE_NAMESPACE` to override
defaults.)

## Path A — Claude Code (stdio, recommended)

```bash
claude mcp add textral --scope user -- npx -y @textral/mcp
```

That's it. No clone, no build step, no absolute paths. `npx` resolves the latest `@textral/mcp` from npm on every spawn. Configure with a profile file (see "Profiles" below) or with env vars on the launch command for the single-tenant case:

```bash
claude mcp add textral --scope user \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=tx_live_… \
  -- npx -y @textral/mcp
```

The MCP process holds the key. Claude Code never sees it. Each request flows out as `X-Textral-Api-Key: $TEXTRAL_API_KEY` to your Textral deploy.

### Pinning a version

```bash
claude mcp add textral --scope user -- npx -y @textral/mcp@0.1.0
```

### Globally installed (if you want spawn speed)

```bash
npm install -g @textral/mcp
claude mcp add textral --scope user -- textral-mcp
```

## Path B — Cursor / Windsurf / Cline (JSON config)

```json
{
  "mcpServers": {
    "textral": {
      "command": "npx",
      "args": ["-y", "@textral/mcp"],
      "env": {
        "TEXTRAL_BASE_URL": "https://api.textral.example.com",
        "TEXTRAL_API_KEY": "tx_live_…"
      }
    }
  }
}
```

For multi-environment, drop the `env` block and rely on `~/.textral/profiles.toml`.

## Path C — embedded `/mcp` (Node self-host only)

The Node-runtime self-host stack mounts the MCP server in-process at `POST /v1/mcp`. Same auth (`X-Textral-Api-Key`) as `/v1/*`; no separate process, no separate container.

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

The embedded HTTP transport is **only** available on the Node self-host runtime; Cloudflare deploys return 501 NOT_IMPLEMENTED on `/v1/mcp`. Use Path A or B against a CF-managed Textral. (Stdio works against any HTTPS Textral URL — including CF.)

## Profiles — multiple Textrals from one Claude session

Drop a `~/.textral/profiles.toml`:

```toml
default = "hosted-prod"

[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_…"

[profiles.local-stage]
base_url = "http://localhost:9000"
api_key  = "tx_live_…"

[profiles.hosted-prod]
base_url = "https://textral-api-dev.leif-e24.workers.dev"
api_key  = "tx_live_…"
```

Then add the MCP without env vars:

```bash
claude mcp add textral --scope user -- npx -y @textral/mcp
```

**Resolution precedence (tightest → loosest):**

1. `TEXTRAL_PROFILE=hosted-prod` env var on the MCP launch command
2. `default = "hosted-prod"` field in the profile file
3. Lexicographically first profile name in `[profiles.*]`
4. Synthesized `_env` profile from `TEXTRAL_BASE_URL` + `TEXTRAL_API_KEY` (only when no profile file exists)
5. Hard fail with a help message

**Two new tools** are exposed for switching mid-session:

- `textral_get_profile` — returns the active profile and the available list. Useful for "which env am I in?"
- `textral_set_profile({ name })` — flips the active profile. All subsequent tool calls use the new profile. Probe-fails atomically: a bad switch leaves the prior profile active. Probe runs `/v1/me` against the new profile's base URL.

**Cross-environment queries** are explicit two-step calls:

```
User: "List my namespaces in stage and in prod."
  → textral_set_profile({ name: "local-stage" })
  → textral_list_namespaces()
  → textral_set_profile({ name: "hosted-prod" })
  → textral_list_namespaces()
```

There is **no** per-call `profile?: string` parameter on the tool inputs. Every token Claude would spend inferring "what env did the user mean?" is wasted; switching is always intentional and stateful.

**File permissions:** recommend `chmod 600 ~/.textral/profiles.toml`. The server warns at startup if the file is group- or world-readable; the API keys are bearer credentials.

**`TEXTRAL_CONFIG_DIR`** env var overrides the location (`~/.textral` by default). Useful for ephemeral CI / sandboxed test environments.

## Tool surface

| Surface | Tools |
|---|---|
| Profile control | `textral_get_profile`, `textral_set_profile` |
| Namespaces | `create_namespace`, `list_namespaces`, `get_namespace` |
| Documents + ingest | `ingest_file`, `list_documents`, `get_document`, `list_chunks`, `get_chunk` |
| Query | `query`, `list_query_events`, `get_query_event`, `get_query_response` |
| Provider keys (BYOK) | `register_provider_key`, `list_provider_keys` |
| Operations | `list_failing_jobs`, `retry_failing_job` |
| Meta | `list_models` |

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
| `evaluate_namespace` | Walks the agent through eval-set-driven retrieval evaluation against a namespace. |

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
claude mcp add textral --scope user \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=$SELFHOST_API_KEY \
  -- npx -y @textral/mcp
```

`make mcp-validate` runs the cookbook validator
(`tools/mcp-validator/`) against the local stack via the embedded
transport. It walks six phases: namespace listed → query →
audit-row visible → mirror replay → document list → chunk fetch.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `INVALID_API_KEY` 401 | Env var missing/typo, or the key's been revoked. |
| Embedded `/v1/mcp` returns 501 | You're hitting the CF runtime; embedded HTTP is Node self-host only. Switch to stdio (Path A). |
| `ingest_file` rejects with `BAD_REQUEST: too large` | Default cap is 25 MiB; chunk the upload. |
| Tool not visible in client | Confirm you're on the latest `@textral/mcp` and that your client revalidates the tool list per session. |
| `No Textral profile configured` at startup | Either create `~/.textral/profiles.toml` (see "Profiles") or set `TEXTRAL_BASE_URL` + `TEXTRAL_API_KEY` env vars on the launch command. |
| `Profile "X" not found. Available: …` | The named profile isn't in your `~/.textral/profiles.toml`. Check spelling and the `[profiles.<name>]` table headings. |
| `npx -y @textral/mcp` resolves to an old version | npx caches by version; pin with `@textral/mcp@<version>` or run `npx clear-npx-cache`. |
| Permission warning at startup (`mode 0644; recommend chmod 600`) | Run `chmod 600 ~/.textral/profiles.toml` to silence and protect your bearer credentials. |
