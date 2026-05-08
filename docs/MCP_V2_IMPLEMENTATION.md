# MCP V2 — Implementation Steps

> Companion to `docs/MCP_V2_PLAN.md`. Concrete, ordered steps for
> shipping the three-part redesign (CF compatibility, npm
> distribution, multi-profile addressing). Three independently-
> mergeable phases — A, C, B — sequenced so shared infrastructure is
> laid down before the steps that depend on it.

---

**At completion, you will have:**

- A live `MCP_SMOKE_CF=1`-gated test that exercises every shipping
  MCP tool against the deployed Cloudflare worker and pins a green
  list of working tools.
- A `runtime` field on `GET /v1/me` so the MCP server can detect
  CF vs Node at profile-load time without URL string-matching.
- `@textral/contracts`, `@textral/sdk`, and `@textral/mcp` published
  to npm at `0.1.0`, coordinated.
- A bin shim that loads from `dist/` for published installs and
  falls back to `tsx` for repo contributors.
- A canonical install line of `claude mcp add textral -- npx -y
  @textral/mcp` everywhere the docs reference it.
- A working `~/.textral/profiles.toml` config + two new tools
  (`textral_set_profile`, `textral_get_profile`) and a per-profile
  `(client, audit, runtime)` cache inside the MCP server.
- Backwards compatibility for users still on the env-var single-
  profile path — zero behavioral change for them.

By the end of this plan, a non-contributor can paste one shell
command and have a working MCP server pointed at a Cloudflare
deployment, and a multi-environment power user can flip between
profiles mid-session with one explicit instruction.

---

## What this plan specifically does NOT do

- **No server-side HTTP MCP transport on CF.** Decided in
  `MCP_V2_PLAN.md` non-goals. The 501 on `POST /v1/mcp` for the CF
  runtime stays as-is.
- **No standalone single-file binaries.** `bun --compile` / `pkg`
  are deferred indefinitely.
- **No OS keychain integration.** TOML + `chmod 600` warning
  suffices.
- **No Windows-native support.** WSL / Linux / macOS only.
- **No live profile-file reloading.** Restart-on-edit is acceptable.
- **No per-call `profile?: string` parameter on tools.** Explicitly
  rejected in the plan.
- **No file-watching / auto-reconnect on profile-file changes.**
- **No new MCP capabilities** (resources, prompts, tools beyond
  `set_profile` + `get_profile`).

---

## Prerequisites

- Tenant Registration A/B/C is shipped (Phase B's audit-trail
  per-profile design touches the same `ApiAuditWriter` that the
  registration flow has been touching).
- `cloudflare_dep` branch deployed to dev; smoke harness will hit it.
- A dedicated `mcp-smoke` test tenant on the deployed dev worker.
  Mint via the new self-service registration flow with a known
  email like `mcp-smoke@alacrity.ai`.
- npm account with publish rights to `@textral` org (or fallback
  unscoped names secured).
- `pnpm` and Node 24.

---

## Locked-in technology choices

Implementation-level. Architectural choices live in `MCP_V2_PLAN.md`.

| Concern | Choice | Rationale |
|---|---|---|
| Smoke test runner | **vitest with `cloudflare:test` pool**, gated by `MCP_SMOKE_CF=1` | Reuses the existing pool; pattern mirrors `live-smoke.test.ts`. |
| Smoke fixture data | **Pre-seeded `mcp-smoke` namespace + one tiny fixture document** | Idempotent setup; tear down between runs via `make seed-mcp-smoke`. |
| TOML parser | **`smol-toml`** (small, ESM-native, zero deps) | Standard-library `parseTOML` not yet stable in Node 24. `smol-toml` is ~5KB and battle-tested by `prettier`. Alternative: `@iarna/toml` (more popular, larger). Pick `smol-toml` for the lower dep weight. |
| Build tool | **Plain `tsc`** to `dist/` | Per plan §Part C. No bundler. |
| Bin shim mode-detection | **`fs.existsSync(dist)` over env-var heuristic** | Filesystem fact is more reliable than guessing from `NODE_ENV`. |
| Profile state location | **`server.ts` module scope (`activeProfile: string`)** | Per-process; matches stdio's per-session lifecycle. |
| Profile cache | **`Map<string, ProfileBinding>`** keyed by profile name | First-touch materialization; survives partially-down deploys. |
| `textral_set_profile` rollback on probe failure | **Yes** — restore prior `activeProfile` before throwing | Avoids leaving the server in a half-switched state. |
| Tool description interpolation | **At server-create time, not at each call** | Profile list is stable per-process; re-interpolating per-call is wasted work. |
| `textral_get_profile` always available | **Yes** — even when only the synth `_env` profile exists | Reads back current state; useful even in single-profile mode. |
| Audit writer per-profile | **One `ApiAuditWriter` per materialized profile** | Plan §Part B. No cross-pollination. |
| `MCP_SMOKE_CF` test isolation | **Skips when env unset** (`describe.skipIf`) | Default-off keeps `pnpm test` fast; same pattern as `live-smoke.test.ts`. |
| Coordinated release | **Manual `pnpm publish` per package, three commands** | One-time-per-release; no release script for v0.1.0. Automate later. |

---

## Naming and locations

