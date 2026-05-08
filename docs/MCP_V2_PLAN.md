# MCP V2 — Multi-Profile Stdio Server with Cloudflare Compatibility

> Final design doc. Companion to `docs/roadmap/MCP_ON_CLOUDFLARE.md`,
> which captures the original problem statements + a high-level
> sketch. This doc converges those into a single architectural plan
> covering Cloudflare compatibility, multi-profile addressing, and
> npm distribution. An `MCP_V2_IMPLEMENTATION.md` will derive
> ordered work from this plan.

## Context

Today the `@textral/mcp` stdio server is the only supported MCP
transport. It boots from two env vars (`TEXTRAL_BASE_URL`,
`TEXTRAL_API_KEY`), serves 16 tools / 3 prompts / 3 resources over
stdio, and is added to Claude Code via:

```bash
claude mcp add textral \
  --scope user \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=tx_live_… \
  -- node /absolute/path/to/textral/packages/mcp/bin/textral-mcp.mjs
```

That works for the canonical "one developer, one tenant, has the repo
cloned" path and breaks for everyone else. Three concrete pain points,
all reachable from the same redesign:

1. **CF compatibility unverified.** The CLI is a pure HTTP client, so
   in theory it works against any deployed Textral. We've never
   actually proved it round-trips against the Cloudflare runtime.
2. **One-tenant-per-MCP is the wrong primitive.** Multi-environment
   users (`local-stage` + `hosted-prod` + …) can't address all of
   them from one Claude session without N MCP entries — and N
   entries = N copies of every tool, which both bloats the prompt and
   forces Claude to disambiguate intent on every call.
3. **The install incantation is hostile.** `node /absolute/path/...`
   only works for repo contributors. The package is `"private": true`
   and there's no published binary.

We solve all three together because they share infrastructure (the
bin shim, the package layout, the runtime config-resolution path) and
landing them piecewise would require touching the same files three
times.

## Goals

1. **Empirically verified** Cloudflare-runtime compatibility for every
   shipping MCP tool. Known limitations documented; no silent breakage.
2. **Multi-profile addressing** with **zero LLM token tax** on
   environment disambiguation in the common case. The user flips
   profile explicitly; every subsequent call uses that profile; tool
   schemas don't widen.
3. **One-line install** for non-contributors:
   `claude mcp add textral -- npx -y @textral/mcp`. No clone, no
   absolute paths, no Node version dance.
4. **Backwards compatible** with the existing single-env env-var path
   so today's users see no change after upgrading.

## Non-goals

- **Server-side HTTP transport on CF (`POST /v1/mcp`).** Already 501
  on the Cloudflare runtime in Phase 1. Not scoped here. The stdio
  transport covers Claude Code, Cursor, Windsurf, Cline, and every
  other reachable consumer; the HTTP transport on CF is a separate
  Workers-MCP plumbing problem worth doing only when a concrete
  consumer (Slackbot, hosted Claude.ai integration) appears.
- **Per-OS standalone binaries** (`bun --compile`, `pkg`). Heavier
  maintenance than the user base justifies. Defer indefinitely.
- **OS keychain integration** (`keytar`, macOS Keychain, gnome-keyring,
  Windows Credential Manager). `~/.textral/profiles.toml` with file
  permissions is sufficient for v1.
- **Windows / PowerShell support.** Per the user's roadmap-doc answer:
  WSL Linux or native Linux/macOS only. Windows-native paths are not
  tested.
- **Slash-command UX in Claude Code** (`/textral env stage`). Slash
  commands are user-defined skills and out of our control. The
  user-level UX is "tell Claude to switch", which Claude routes
  through the `textral_set_profile` tool.
- **Per-tool-call profile override parameter.** Adding
  `profile?: string` to every tool input schema is a token tax — even
  when omitted, the schema still costs prompt bytes, and it forces
  the model to think about env on every call. The user has been
  explicit that this is the wrong tradeoff. Cross-env queries are
  expressed as two `set_profile + tool_call` round-trips, not one
  parameter-laden call.
- **Profile sync across machines.** A user with three laptops gets
  three independent `~/.textral/profiles.toml`. Cloud sync via dotfile
  managers is out of scope.

## Decision: stay API-key-first; profiles are the primary multi-env
mechanism

The simplest viable extension to the existing model:

