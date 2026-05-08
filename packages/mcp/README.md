# @textral/mcp

MCP (Model Context Protocol) server for [Textral](https://github.com/alacrity-ai/TextralAI). Stdio transport; multi-profile addressing; works against Cloudflare and self-host deployments.

## Install

```bash
claude mcp add textral --scope user -- npx -y @textral/mcp
```

That's it. `npx` resolves the latest version on every spawn — no clone, no global install, no Node version dance. The package targets Node ≥ 22 (24 recommended).

For Cursor / Windsurf / Cline / any other MCP client, the equivalent JSON config:

```json
{
  "mcpServers": {
    "textral": {
      "command": "npx",
      "args": ["-y", "@textral/mcp"]
    }
  }
}
```

## Configure

Two paths, depending on whether you address one Textral or several.

### One Textral (single-profile, env-var path)

Set the base URL and API key on the MCP launch command:

```bash
claude mcp add textral --scope user \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=tx_live_… \
  -- npx -y @textral/mcp
```

The MCP server boots with a synthetic `_env` profile pulled from those env vars. Existing single-tenant users see no behavioral change.

### Multiple Textrals (profile-file path)

Drop a `~/.textral/profiles.toml`:

```toml
default = "hosted-prod"

[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_…"

[profiles.hosted-prod]
base_url = "https://textral-api-dev.leif-e24.workers.dev"
api_key  = "tx_live_…"
```

Then add the MCP without env vars:

```bash
claude mcp add textral --scope user -- npx -y @textral/mcp
```

The server reads the file at startup, picks an active profile, and serves all subsequent tool calls against it.

**Resolution precedence:**

1. `TEXTRAL_PROFILE=name` env var on the MCP launch command (tightest)
2. `default = "name"` field in the profile file
3. Lexicographically first profile name in `[profiles.*]`
4. Synthesized `_env` profile from `TEXTRAL_BASE_URL` + `TEXTRAL_API_KEY` (only when no profile file exists)
5. Hard fail with a help message

**Recommended:** `chmod 600 ~/.textral/profiles.toml`. The server warns at startup if the file is group- or world-readable; the API keys are bearer credentials.

### Switching profiles mid-session

Two new tools are exposed:

- `textral_get_profile` — returns the active profile + the available list. Useful for "which env am I in?"
- `textral_set_profile({ name })` — flips the active profile. All subsequent tool calls use the new profile. Probe-fails atomically: a bad switch leaves the prior profile active.

Cross-environment queries are expressed as two tool calls:

```
User: "List my namespaces in stage and in prod."
  → textral_set_profile({ name: "local-stage" })
  → textral_list_namespaces()
  → textral_set_profile({ name: "hosted-prod" })
  → textral_list_namespaces()
```

There is **no** per-call `profile?: string` parameter on tool inputs. The user-explicit decision is to keep the prompt surface lean and avoid forcing the model to disambiguate environment on every call.

## Tool surface

`@textral/mcp@0.1.0` ships 17 tools, 3 workflow prompts, and 3 read-only resources. Every tool routes through Textral's REST API, so tenant scoping, redaction, and audit policies apply identically to direct REST.

| Surface | Tools |
|---|---|
| Profile control | `textral_get_profile`, `textral_set_profile` |
| Namespaces | `create_namespace`, `list_namespaces`, `get_namespace` |
| Documents + ingest | `ingest_file`, `list_documents`, `get_document`, `list_chunks`, `get_chunk` |
| Query | `query`, `list_query_events`, `get_query_event`, `get_query_response` |
| Provider keys (BYOK) | `register_provider_key`, `list_provider_keys` |
| Operations | `list_failing_jobs`, `retry_failing_job` |
| Meta | `list_models` |

`ingest_file` is the headline: register → upload → finalize → ingest, one call. Pass `wait=true` to block until the resulting ingestion job reaches a terminal state, with progress notifications emitted on every stage transition. File content goes in as base64 bytes — the MCP server never reads the local filesystem.

## Cloudflare runtime compatibility

Every tool works against both self-host (Node) and Cloudflare deployments. The server detects the runtime at profile-load time via `/v1/me`'s `runtime: 'cf' | 'node'` field.

The HTTP transport (`POST /v1/mcp`) is only available on the Node self-host runtime; the stdio transport covers every MCP client (Claude Code, Cursor, Cline, Windsurf, …) against any HTTPS Textral URL.

For the full green-list and re-run instructions, see [`docs/mcp/QUICKSTART.md`](https://github.com/alacrity-ai/TextralAI/blob/main/docs/mcp/QUICKSTART.md).

## Versioning

`@textral/mcp` ships in lockstep with `@textral/contracts` and `@textral/sdk`; treat 0.x as pre-stable.

## License

MIT