```
apps/api/
├── src/
│   └── routes/me.ts                                ← MODIFIED (A.2)
├── test/
│   └── mcp-cf-smoke.test.ts                        ← NEW (A.1)
docs/
├── MCP_V2_PLAN.md                                  ← (already exists)
├── MCP_V2_IMPLEMENTATION.md                        ← THIS FILE
├── mcp/QUICKSTART.md                               ← MODIFIED (A.4, B.8, C.6)
└── runbooks/MCP_RELEASE.md                         ← NEW (C.5)
packages/contracts/
├── package.json                                    ← MODIFIED (C.4)
└── src/...                                         ← MeResponse type touched (A.2)
packages/sdk/
└── package.json                                    ← MODIFIED (C.4)
packages/mcp/
├── package.json                                    ← MODIFIED (C.3)
├── tsconfig.build.json                             ← NEW (C.1)
├── README.md                                       ← NEW or REWRITTEN (C.6)
├── bin/textral-mcp.mjs                             ← REFACTORED (C.2)
├── src/
│   ├── profiles.ts                                 ← NEW (B.1)
│   ├── server.ts                                   ← MODIFIED (B.3)
│   ├── transport-stdio.ts                          ← MODIFIED (B.3)
│   └── tools/profile-tools.ts                      ← NEW (B.4)
└── test/
    ├── profiles.test.ts                            ← NEW (B.7)
    └── set-profile.test.ts                         ← NEW (B.7)
```

---

# Phase A — Cloudflare compatibility verification

Empirical groundwork. No architectural changes; classifies tools and
documents limitations. Mergeable on its own. Drives whether B/C need
to ship around any red-list tools.

### Step A.1 — `mcp-cf-smoke.test.ts` harness

**A.1.1** New test file `apps/api/test/mcp-cf-smoke.test.ts`. Gated:

```ts
const SKIP = !process.env.MCP_SMOKE_CF;
const baseUrl = process.env.MCP_SMOKE_BASE_URL ?? 'https://textral-api-dev.leif-e24.workers.dev';
const apiKey = process.env.MCP_SMOKE_KEY;

describe.skipIf(SKIP)('mcp-cf-smoke', () => {
  if (!apiKey) {
    it.skip('MCP_SMOKE_KEY required', () => {});
    return;
  }
  // ... per-tool it() blocks
});
```

**A.1.2** Setup phase (run once before all tests via `beforeAll`):
- Construct `TextralClient({ baseUrl, apiKey })`.
- Verify `/v1/me` returns the expected tenant.
- Ensure a `mcp-smoke` namespace exists; if not, create it
  (vectorize backend on CF). Idempotent.
- Ensure one tiny narrative fixture document exists; if not,
  upload-finalize.

**A.1.3** One `it()` block per tool from the inventory in
`MCP_V2_PLAN.md` §Part A. Each invokes the tool's underlying SDK
method directly (not via the MCP transport). Order them
non-destructive-first:

1. `list_models`, `list_namespaces`, `get_namespace`,
   `list_documents`, `get_document`, `list_chunks`, `get_chunk`,
   `list_query_events`, `list_provider_keys`, `list_failing_jobs`
2. `query` (depends on the seed namespace + document being
   indexed)
3. `get_query_event`, `get_query_response` (use the event id
   returned from the query above)
4. `register_provider_key`, `ingest_file` (writes — each cleans up
   after itself)
5. `retry_failing_job` — skip if no DLQ'd job exists; document as
   conditional.

**A.1.4** Each `it()` asserts:
- The call returns a 2xx with the expected response shape.
- No `NOT_IMPLEMENTED` / `501` / network error.

**A.1.5** Failure handling: any tool that breaks gets logged with
its REST endpoint, status, and body excerpt. Don't crash the suite —
let every tool report independently so we get a full red-list in one
pass.

**Exit criteria for A.1**
- The test runs green when invoked as
  `MCP_SMOKE_CF=1 MCP_SMOKE_KEY=tx_live_… pnpm --filter @textral/api test mcp-cf-smoke`.
- Wall-clock under 4 minutes.
- The output yields a definitive pass/fail per tool.

---

### Step A.2 — `runtime` field on `/v1/me`

**A.2.1** Read `apps/api/src/routes/me.ts` to confirm whether
`runtime` is already on the response. If yes — no work; jump to A.3.
If no:

**A.2.2** Add `runtime: 'cf' | 'node'` to the `MeResponse` Zod schema
in `packages/contracts/src/...` (or wherever it lives) and to the
`MeResponse` openapi component in `apps/api/src/openapi/components.ts`.
Plumb through the route handler — set from `c.env.runtime` (CF
binding) or `'node'` for the Node runtime path. The sandbox
`MeResponse` already has `runtime?: 'cf' | 'node'` per the
conversation summary; verify it's actually populated by the API.

**A.2.3** Update `@textral/sdk` `Client.me()` return type to include
`runtime`.

**A.2.4** Test: bump an existing me-route test to assert the
`runtime` field is present and matches the expected runtime.

**Exit criteria for A.2**
- `GET /v1/me` against deployed dev returns `{ runtime: 'cf', ... }`.
- `GET /v1/me` against `make selfhost-up` returns `{ runtime: 'node', ... }`.
- All existing me-route tests still green.

