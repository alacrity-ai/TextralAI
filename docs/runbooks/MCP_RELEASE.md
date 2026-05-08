# MCP coordinated release runbook

How to cut a coordinated release of `@textral/contracts`, `@textral/sdk`, and `@textral/mcp`. The three are versioned in lockstep until 1.0 — they ship together so consumers never see a `mcp` that depends on an unpublished `sdk`.

This runbook covers the v0.1.0 first-publish. Subsequent minor / patch cuts follow the same flow with a different version number.

## Pre-flight

1. **`develop` is green and merged.** All Phase A/B/C/X work landed.
2. **You are on Node 24.** `nvm use 24`.
3. **`pnpm` is at v10+.** `pnpm --version`.
4. **You are logged into npm with publish rights to `@textral`.** Verify:
   ```bash
   npm whoami            # should print the publishing user
   npm access list packages @textral 2>/dev/null  # should show org membership
   ```
   If `@textral` is unavailable on npm, fall back to unscoped names — see "Fallback: unscoped names" below.
5. **Working tree clean.** `git status` shows nothing to commit.

## Step-by-step

### 1. Build all three from a fresh tree

```bash
pnpm install
pnpm --filter @textral/contracts build
pnpm --filter @textral/sdk build
pnpm --filter @textral/mcp build
```

Each emits to its own `dist/`. The commands fail fast if any package's typecheck regressed.

### 2. Verify tarball contents

```bash
( cd packages/contracts && pnpm pack --dry-run )
( cd packages/sdk        && pnpm pack --dry-run )
( cd packages/mcp        && pnpm pack --dry-run )
```

Confirm each lists only `dist/`, `bin/` (mcp only), `package.json`, `README.md`, `LICENSE`. No `src/`, no `test/`, no `tsconfig*.json`.

### 3. Publish in dependency order

The order matters: contracts → sdk → mcp. Each later package's tarball declares the previous one as a regular dep, so the dep must already be on npm.

```bash
# 1. contracts
( cd packages/contracts && pnpm publish --access public --no-git-checks )

# 2. sdk
( cd packages/sdk && pnpm publish --access public --no-git-checks )

# 3. mcp
( cd packages/mcp && pnpm publish --access public --no-git-checks )
```

`pnpm publish` auto-rewrites `workspace:^0.1.0` deps to `^0.1.0` in the published `package.json`, so the tarballs reference the npm-resolved version.

`--no-git-checks` is fine here because we explicitly verified working-tree cleanliness pre-flight; the option just suppresses pnpm's reflexive `git status` warning.

### 4. Verify on the registry

```bash
npm view @textral/contracts version    # should print 0.1.0
npm view @textral/sdk version          # should print 0.1.0
npm view @textral/mcp version          # should print 0.1.0

open https://npmjs.com/package/@textral/mcp
```

### 5. Smoke against the published binary

From a directory with no Textral source:

```bash
mkdir -p /tmp/textral-mcp-smoke && cd /tmp/textral-mcp-smoke
TEXTRAL_BASE_URL=https://textral-api-dev.leif-e24.workers.dev \
TEXTRAL_API_KEY=tx_live_… \
  npx -y @textral/mcp@0.1.0 < /dev/null
```

It should print the active profile to stderr (`[textral-mcp] active profile: _env (https://…)`) and then block waiting for MCP framing on stdin. Ctrl-C to exit.

### 6. Tag

```bash
git tag mcp-v0.1.0
git tag sdk-v0.1.0
git tag contracts-v0.1.0
git push --tags
```

### 7. Update the roadmap doc

`docs/roadmap/MCP_ON_CLOUDFLARE.md` gets a "✓ Resolved by MCP V2" banner at the top. Done.

## Fallback: unscoped names

If `@textral` org isn't yours yet, the published names become `textral-contracts`, `textral-sdk`, `textral-mcp`. Update each `package.json`'s `name` field, the cross-references in `dependencies`, and re-run from step 1. The install incantation becomes `npx -y textral-mcp` (no leading `@textral/`); same UX otherwise.

## Recovery: partial publish

If contracts + sdk publish but mcp fails (rare — usually a tarball validation issue), the live two are still useful for downstream TS users. Fix the mcp issue, bump it to `0.1.1`, and republish just mcp. Keep contracts + sdk at `0.1.0` until their next coordinated bump.

## Recovery: bad publish

npm allows unpublishing within 72h. If something needs reverting:

```bash
npm unpublish @textral/mcp@0.1.0 --force
```

Then republish the corrected version. After 72h, npm requires you to bump to `0.1.1`+ instead of overwriting.

## Future: automation

For v0.2.0 onward, this should be a single `./scripts/release.sh <version>` invocation that runs all six steps. Don't bother automating until cadence justifies it (probably > 4 releases/year).