- Profiles live in a single TOML file at a known path.
- Each profile = `{base_url, api_key}` — the same two values today's
  env vars carry, with a name attached.
- The MCP server reads the file at startup, picks an active profile
  (precedence: tightest → loosest), and serves all tool calls against
  that profile.
- The active profile is **mutable mid-session** via a dedicated
  `textral_set_profile` tool. Setting persists for the lifetime of
  the stdio process; new profile dispatch resumes from that.
- The active profile **does not appear** as a parameter on any other
  tool's input schema. Tools see no profile concept at the call site.

This keeps the LLM-prompt surface identical to today (no widened
schemas, no per-call disambiguation) while giving the user a
surgical "switch envs" lever they can request explicitly.

---

# Part A — Cloudflare compatibility verification

## Premise

The stdio MCP is a JSON-RPC server that, for every tool call, forwards
to the Textral REST API via `@textral/sdk`. As long as those REST
endpoints work on the Cloudflare runtime, the MCP tools work. The
question is empirical: which tools' underlying REST paths actually
respond correctly on CF, and which silently 501 / 500 / time out?

Known a priori:
- The HTTP transport (`POST /v1/mcp`) is already 501 on CF. **No
  shipped MCP tool routes through it** — they all hit `/v1/...` REST
  endpoints directly. The 501 is irrelevant for the stdio path.
- Anything Node-runtime-gated (currently: nothing visible in the
  current source, but the audit-write path uses `c.env.bg.spawn`
  which is `NoopBackgroundTasks` on CF — fine).
- AI Gateway routing differs by provider (recently fixed in
  `cloudflare_dep`). Reranker calls work post-fix.

The remaining unknowns are tool-by-tool:

| Tool | Underlying REST | CF-runtime risk |
|---|---|---|
| `list_models` | `GET /v1/models` | low |
| `list_namespaces` | `GET /v1/namespaces` | low |
| `get_namespace` | `GET /v1/namespaces/:slug` | low |
| `create_namespace` | `POST /v1/namespaces` | low (vectorize ensure) |
| `list_documents` | `GET /v1/namespaces/:slug/documents` | low |
| `get_document` | `GET /v1/documents/:id` | low |
| `list_chunks` | `GET /v1/documents/:id/chunks` | low |
| `get_chunk` | `GET /v1/chunks/:id` | low |
| `ingest_file` | upload + finalize + ingest | medium (R2 streaming, container handoff) |
| `query` | `POST /v1/query` | medium (rerank, hybrid retrieval) |
| `get_query_event` | `GET /v1/query-events/:id` | low |
| `get_query_response` | `GET /v1/query-events/:id/response` | low |
| `list_query_events` | `GET /v1/query-events` | low |
| `list_provider_keys` | `GET /v1/provider-keys` | low |
| `register_provider_key` | `POST /v1/provider-keys` | low (Secrets Store write) |
| `list_failing_jobs` | `GET /v1/admin/ingestion-jobs?dead_lettered=1` | low (admin scope) |
| `retry_failing_job` | `POST /v1/ingestion-jobs/:id/retry` | low (admin scope) |

`ingest_file` is the riskiest because it spans the upload-finalize-
ingest stages and exercises Container handoff. `query` is second
because it touches every retrieval+synthesis path.

## Plan

### A.1 — Smoke harness

`apps/api/test/mcp-cf-smoke.test.ts`, gated by `MCP_SMOKE_CF=1`. Test
target: deployed `textral-api-dev` worker URL. Test fixture: an API
key minted against a known dev tenant (provided via `MCP_SMOKE_KEY`
env var, kept out of CI).

Pattern mirrors the existing `live-smoke.test.ts`:

```ts
const SKIP = !process.env.MCP_SMOKE_CF;
describe.skipIf(SKIP)('mcp-cf-smoke', () => { /* one it() per tool */ });
```

Each `it()` constructs a `TextralClient` against the deployed worker
URL and invokes the tool's handler directly (not via stdio). We
bypass the MCP transport because we're testing tool↔REST not the
stdio framing — that's already covered by the existing in-process
MCP tests.

### A.2 — Green-list / red-list outcome

After running the harness, classify each tool:

- **Green:** works on CF unmodified.
- **Yellow:** works with a documented workaround (e.g., "ingest_file
  must use R2-presigned uploads with chunks <X MB").
- **Red:** broken on CF; surface in `docs/mcp/QUICKSTART.md` under a
  "Cloudflare-runtime limitations" section. Block the corresponding
  tool with a clear `NOT_IMPLEMENTED_ON_CF` error in the MCP server
  when the active profile points at a CF backend (detected via
  `runtime: 'cf'` field on the `/v1/me` response, not by URL string
  matching).

We expect 0–2 yellow/red tools max based on the audit above. The
harness runs once at design-validation time and again as a CI gate
post-implementation.

### A.3 — Runtime detection

The MCP server already calls `/v1/me` at startup (or per-profile at
profile-switch time — see Part B). Add `runtime: 'cf' | 'node' |
'self-host'` to the `/v1/me` response if it isn't there already
(verify: `apps/api/src/routes/me.ts` — likely needs a one-line
addition). Cache per-profile in the MCP server so the
`NOT_IMPLEMENTED_ON_CF` check is free.

### A.4 — Documentation

`docs/mcp/QUICKSTART.md` gets a new section:

> ## Cloudflare runtime compatibility
>
> Every MCP tool works against both self-host (Node) and Cloudflare
> deployments, with the following exceptions [list red-list tools or
> "none" if empty].
>
> The server detects the runtime at profile-load time via `/v1/me`
> and surfaces clear errors before dispatch.

---

# Part B — Profile system

## Layout

`~/.textral/profiles.toml`:

```toml
# Optional. The profile selected at server startup if no
# TEXTRAL_PROFILE env var is set. Falls back to the lexicographically
# first profile name when omitted.
default = "local-stage"

[profiles.local-stage]
base_url = "http://localhost:8787"
api_key  = "tx_live_…"

[profiles.local-prod]
base_url = "http://localhost:9000"
api_key  = "tx_live_…"

[profiles.hosted-prod]
base_url = "https://textral-api-dev.leif-e24.workers.dev"
api_key  = "tx_live_…"
```

**Required fields per profile:** `base_url`, `api_key`.
**Optional fields per profile:** none in v1. Reserve room for
`label`, `description`, `tags` later if profile lists get long.

**File location:**
- Linux / WSL / macOS: `~/.textral/profiles.toml`
  (resolved as `path.join(os.homedir(), '.textral', 'profiles.toml')`)
- Override: `TEXTRAL_CONFIG_DIR=/some/path/.textral` env var, useful
  for ephemeral CI / sandboxed test environments.
- Windows native: not supported (per non-goals); WSL users hit the
  Linux path inside the WSL filesystem.

**File permissions:**
- Recommend `chmod 600` (the API keys are bearer credentials).
- The MCP server **warns** on startup if the file is group- or
  world-readable: `[textral-mcp] warning: ~/.textral/profiles.toml
  is mode 0644; recommend chmod 600`.
- Warns, does not refuse — refusing would surprise users in unusual
  setups (shared dotfiles, NFS mounts).

## Resolution

At startup, the MCP server picks the **active profile** by walking
this precedence chain:

1. **`TEXTRAL_PROFILE`** env var on the MCP launch command. Highest
   priority — if set and the named profile exists, win. If set and
   the name is unknown, fail fast with a clear error listing
   available profiles.
2. **`default`** field in the profile file.
3. **First profile** by lexicographic name order in `[profiles.*]`.
4. **Synthesized `_env` profile** from `TEXTRAL_BASE_URL` +
   `TEXTRAL_API_KEY` env vars, if both are set and no profile file
   exists. This is the backwards-compat path.
5. **Hard fail** with a help message pointing at the design doc.

After resolution, the resolved name is logged once to stderr (visible
in the MCP server's process logs but not in MCP messages):

```
[textral-mcp] active profile: hosted-prod (https://textral-api-dev.leif-e24.workers.dev)
```

API key is never logged.

## State machine

The MCP server holds a single mutable `activeProfile: string` field
in `server.ts`. Each tool handler reads it, looks up the
corresponding `(client, audit)` pair from a `Map<profileName, {
client: TextralClient; audit: ApiAuditWriter; runtime: 'cf' | 'node'
}>`, and dispatches.

The map is populated lazily: the active profile is materialized at
startup (and its `/v1/me` probe runs to detect runtime); other
profiles are materialized on first switch. This avoids fan-out probes
to every URL at startup — important for users with profiles pointed
at a deploy that may be down.

**State transitions:**

- **Initial** → resolved active profile from precedence chain.
- **`textral_set_profile({ name })`** called →
  - If `name` not in profiles → return error, **don't** change state.
  - Else → set `activeProfile = name`, lazily materialize the
    `(client, audit, runtime)` triple if not yet cached, return
    `{ active_profile, base_url, runtime }`.
- **End-of-process** → state discarded (process is per-session by
  design).

## Tools added to the MCP surface

Two new tools, both small:

### `textral_set_profile`

Input: `{ name: string }`.

Output: `{ active_profile: string, base_url: string, runtime: 'cf' |
'node' | 'self-host' }`.

Errors:
- `PROFILE_NOT_FOUND` — name doesn't match any profile in the file.
  Error body includes the list of available profile names.
- `PROFILE_PROBE_FAILED` — switch was attempted but the lazy `/v1/me`
  probe against the new base_url failed. The active profile is
  **rolled back** to the prior one. The error includes the upstream
  status / message.

Description (what the LLM reads):

> Switch the active Textral profile. All subsequent tool calls in
> this MCP session will use this profile until it's switched again
> or the session ends. Use this when the user explicitly asks to
> work with a different environment ("switch to stage", "use prod",
> "I'm working with hosted now"). Profile names match the keys
> under `[profiles.*]` in the user's `~/.textral/profiles.toml`.
> Available profiles: [local-stage, local-prod, hosted-prod].

The "Available profiles" list is **interpolated at description-
generation time** so the LLM sees the actual menu without an extra
listing call.

### `textral_get_profile`

Input: `{}`.

Output: `{ active_profile: string, base_url: string, runtime: 'cf' |
'node' | 'self-host', available: string[] }`.

Description:

> Returns the current active Textral profile and the list of
> available profiles. Useful when the user asks "which env am I in"
> or before a destructive operation when you want to confirm the
> target.

No errors aside from the trivial "no profiles configured" case.

## What does NOT change in the tool surface

- Every existing tool (`list_namespaces`, `query`, `ingest_file`, …)
  keeps its current input schema. **No `profile` parameter added
  anywhere.** All dispatch is implicitly via the active profile.
- This is the load-bearing decision. Adding `profile?: string` to
  every tool input would burn prompt tokens on a feature most calls
  don't use, and would force the LLM to think about env on every
  call. The user has explicitly rejected that tradeoff.

## Cross-environment queries (the rare case)

The user asks: "List my namespaces in stage and also in prod."

Claude executes:
1. `textral_set_profile({ name: "local-stage" })`
2. `textral_list_namespaces()` → A
3. `textral_set_profile({ name: "local-prod" })`
4. `textral_list_namespaces()` → B
5. (presents both)

Two extra tool calls per cross-env operation. Acceptable: cross-env
queries are rare; user explicitly invoked them; the tax is bounded
and proportional.

## Audit trail correctness

`ApiAuditWriter` writes audit rows to the *active backend* per call.
Each profile's writer is configured against that profile's
`TextralClient`, so audit writes naturally route to the same backend
as the tool call. The `Map<profileName, ...>` ensures we don't
cross-pollinate (a stage tool call writing audit to prod).

When we mutate `activeProfile`, the next tool call's audit goes to
the new profile's backend. There's no "in-flight" race here because
JS-on-stdio is single-threaded.

## Backwards compatibility

The current pattern:

```bash
claude mcp add textral \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=tx_live_… \
  -- node /path/to/textral-mcp.mjs
```

continues to work unchanged. With no profile file present, the
server synthesizes a `_env` profile from the env vars and runs
identically to today. The `textral_set_profile` tool reports
`["_env"]` as the only available profile; calls to switch to
anything else return `PROFILE_NOT_FOUND`. Existing single-tenant
users see zero behavioral change.

## File-watching and live reloading

**Out of scope for v1.** Profile changes require restarting the MCP
server (Claude Code re-spawns it; user can also run "Restart MCP
servers" from the command palette). File-watching (`fs.watch`) is a
nice future-add but introduces complexity around mid-session profile
churn that we don't need yet.

---

# Part C — Distribution

## Decision: npm publish, public registry, `@textral` org

Three distribution options were considered:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **npm public** | Standard, `npx` works zero-install, automatic updates | Public publishing requires owning `@textral` org name | **Pick this.** |
| **GitHub Packages (private)** | No public exposure | Forces every user to authenticate against GH npm registry — breaks `npx` UX | Reject. |
| **Local-only `npm link`** | No publish step | Requires every user to clone the repo — same problem as today | Reject. |

`@textral/mcp` becomes a public npm package. If the `@textral`
organization on npm is unavailable, fall back to an unscoped name
(`textral-mcp`) with the same install pattern.

## Package layout changes

`packages/mcp/package.json` deltas:

```json
{
  "name": "@textral/mcp",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "bin": { "textral-mcp": "./bin/textral-mcp.mjs" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./http": { "types": "./dist/transport-http.d.ts", "import": "./dist/transport-http.js" }
  },
  "files": ["dist", "bin", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepublishOnly": "pnpm run build",
    ...
  }
}
```

Key changes:
- `"private": false` and `"version": "0.1.0"`.
- New `tsconfig.build.json` that emits to `dist/` (vs the existing
  `tsconfig.json` for typechecking-in-place).
- `"files"` whitelists what ships — keeps `src/` and `test/` out of
  the published tarball.
- `"prepublishOnly"` builds before publish (npm runs this hook
  automatically; pnpm respects it on `pnpm publish`).
- `"main"` and `"types"` point at compiled artifacts so library
  consumers (rare for MCP, but still) don't pull TS source.

### `@textral/contracts` and `@textral/sdk` dependencies

`@textral/mcp` depends on `@textral/contracts` and `@textral/sdk`,
both `workspace:*` today. For publish, we need:

- **Option C1:** publish all three (`@textral/contracts`,
  `@textral/sdk`, `@textral/mcp`) as a coordinated release.
- **Option C2:** bundle the deps into the mcp package's `dist/`
  (e.g., via `tsup` with `--noExternal`).

**Pick C1.** The contracts + SDK packages are the same code consumers
of Textral already need; publishing them is an unblock for downstream
TypeScript users too. The coordinated release is one extra step in
the release script, not a structural problem.

Version pinning: `@textral/mcp` declares `"@textral/contracts":
"^0.1.0"` and `"@textral/sdk": "^0.1.0"` (same major). All three
move together in lockstep until 1.0.

## Bin shim refactor

Today's `bin/textral-mcp.mjs` uses `tsx`'s `tsImport` API to load TS
source at runtime. That breaks when the package is installed from
npm (no source tree, no `tsx` runtime).

New shim — production-first with optional dev fallback:

```js
#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist', 'transport-stdio.js');
const src = resolve(here, '..', 'src', 'transport-stdio.ts');

let startStdio;
if (existsSync(dist)) {
  ({ startStdio } = await import(pathToFileURL(dist).href));
} else if (existsSync(src)) {
  // Dev mode — repo contributor running from source. Requires
  // tsx as a dev dependency. Never reached in published installs.
  const { tsImport } = await import('tsx/esm/api');
  ({ startStdio } = await tsImport(pathToFileURL(src).href, import.meta.url));
} else {
  console.error('[textral-mcp] neither dist/ nor src/ found; install is broken');
  process.exit(1);
}

await main(); // resolves config + calls startStdio({...})
```

The dev branch is gated by `existsSync(src)` so a published install
never tries to require `tsx` (which isn't a runtime dep anymore).

## Build pipeline

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": false,
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["test/**/*", "**/*.test.ts"]
}
```

Build is plain `tsc`. No bundling. Why no bundler:
- The package has 3 runtime deps (`@modelcontextprotocol/sdk`,
  `@textral/contracts`, `@textral/sdk`, `zod`,
  `zod-to-json-schema`); all stay external.
- Bundling adds toolchain (esbuild / tsup / rollup) and obscures
  stack traces. `tsc` output is fine for stdio servers.

The repo's existing `pnpm build` recursive script runs this build
when invoked.

## Versioning + release

- Start at `0.1.0`. Treat 0.x as pre-stable; document that breaking
  changes can land in any minor until `1.0`.
- Tag releases as `mcp-v0.1.0` etc. (per-package tags) so the repo's
  git log keeps the per-package history clean.
- Cut releases manually for v1; automate later if cadence justifies it.

## The new install incantation

Three blessed forms, in order of preference:

```bash
# Zero-install, latest version on every spawn (recommended)
claude mcp add textral --scope user -- npx -y @textral/mcp

# Pinned version
claude mcp add textral --scope user -- npx -y @textral/mcp@0.1.0

# Globally installed (if user wants spawn speed)
npm install -g @textral/mcp
claude mcp add textral --scope user -- textral-mcp
```

The `npx -y @textral/mcp` form is what we put in every doc surface
(`docs/mcp/QUICKSTART.md`, `README.md`, the Scalar `MCP` tag block,
the post-redeem panel in the sandbox once that ships).

`TEXTRAL_BASE_URL` / `TEXTRAL_API_KEY` env vars become **legacy**
single-profile config; `--env TEXTRAL_PROFILE=hosted-prod` becomes
the canonical multi-profile config alongside a `~/.textral/profiles
.toml`.

---

## Locked-in choices summary

| Concern | Choice | Rationale |
|---|---|---|
| **Profile config location** | `~/.textral/profiles.toml` | Standard dotfile, predictable, overridable via `TEXTRAL_CONFIG_DIR`. |
| **Profile file format** | TOML | Human-friendly nested-section syntax; standard library support in the Node TOML parser. JSON works but reads worse for this shape. |
| **Profile state** | Process-local mutable `activeProfile` | Stdio servers are per-session; no inter-session race. Simplest model that works. |
| **Profile switching** | `textral_set_profile` tool | LLM-driven, explicit, no ambient ambiguity. |
| **Per-call profile override** | None | User-explicit decision. Avoids prompt-tax. Cross-env handled via two switches. |
| **Resolution precedence** | `TEXTRAL_PROFILE` env > file `default` > lex-first > `_env` synth > fail | Tightest-wins; backwards-compat with old env vars. |
| **Lazy profile materialization** | First-touch | No fan-out at startup; survives partially-down deploys. |
| **Runtime detection** | `/v1/me` probe at materialize time, cached per profile | One round-trip per profile, surfaces dead profiles fast. |
| **CF compat verification** | `MCP_SMOKE_CF=1`-gated test against deployed dev | Empirical, repeatable, CI-able. |
| **Distribution** | Public npm `@textral/mcp` | `npx` works zero-install; standard ecosystem path. |
| **Coordinated release** | `@textral/contracts` + `@textral/sdk` + `@textral/mcp` together | All public, lockstep majors until 1.0. |
| **Bin shim mode** | Production-first (`dist/`); dev fallback to `tsx` if `src/` exists | Both worlds work; published installs never load `tsx`. |
| **Build tool** | Plain `tsc` to `dist/` | No bundler; stack traces stay clean; deps stay external. |
| **Versioning** | 0.1.0 start; 0.x = pre-stable | Honest about API stability for the first releases. |
| **Audit trail per profile** | One `ApiAuditWriter` per materialized profile | Rows write to the active backend; no cross-pollination. |
| **HTTP transport on CF** | Out of scope | Deferred; stdio covers all current consumers. |
| **Per-OS standalone binaries** | Out of scope | Maintenance burden unjustified. |
| **Windows native** | Out of scope | WSL / Linux / macOS only. |
| **OS keychain integration** | Out of scope | TOML + `chmod 600` warning is sufficient. |
| **Profile sync across machines** | Out of scope | User's dotfile manager handles it. |
| **Live profile-file reloading** | Out of scope | Restart-on-change is acceptable in v1. |

---

## Recommended sequencing

1. **Part A (CF smoke harness)** — small, no design risk, gives us
   ground-truth before committing to design changes downstream. Runs
   in isolation against the existing single-env MCP code.
2. **Part C (npm publish + bin shim refactor)** — unblocks every
   external user, deletes the `node /absolute/path` from every doc
   surface, and is independent of profiles. Ship before B because
   the install surface is the bigger external pain.
3. **Part B (profiles)** — the largest design lift. Builds on the
   shipped binary from Part C; users who don't need profiles see no
   change.

A/C/B is the sequence the implementation plan should follow. They
share infrastructure (the bin shim is touched in C, then refactored
again in B; the runtime detection in A is reused as the `/v1/me`
probe in B), so doing them out of order would force rework.

---

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `@textral` npm org name unavailable | Low–Medium | Fall back to unscoped `textral-mcp`. Same install ergonomics. |
| Published `@textral/sdk` or `@textral/contracts` breaks downstream consumers | Low | Both are workspace-internal today; declaring them public is additive. Pin `^0.x` in `@textral/mcp` to insulate from accidental breaking changes. |
| Profile file format drift between v1 and v2 | Low | TOML is forgiving. New fields are optional. We commit to never reading a key the user didn't set. |
| User commits `~/.textral/profiles.toml` to git by accident | Medium | Document in `docs/mcp/QUICKSTART.md`; recommend `chmod 600`; warn at startup if mode is too loose. |
| `textral_set_profile` LLM prompt drift over time | Medium | The "Available profiles: [...]" interpolation pins the menu; if the user mistypes, `PROFILE_NOT_FOUND` gives a clear error with the canonical list. |
| Cross-env query takes 2 round-trips and feels slow | Low | Acceptable cost; cross-env queries are user-explicit and rare. If pain emerges, revisit per-call override in v2. |
| Stdio process restart on profile-file edit confuses users | Low | Document. Restart-on-edit is standard for MCP servers; Claude Code has a "Restart MCP servers" command. |
| `MCP_SMOKE_CF` test pulls from a live tenant and accidentally writes garbage data | Medium | Use a dedicated `mcp-smoke` namespace inside a dedicated test tenant; tear down between runs. |
| Tool description truncated by some MCP client when "Available profiles" list is long | Low | Cap at 10 profiles in the description; full list is always available via `textral_get_profile`. |

---

## Out of scope / future work

- **Server-side HTTP MCP transport on Cloudflare** — separate
  Workers-MCP plumbing. Track as a follow-up if a hosted consumer
  (Slackbot, Claude.ai integration, etc.) needs it.
- **Profile sync / OS keychain / encrypted profile storage** — TOML
  + `chmod 600` is fine for v1; revisit when the user base or threat
  model changes.
- **Per-call profile override (`profile?: string` parameter)** —
  rejected as a design choice. Re-evaluate only if the cross-env
  use case becomes common enough to justify the prompt tax.
- **Live profile-file reloading** — stdio process restart is
  acceptable today.
- **`textral_create_profile` / `textral_remove_profile` tools** —
  letting the LLM mutate the profile file feels like a sharp edge.
  Defer until there's a clear need; for now, `~/.textral/profiles
  .toml` is human-edited.
- **Standalone single-file binaries** — only worth it for
  non-developer audiences; revisit if Textral acquires those.
- **`@textral/cli`** as a generalized command-line for non-MCP use —
  separate package, separate plan.
- **Profile import/export tooling** — useful but not load-bearing.
- **Profile tags / categories** — keys like `prod=true`,
  `region=eu` for fancier addressing. Defer until a concrete use
  case appears.

---

## Work-product checklist

Cross-cutting deliverables. The implementation plan will sequence
these across phases.

- [ ] Part A — CF smoke harness in `apps/api/test/mcp-cf-smoke.test.ts`
- [ ] Part A — `runtime` field on `/v1/me` response (verify present)
- [ ] Part A — Tool-by-tool green/yellow/red classification in
      `docs/mcp/QUICKSTART.md`
- [ ] Part C — `tsconfig.build.json` + `dist/` build pipeline
- [ ] Part C — Bin shim refactor (production-first, dev fallback)
- [ ] Part C — Coordinated 0.1.0 publish of contracts + sdk + mcp
- [ ] Part C — Doc updates: every surface that says
      `node /absolute/path/...` switches to `npx -y @textral/mcp`
- [ ] Part B — TOML parser + profile loader
- [ ] Part B — `~/.textral/profiles.toml` schema + permission warning
- [ ] Part B — `textral_set_profile` + `textral_get_profile` tools
- [ ] Part B — Per-profile `(client, audit, runtime)` Map in
      `server.ts`
- [ ] Part B — Backwards-compat `_env` synth profile
- [ ] Part B — Tool description "Available profiles: [...]"
      interpolation
- [ ] Part B — `docs/mcp/QUICKSTART.md` profile config + multi-env UX
- [ ] Tests — every new code path has unit coverage
- [ ] Manual — at least three concurrent profiles tested end-to-end
      against deployed dev + a self-host stack