---

### Step A.3 — Tool classification + red-list handling

**A.3.1** Run the harness from A.1 against deployed dev. Capture the
output. Classify each tool: green / yellow / red.

**A.3.2** For each **red** tool (expected: zero, but reserve the
pattern in case `ingest_file` or `query` exposes a CF-specific bug):
- Open a follow-up issue with the failing endpoint, status, and
  body.
- In `packages/mcp/src/tools/<tool>.ts`, gate the handler with a
  runtime-aware refusal:

```ts
if (binding.runtime === 'cf') {
  throw new Error(
    `${toolName} is not yet supported on the Cloudflare runtime. ` +
    `See https://github.com/.../issues/<n> for status. ` +
    `Switch to a self-host profile to use this tool.`
  );
}
```

The runtime is read from the per-profile binding cache (which we
build in B.3; for A.3 it can read from the single-tenant
`/v1/me`-probed value).

**A.3.3** For each **yellow** tool, document the workaround in the
QUICKSTART (A.4).

**A.3.4** **Green case (the expected outcome):** classify all 16
tools as green; A.3 becomes a one-line commit confirming the
harness output.

**Exit criteria for A.3**
- A green/yellow/red list committed to a markdown table in
  `docs/mcp/QUICKSTART.md` (A.4).
- Any red-listed tool refuses on CF with a clear error.

---

### Step A.4 — Documentation

**A.4.1** Add a "Cloudflare runtime compatibility" section to
`docs/mcp/QUICKSTART.md` near the top:

> ## Cloudflare runtime compatibility
>
> Every `@textral/mcp` tool works against both self-host (Node) and
> Cloudflare deployments, with the following exceptions:
>
> | Tool | Status | Notes |
> |---|---|---|
> | (typically empty post-A.3) | | |
>
> The server detects the runtime at profile-load time via `/v1/me`
> and surfaces clear errors before dispatching any unsupported tool.

**A.4.2** Update the Scalar `MCP` tag block in
`apps/api/src/openapi/tag-descriptions.ts` if the existing copy
asserts CF-specific limitations that A.3 has now refuted.

**Exit criteria for A.4**
- Markdown links resolve.
- The QUICKSTART table reflects the actual A.3 outcome.

---

# Phase C — Distribution

Publishes the three workspace packages so external users can
`npx -y @textral/mcp`. No new functionality; deletes the
`node /absolute/path/...` install footgun. Mergeable on its own.

### Step C.1 — `tsconfig.build.json` + build script

**C.1.1** New file `packages/mcp/tsconfig.build.json`:

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

**C.1.2** Add `"build": "tsc -p tsconfig.build.json"` to
`packages/mcp/package.json` scripts.

**C.1.3** Add `dist/` to the package's `.gitignore` (or the
top-level one if it doesn't already cover it).

**C.1.4** Run `pnpm --filter @textral/mcp build` once. Verify
`dist/` populates with `transport-stdio.js`, `server.js`, etc.

**C.1.5** Sister `tsconfig.build.json` files for `@textral/contracts`
and `@textral/sdk`, identical pattern. Add `"build"` scripts.

**Exit criteria for C.1**
- All three packages produce a clean `dist/` on `pnpm build`.
- `dist/` is gitignored.

---

### Step C.2 — Bin shim refactor

**C.2.1** Replace `packages/mcp/bin/textral-mcp.mjs` with the
production-first / dev-fallback shape from `MCP_V2_PLAN.md` §Part C:

```js
#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist', 'transport-stdio.js');
const src  = resolve(here, '..', 'src', 'transport-stdio.ts');

let startStdio;
if (existsSync(dist)) {
  ({ startStdio } = await import(pathToFileURL(dist).href));
} else if (existsSync(src)) {
  const { tsImport } = await import('tsx/esm/api');
  ({ startStdio } = await tsImport(pathToFileURL(src).href, import.meta.url));
} else {
  console.error('[textral-mcp] neither dist/ nor src/ found; install is broken');
  process.exit(1);
}

// Phase B replaces the env-var-only boot with profile resolution.
// Until B lands, keep the existing boot logic (TEXTRAL_BASE_URL +
// TEXTRAL_API_KEY → startStdio({ baseUrl, apiKey })).
const baseUrl = process.env.TEXTRAL_BASE_URL;
const apiKey  = process.env.TEXTRAL_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('@textral/mcp: TEXTRAL_BASE_URL and TEXTRAL_API_KEY required');
  process.exit(1);
}
await startStdio({ baseUrl, apiKey });
```

**C.2.2** Move `tsx` from `dependencies` to `devDependencies` in
`packages/mcp/package.json` if not already there. Published installs
won't pull `tsx`.

**C.2.3** Manual smoke: `pnpm --filter @textral/mcp build && node
packages/mcp/bin/textral-mcp.mjs` — verify it boots from `dist/`.
Then `rm -rf packages/mcp/dist && node packages/mcp/bin/textral-mcp
.mjs` — verify it falls through to `tsx` from source.

**Exit criteria for C.2**
- Both modes boot identically.
- No `tsx` in published install's `node_modules` (verify by inspecting
  the produced tarball with `pnpm pack`).

---

### Step C.3 — `@textral/mcp` package.json for publishing

**C.3.1** Edit `packages/mcp/package.json`:

```json
{
  "name": "@textral/mcp",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "description": "MCP (Model Context Protocol) server for Textral. Stdio transport; multi-profile addressing; works against Cloudflare and self-host deployments.",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/<org>/textral",
    "directory": "packages/mcp"
  },
  "homepage": "https://github.com/<org>/textral/tree/main/packages/mcp#readme",
  "bin": { "textral-mcp": "./bin/textral-mcp.mjs" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".":     { "types": "./dist/index.d.ts",          "import": "./dist/index.js" },
    "./http":{ "types": "./dist/transport-http.d.ts", "import": "./dist/transport-http.js" }
  },
  "files": ["dist", "bin", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepublishOnly": "pnpm run build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "engines": { "node": ">=22" }
}
```

**C.3.2** `repository.url` placeholder gets the actual URL at publish
time. Until then, leave the `<org>` token; publishing fails fast if
it isn't replaced (npm validates).

**C.3.3** Add `README.md` at `packages/mcp/README.md` (replaces the
empty stub if present). Content sketch:

```markdown
# @textral/mcp

MCP server for Textral. Run via:

\`\`\`bash
claude mcp add textral --scope user -- npx -y @textral/mcp
\`\`\`

Configure with `~/.textral/profiles.toml`. See
[docs/mcp/QUICKSTART.md](https://github.com/.../docs/mcp/QUICKSTART.md).
```

(Until Phase B ships, the README points at the env-var configuration
path; B updates it.)

**C.3.4** `pnpm pack --dry-run` to see what would ship. Confirm only
`dist/`, `bin/`, `README.md`, `package.json` make it. No source, no
tests.

**Exit criteria for C.3**
- Tarball contents are minimal.
- `pnpm publish --dry-run` succeeds.

---

### Step C.4 — `@textral/contracts` and `@textral/sdk` for publishing

**C.4.1** Same package.json updates for both: drop `"private": true`,
set `"version": "0.1.0"`, add `repository`, `homepage`, `license`,
`engines.node`, `files`, `exports`.

**C.4.2** `@textral/sdk` declares `"@textral/contracts": "^0.1.0"`
(not `workspace:*`) — pnpm rewrites this on publish anyway, but make
the intent explicit.

**C.4.3** `@textral/mcp` declares `"@textral/contracts": "^0.1.0"`
+ `"@textral/sdk": "^0.1.0"`.

**C.4.4** Verify each package builds + packs in isolation.

**Exit criteria for C.4**
- All three packages produce valid tarballs.
- The dependency chain in the tarballs uses semver ranges, not
  `workspace:*`.

---

### Step C.5 — Coordinated `0.1.0` publish

**C.5.1** Author `docs/runbooks/MCP_RELEASE.md` capturing the order:

```
1. ./scripts/release.sh contracts 0.1.0    # tags + publishes
2. ./scripts/release.sh sdk 0.1.0
3. ./scripts/release.sh mcp 0.1.0
4. Verify on npm: open https://npmjs.com/package/@textral/{contracts,sdk,mcp}
5. Smoke install: cd /tmp && npx -y @textral/mcp@0.1.0
```

The `release.sh` script (or just inline commands; for v0.1.0 a
script is overkill) does:

```bash
cd packages/$1
pnpm version $2 --no-git-tag-version
git add package.json && git commit -m "release: @textral/$1@$2"
git tag "$1-v$2"
pnpm publish --access public
git push --tags
cd -
```

**C.5.2** Run the three publishes against npm. Use `npm whoami` to
confirm auth. If `@textral` org is unavailable, fall back to
unscoped `textral-mcp` / `textral-sdk` / `textral-contracts` with
the same flow — update package names + cross-references first, then
publish.

**C.5.3** Smoke against the published packages from a clean directory:

```bash
cd /tmp/clean
TEXTRAL_BASE_URL=https://textral-api-dev.leif-e24.workers.dev \
TEXTRAL_API_KEY=tx_live_… \
  npx -y @textral/mcp
```

Should boot, list tools (capability handshake), respond to a
sample tool call.

**Exit criteria for C.5**
- All three packages live on npm at `0.1.0`.
- `npx -y @textral/mcp` works from a directory with no Textral
  source.
- Git tags pushed.

---

### Step C.6 — Doc updates: kill the absolute-path incantation

**C.6.1** Replace every `node /absolute/path/...` reference with
`npx -y @textral/mcp`:

- `docs/mcp/QUICKSTART.md`
- Any `README.md` that mentions the install
- `docs/roadmap/MCP_ON_CLOUDFLARE.md` — leave the historical context
  intact but add a note at the top: "✓ Resolved by MCP V2 (see
  `docs/MCP_V2_PLAN.md`); the install incantation below is
  superseded."
- The Scalar `MCP` tag block in
  `apps/api/src/openapi/tag-descriptions.ts`
- Any seed / quickstart scripts (`make seed-self-host` output,
  the post-redeem panel in the sandbox)

**C.6.2** Search for the pattern: `grep -rn "textral-mcp.mjs\|node.*packages/mcp" --include="*.md" --include="*.ts" --include="*.tsx"` — every hit gets reviewed.

**Exit criteria for C.6**
- `grep` for `node /absolute/path` in docs returns nothing.
- The new install incantation appears in at least 4 places (root
  README, mcp QUICKSTART, Scalar tag, package README).

---

# Phase B — Profiles

Multi-profile addressing with explicit switching. Builds on the
shipped binary from Phase C; users who don't need profiles see no
change. This is the largest design lift.

### Step B.1 — Profile loader

**B.1.1** New file `packages/mcp/src/profiles.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

export interface Profile {
  name: string;
  base_url: string;
  api_key: string;
}

export interface ProfileFile {
  default?: string;
  profiles: Map<string, Profile>;
}

const FILE_NAME = 'profiles.toml';

export function configDir(): string {
  return process.env.TEXTRAL_CONFIG_DIR ?? join(homedir(), '.textral');
}

export function configPath(): string {
  return join(configDir(), FILE_NAME);
}

export async function loadProfileFile(): Promise<ProfileFile | null> {
  const path = configPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }

  // Permissions warning — non-fatal.
  try {
    const st = await stat(path);
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      console.error(
        `[textral-mcp] warning: ${path} is mode 0${mode.toString(8)}; recommend chmod 600`,
      );
    }
  } catch {
    /* ignore */
  }

  const toml = parse(raw) as { default?: string; profiles?: Record<string, Profile> };
  if (!toml.profiles || typeof toml.profiles !== 'object') {
    throw new Error(`${path}: missing [profiles.*] table`);
  }
  const profiles = new Map<string, Profile>();
  for (const [name, body] of Object.entries(toml.profiles)) {
    if (!body.base_url || typeof body.base_url !== 'string') {
      throw new Error(`${path}: profile "${name}" missing base_url`);
    }
    if (!body.api_key || typeof body.api_key !== 'string') {
      throw new Error(`${path}: profile "${name}" missing api_key`);
    }
    profiles.set(name, { name, base_url: body.base_url, api_key: body.api_key });
  }
  return {
    profiles,
    ...(toml.default ? { default: toml.default } : {}),
  };
}
```

**B.1.2** Add `smol-toml` to `packages/mcp/package.json`
dependencies.

**B.1.3** Test `packages/mcp/test/profiles.test.ts`:
- Loading a valid file returns the expected map.
- Missing file returns `null`.
- Malformed TOML throws.
- Profile missing `base_url` throws.
- Profile missing `api_key` throws.
- World-readable file emits a `console.error` warning but loads.
- `TEXTRAL_CONFIG_DIR` override is respected.

**Exit criteria for B.1**
- All test cases green.
- TypeScript clean.

---

### Step B.2 — Resolution chain

**B.2.1** Extend `profiles.ts` with the resolution function:

```ts
export interface ResolvedActiveProfile {
  active: Profile;
  available: string[];
  source: 'env-profile' | 'file-default' | 'lex-first' | 'env-vars-synth';
}

export async function resolveActiveProfile(): Promise<ResolvedActiveProfile> {
  const file = await loadProfileFile();
  const envProfile = process.env.TEXTRAL_PROFILE;

  if (file) {
    if (envProfile) {
      const p = file.profiles.get(envProfile);
      if (!p) {
        throw new Error(
          `TEXTRAL_PROFILE=${envProfile} not in ${configPath()}. ` +
          `Available: ${[...file.profiles.keys()].join(', ')}`,
        );
      }
      return { active: p, available: [...file.profiles.keys()], source: 'env-profile' };
    }
    if (file.default) {
      const p = file.profiles.get(file.default);
      if (!p) {
        throw new Error(
          `default = "${file.default}" not in [profiles.*] table`,
        );
      }
      return { active: p, available: [...file.profiles.keys()], source: 'file-default' };
    }
    const lexFirst = [...file.profiles.keys()].sort()[0];
    if (!lexFirst) throw new Error(`${configPath()}: no profiles defined`);
    return {
      active: file.profiles.get(lexFirst)!,
      available: [...file.profiles.keys()],
      source: 'lex-first',
    };
  }

  // No file. Synth from TEXTRAL_BASE_URL + TEXTRAL_API_KEY.
  const baseUrl = process.env.TEXTRAL_BASE_URL;
  const apiKey = process.env.TEXTRAL_API_KEY;
  if (baseUrl && apiKey) {
    return {
      active: { name: '_env', base_url: baseUrl, api_key: apiKey },
      available: ['_env'],
      source: 'env-vars-synth',
    };
  }

  throw new Error(
    `No Textral profile configured. Either:\n` +
    `  1. Create ${configPath()} (see docs/mcp/QUICKSTART.md), or\n` +
    `  2. Set TEXTRAL_BASE_URL + TEXTRAL_API_KEY env vars.`,
  );
}
```

**B.2.2** Test cases:
- `TEXTRAL_PROFILE=foo` with file containing `[profiles.foo]` →
  source `'env-profile'`.
- `TEXTRAL_PROFILE=missing` with file → throws with available list.
- File `default = "bar"` with no env override → source `'file-default'`.
- File with no `default` and two profiles `[a, b]` → source
  `'lex-first'`, picks `a`.
- No file, env vars set → source `'env-vars-synth'`, name `'_env'`.
- No file, no env vars → throws helpful error.
- File with `default` pointing to nonexistent profile → throws.

**Exit criteria for B.2**
- All test cases green.

---

### Step B.3 — Per-profile `(client, audit, runtime)` cache in `server.ts`

**B.3.1** Refactor `packages/mcp/src/transport-stdio.ts` to take a
`ResolvedActiveProfile` instead of bare `(baseUrl, apiKey)`:

```ts
import { resolveActiveProfile } from './profiles.js';

export async function startStdio(): Promise<void> {
  const resolved = await resolveActiveProfile();
  console.error(
    `[textral-mcp] active profile: ${resolved.active.name} ` +
    `(${resolved.active.base_url})`,
  );
  const server = createServer({ initialProfile: resolved });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

(`startStdio` no longer takes args; the bin shim from C.2 calls it
without the env-var pickup.)

**B.3.2** Refactor `packages/mcp/src/server.ts`. Add a private state
container:

```ts
interface ProfileBinding {
  profile: Profile;
  client: TextralClient;
  audit: ApiAuditWriter;
  runtime: 'cf' | 'node';
}

interface ServerState {
  active: string;
  available: string[];
  cache: Map<string, ProfileBinding>;
  loadFile: () => Promise<ProfileFile | null>; // for switch lookups
}
```

State is module-private inside `server.ts` (or held inside the
`createServer` closure — pick whichever fits the existing factory
shape). Materialization helper:

```ts
async function materialize(profile: Profile): Promise<ProfileBinding> {
  const client = new TextralClient({ baseUrl: profile.base_url, apiKey: profile.api_key });
  const me = await client.me(); // probe; throws on bad auth
  const audit = new ApiAuditWriter(client);
  return { profile, client, audit, runtime: me.runtime };
}
```

**B.3.3** All existing tool handlers gain a `binding()` helper that
reads the active binding from the state:

```ts
function binding(state: ServerState): ProfileBinding {
  const cached = state.cache.get(state.active);
  if (!cached) throw new Error(`active profile "${state.active}" not materialized`);
  return cached;
}
```

Tool handlers call `binding(state).client...` instead of using a
captured `client`.

**B.3.4** The `_env`-synth case: `state.cache` starts pre-populated
with `_env` → its binding. The state is otherwise empty until B.4's
switch tool fills it lazily.

**Exit criteria for B.3**
- All existing tool tests still pass.
- The single-profile path behaves identically to today (no
  observable change in tool output).

---

### Step B.4 — `textral_set_profile` + `textral_get_profile` tools

**B.4.1** New file `packages/mcp/src/tools/profile-tools.ts`:

```ts
import { z } from 'zod';
import { loadProfileFile } from '../profiles.js';
// import the materialize helper + state shape from server.ts
// (or inject via factory args — pick whatever the existing tools
// already do for shared deps).

export const SetProfileInput = z.object({ name: z.string().min(1) });

export async function setProfile(state, input: { name: string }) {
  if (input.name === state.active) {
    const b = binding(state);
    return { active_profile: b.profile.name, base_url: b.profile.base_url, runtime: b.runtime };
  }

  // Re-load file to pick up edits since startup.
  const file = await loadProfileFile();
  const candidate = file?.profiles.get(input.name);
  if (!candidate) {
    throw new Error(
      `Profile "${input.name}" not found. Available: ${state.available.join(', ')}`,
    );
  }

  // Lazy materialize. On probe failure, do NOT mutate state.
  const previousActive = state.active;
  let next: ProfileBinding;
  try {
    next = state.cache.get(input.name) ?? await materialize(candidate);
  } catch (e) {
    throw new Error(
      `Failed to switch to "${input.name}": ${(e as Error).message}. ` +
      `Active profile remains "${previousActive}".`,
    );
  }
  state.cache.set(input.name, next);
  state.active = input.name;
  return {
    active_profile: next.profile.name,
    base_url: next.profile.base_url,
    runtime: next.runtime,
  };
}

export async function getProfile(state) {
  const b = binding(state);
  return {
    active_profile: b.profile.name,
    base_url: b.profile.base_url,
    runtime: b.runtime,
    available: state.available,
  };
}
```

**B.4.2** Register both tools in `server.ts`'s tool list with
descriptions that interpolate the available profiles. Pseudocode:

```ts
const profilesList = state.available.length > 10
  ? `${state.available.slice(0, 10).join(', ')}, … (${state.available.length} total)`
  : state.available.join(', ');

server.tool(
  'textral_set_profile',
  `Switch the active Textral profile. All subsequent tool calls use ` +
  `this profile until switched again or the session ends. Use when ` +
  `the user explicitly asks to work with a different environment ` +
  `("switch to stage", "use prod"). Available profiles: ${profilesList}.`,
  SetProfileInput.shape,
  (args) => setProfile(state, args),
);
```

**B.4.3** `textral_get_profile` description:

```
Returns the current active Textral profile and the list of all
available profiles. Useful when you (or the user) want to confirm
which environment subsequent calls will target — for example,
before a destructive operation. Takes no arguments.
```

**B.4.4** Tests in `packages/mcp/test/set-profile.test.ts`:
- Switch happy path: state.active flips, returned binding matches.
- Switch with same name: no probe; idempotent.
- Switch to unknown name: throws with available list; state
  unchanged.
- Switch with probe failure (mocked `client.me()` rejection): throws;
  state.active preserved.
- After switch, `getProfile()` returns the new active.

**Exit criteria for B.4**
- All test cases green.
- The tools appear in the MCP capability handshake against a real
  test client.

---

### Step B.5 — Backwards-compat `_env` synth profile

Already covered in B.2's resolver, but pin the test:

**B.5.1** Test: with no `~/.textral/profiles.toml`,
`TEXTRAL_BASE_URL=...`, `TEXTRAL_API_KEY=...` set, the server
boots, `textral_get_profile()` returns `{ active_profile: '_env',
available: ['_env'] }`, every other tool works identically to
today.

**B.5.2** Test: `textral_set_profile({ name: 'anything-else' })`
in `_env` mode returns the standard profile-not-found error with
`available: ['_env']`.

**Exit criteria for B.5**
- Both tests green.
- The legacy `claude mcp add textral -- npx -y @textral/mcp` line
  with `--env TEXTRAL_BASE_URL=... --env TEXTRAL_API_KEY=...`
  works end-to-end.

---

### Step B.6 — Audit-trail-per-profile correctness

**B.6.1** Pin a test: do two tool calls under different profiles in
sequence, assert that the audit rows landed in two different
backends. Mock the `ApiAuditWriter`'s underlying `query_events`
write per-client; assert no cross-pollination.

**B.6.2** This was already designed correctly in B.3 (one
`ApiAuditWriter` per `ProfileBinding`); this step is a regression
guard, not net-new code.

**Exit criteria for B.6**
- Test passes.

---

### Step B.7 — Sample profiles + manual test

**B.7.1** Document a sample `~/.textral/profiles.toml` in
`docs/mcp/QUICKSTART.md`:

```toml
default = "hosted-prod"

[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_…"

[profiles.hosted-prod]
base_url = "https://textral-api-dev.leif-e24.workers.dev"
api_key  = "tx_live_…"
```

**B.7.2** From a clean Claude Code session pointed at the published
`@textral/mcp@0.1.0`:
1. Boot — verify stderr shows the active profile.
2. "What env am I in?" — Claude calls `textral_get_profile`.
3. "Switch to local." — Claude calls `textral_set_profile`.
4. "List my namespaces." — runs against local.
5. "Switch back to hosted-prod, list namespaces." — switches and
   lists.
6. Verify audit rows land in the correct backend (D1 for hosted,
   Postgres for local).

**Exit criteria for B.7**
- All six steps work.
- User signs off.

---

### Step B.8 — Doc + Scalar updates

**B.8.1** `docs/mcp/QUICKSTART.md`:
- Profile config section.
- Multi-environment UX explainer (one paragraph: "tell Claude to
  switch; one explicit instruction; no per-call profile parameter").
- Updated install commands (already done in C.6; verify).
- Sample `profiles.toml`.
- "Cloudflare runtime compatibility" section (already added in A.4).

**B.8.2** Scalar `MCP` tag in
`apps/api/src/openapi/tag-descriptions.ts`:
- Mention the published npm package + profiles.
- Drop any "stdio only" hedging that no longer applies.

**B.8.3** `README.md` — top-level — one-line update under "What's
new": "Multi-profile MCP server (`@textral/mcp`) for addressing
multiple Textral deployments from one Claude session."

**B.8.4** `packages/mcp/README.md` — full rewrite to document the
profile system as the primary path, env vars as the legacy path.

**Exit criteria for B.8**
- All linked anchors resolve.
- User-facing docs reviewed by user.

---

# Cross-phase work

### Step X.1 — Final manual end-to-end

**X.1.1** Three concurrent profiles: `local-stage` (self-host
running locally), `local-prod` (different self-host instance),
`hosted-prod` (deployed CF). All three configured in
`~/.textral/profiles.toml`.

**X.1.2** Single Claude Code session. Run all three through:
- List namespaces.
- Run a query.
- Ingest a small document.
- Switch via `textral_set_profile` between every operation.

**X.1.3** Verify each query / ingest landed in the correct backend
by direct DB inspection (D1 dashboard for CF; Postgres for
self-host).

**Exit criteria for X.1**
- All three profiles round-trip cleanly.
- No cross-pollination of audit data.
- User signs off.

---

### Step X.2 — Cleanup

**X.2.1** Delete dead code paths:
- The old env-var-only boot path in `bin/textral-mcp.mjs` (kept as
  the synth `_env` fallback in B.2; cleaner to leave the logic in
  the resolver).
- Any `process.env.TEXTRAL_BASE_URL` reads outside the resolver.
- Comments / docstrings referencing the pre-V2 single-tenant model.

**X.2.2** Search-for-dead-mention pass:
`grep -rn "single tenant\|one tenant\|single profile" --include="*.md" --include="*.ts"` — every hit gets reviewed.

**Exit criteria for X.2**
- Repo `pnpm test` + `pnpm tsc --noEmit` + `pnpm lint` all green.
- No dead references in shipping code or docs.

---

### Step X.3 — Sign-off + announcement

**X.3.1** Cut a final tag (`mcp-v0.1.0` already exists post-C.5;
just confirm the tip points at the post-B HEAD).

**X.3.2** Update `docs/roadmap/MCP_ON_CLOUDFLARE.md` with a
"Resolved" banner pointing at `MCP_V2_PLAN.md` and this doc.

**X.3.3** Internal announce (Slack / wherever) — one paragraph:
"`@textral/mcp@0.1.0` is live; install with
`claude mcp add textral -- npx -y @textral/mcp`; multi-profile
config docs at …".

**Exit criteria for X.3**
- Tag pushed.
- Roadmap doc shows "Resolved".
- Announce posted.

---

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `MCP_SMOKE_CF` test surfaces a real CF-runtime bug in `ingest_file` or `query` | Medium | Triage as a separate PR; ship Phase A's red-list with the broken tool gated. Don't block C/B on a tool-level fix. |
| `@textral` npm org name unavailable | Low | Fall back to unscoped names (`textral-mcp` / `textral-sdk` / `textral-contracts`); same install ergonomics. |
| Coordinated 3-package publish leaves contracts/sdk live but mcp un-publishable | Low | Run all three publishes in one sitting; if step 3 fails, contracts/sdk at 0.1.0 are still useful and we can republish mcp at 0.1.1 once fixed. |
| Bin shim's dev fallback loads `tsx` in a published install | Low | C.2.3 verifies via `pnpm pack --dry-run` that `tsx` isn't in the tarball; the fallback only triggers when `dist/` is absent. |
| `smol-toml` parse error on a user's hand-edited `profiles.toml` | Medium | B.1's loader catches + rethrows with a helpful message including the path + missing field. |
| User sets `chmod 600` on a multi-user system and breaks the warning logic | Low | Warning is non-fatal; the loader proceeds. |
| `textral_set_profile` mid-stream during a long-running tool call (e.g., `ingest_file`) interleaves badly | Low | Tools take a snapshot of `binding(state)` at handler entry; mid-call switch doesn't affect in-flight calls. Pin in a unit test. |
| Profile probe (`/v1/me`) hangs when target deploy is down | Medium | `TextralClient.me()` should already have a timeout; if not, set 5s in B.3.2. Switch fails fast. |
| `npx -y @textral/mcp` resolution caches an old version | Low | npx caches by `npm:registry-version`; users re-run with `@latest` or `@<pinned>` if they hit it. Document in QUICKSTART. |
| Tool-description token bloat for users with 20+ profiles | Low | Cap at 10 in the description, full list always available via `textral_get_profile`. |

---

## Out of scope / future work

- **Server-side HTTP MCP transport on CF** — when (if) a hosted
  consumer needs it.
- **Profile import/export tooling** (`textral profile add`,
  `textral profile remove`) — useful but not load-bearing; users
  hand-edit TOML for v1.
- **Profile sync / dotfile manager integration** — out of scope.
- **`textral_create_profile` / `textral_remove_profile` tools** —
  letting the LLM mutate the profile file is a sharp edge worth
  deferring.
- **OS keychain integration (`keytar`)** — defer until the threat
  model justifies it.
- **Live profile-file reloading** — restart-on-edit is acceptable.
- **Per-OS standalone binaries** (`bun --compile`, `pkg`) — deferred
  indefinitely.
- **Windows-native support** — WSL covers it.
- **Per-call profile override parameter** — user-explicitly rejected.
- **Profile tags / categories** (`prod=true`, `region=eu`) — defer
  until a use case emerges.
- **Automatic release pipeline** for `@textral/{contracts,sdk,mcp}`
  — manual for v0.1.0; CI later if cadence demands.
- **`@textral/cli`** as a non-MCP general-purpose CLI — separate
  package, separate plan.

---

## Work-product checklist

Phase-tagged. The implementation lands in the order A → C → B with
X interleaved at the end.

### Phase A
- [ ] A.1 — `apps/api/test/mcp-cf-smoke.test.ts` harness
- [ ] A.2 — `runtime` field on `/v1/me` (verify or add)
- [ ] A.3 — Tool classification + any red-list refusal gates
- [ ] A.4 — `docs/mcp/QUICKSTART.md` CF compatibility section

### Phase C
- [ ] C.1 — `tsconfig.build.json` for mcp / sdk / contracts
- [ ] C.2 — Bin shim refactor (production + dev fallback)
- [ ] C.3 — `@textral/mcp` `package.json` for publish
- [ ] C.4 — `@textral/contracts` + `@textral/sdk` `package.json`
       for publish
- [ ] C.5 — Coordinated 0.1.0 publish + smoke against `npx`
- [ ] C.6 — Doc updates kill `node /absolute/path` everywhere

### Phase B
- [ ] B.1 — Profile loader (`smol-toml` + permission warning)
- [ ] B.2 — Resolution chain
- [ ] B.3 — Per-profile cache in `server.ts`
- [ ] B.4 — `textral_set_profile` + `textral_get_profile` tools
- [ ] B.5 — `_env` synth fallback test coverage
- [ ] B.6 — Audit-per-profile regression guard
- [ ] B.7 — Manual three-profile end-to-end
- [ ] B.8 — Doc + Scalar + README updates

### Cross
- [ ] X.1 — Final manual end-to-end against three concurrent profiles
- [ ] X.2 — Repo cleanup (dead paths, dead docs)
- [ ] X.3 — Sign-off, announce, roadmap doc resolved-banner
