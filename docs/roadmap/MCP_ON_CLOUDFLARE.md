# MCP on multiple environments, e.g. local and cloudflare

> **✓ Resolved by MCP V2.** All three problem statements (P1 — CF
> compatibility unverified; P2 — one-tenant-per-MCP; P3 — hostile
> install incantation) are addressed in `docs/MCP_V2_PLAN.md` and
> shipped via the implementation in `docs/MCP_V2_IMPLEMENTATION.md`.
> The install incantation below (`-- node /absolute/path/...`) is
> superseded; use `claude mcp add textral --scope user -- npx -y
> @textral/mcp` instead. Profile config lives in
> `~/.textral/profiles.toml`. Historical context preserved below.


Imagine that I have multiple self-hosted Textrals, or I have an account on a cloudflare deployed Textral, and a local self-hosted Textral.

There are two problems:

1) We haven't tested if MCP works with textral on cloudflare, we've only tested it with local deployment.  We need to verify if it works for the Cloudflare deployment, and fix it if it does not.

2) Presently we add our mcp to claude code like:
```
claude mcp add textral \
  --scope user \
  --env TEXTRAL_BASE_URL=http://localhost:8787 \
  --env TEXTRAL_API_KEY=tx_live_… \
  -- node /absolute/path/to/textral/packages/mcp/bin/textral-mcp.mjs
```

That's all well and good if the following are true:
- The claude code user only cares about oen base url
- The claude code user only cares about accessing one tenant
- The claude code user has textral-mcp.mjs on their local machine

But what if:
- The claude code user has a stage textral, and a production textral? They'd want to be able to call both! Ideally ergonomically
Either like this:
 e.g. "Claude, how many namespaces do I have in stage?" "Claude, in prod, what's our best strategy given our SOPs and Forecasts?"
Or like this:
"/textral env stage" and then "Claude, what are my namespaces?" -- Probably better to be able to explicitly set environment like this. Otherwise claude would need to determine both, what is the intended environment, AND what is the intended tool it should use with textral mcp to answer the question.

Or what if:
- The user has multiple tenants?

Therefore.. Is it possible, with MCP to have the ability to basically set profiles for textral.

Where a profile would contain: [API Key, Base URL]
That way I could set like 3 profiles:
- local stage
- local prod
- hosted (cloudflare) prod

Is this possible?


## Summary

3 issues: 
- Does MCP work on cloudflare with its current impl? If not, let's fix
- Can we set profiles as described above?
- What to do about this gross -- node /absolute/path/to/the/mjs issue?

# Claude's Analysis of this ticket

## Problem statements (as I read them)

**P1 — CF compatibility unverified.** The `@textral/mcp` stdio CLI was
written and tested against a self-host (Node) Textral. We never proved
it round-trips against a Cloudflare-deployed Textral. The HTTP transport
(`POST /v1/mcp`) is also documented as 501 on CF in Phase 1; that's a
known gap, but it's not the same gap as the stdio path.

**P2 — One-tenant-per-MCP is the wrong primitive.** The MCP entry
embeds *exactly one* `(TEXTRAL_BASE_URL, TEXTRAL_API_KEY)` pair via env
vars at process spawn time. A user with `local-stage` + `local-prod` +
`hosted-prod` has no way to address all three from a single Claude
session without three separate MCP entries — and three entries means
three copies of every tool in the prompt (`mcp__textral_stage__query`,
`mcp__textral_prod__query`, …), which is both noisy and forces Claude
to disambiguate intent on every call.

**P3 — The install incantation is hostile.** `node /absolute/path/to/...`
only works if the user has the repo cloned at a known location. Anyone
who isn't a Textral contributor can't run this. There's no published
binary path; the package is `"private": true` in `package.json`.

---

## Proposed solutions

### S1 — Verify CF, document the gap (P1)

The stdio MCP is a pure HTTP client — it talks to whatever URL it's
pointed at. The empirical question is whether every tool's underlying
REST endpoint actually works on the CF runtime. Most do; a few might
not (anything Node-runtime-gated will 501; the `/v1/mcp` HTTP transport
is one known case but no MCP **tool** uses that path).

**Action:**
- Add `make mcp-smoke-cf` — runs each MCP tool's underlying REST call
  against `https://textral-api-dev.leif-e24.workers.dev` with a known
  test API key. Pin a green-list of working tools, surface red-list as
  known limitations in `docs/mcp/QUICKSTART.md`.
- The HTTP transport (`POST /v1/mcp`, currently 501 on CF) stays
  out-of-scope unless we discover a specific need. Stdio works because
  the *client* runs on the user's machine; the server-mode HTTP
  transport on CF is a separate Workers-MCP plumbing exercise not
  worth doing speculatively.

### S2 — Profiles, with explicit selection (P2)

A `~/.textral/profiles.toml` file keyed by profile name:

```toml
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

Resolution precedence (loosest → tightest):
1. `default` field in the file
2. `TEXTRAL_PROFILE` env var on MCP launch
3. Optional `profile?: string` parameter on every MCP tool call

The per-call parameter is the load-bearing piece. It lets one MCP entry
serve all profiles, with Claude routing explicitly:

> User: "List my namespaces in `hosted-prod`."
> Claude calls: `textral_list_namespaces({ profile: "hosted-prod" })`

Profile names appear in tool descriptions so the model knows the menu.
For users who want a "set environment" UX, expose a `textral_set_profile`
tool that flips the in-process default — but it's syntactic sugar over
the per-call parameter, not the primary mechanism. Keeps the design
clean and stateless-by-default.

Backwards-compatible fallback: when no profile file exists, fall back
to the existing `TEXTRAL_BASE_URL` + `TEXTRAL_API_KEY` env vars.
Existing single-tenant users see no change.

### S3 — Publish the binary (P3)

Two options, both better than `node /absolute/path/...`:

**S3a — npm publish (recommended).** Drop `"private": true`, set
appropriate `version`, publish to npm or a private registry. The
canonical `claude mcp add` line becomes:

```bash
claude mcp add textral --scope user -- npx -y @textral/mcp
```

`npx` resolves the latest version on each spawn; no install step;
profile config lives in `~/.textral/profiles.toml`. Updates are
automatic. This pattern is what `@modelcontextprotocol/server-*`
reference servers use.

**S3b — Standalone binary (`bun build --compile` or `pkg`).** Single-
file executable for users without Node. Heavier maintenance burden
(per-OS targets), but useful if we ever ship to non-developer
audiences. Not worth doing until S3a is in place and we hit a real
user need.

Either way, audit the `bin/textral-mcp.mjs` shim for portability —
the `tsImport`-from-relative-path mode in dev needs a parallel
"production" code path that imports from the package's compiled
`dist/`. Today the shim assumes the source tree is present; that
assumption breaks the moment a user installs from npm.

---

## Recommended sequencing

1. **S1 first** (smoke harness) — small, gives us empirical
   ground-truth before we commit to design changes for S2/S3.
2. **S3a** (npm publish) — unblocks every external user and removes
   the `node /absolute/path` from every doc surface.
3. **S2** (profiles) — meaningful design lift, but only useful once
   S3a means people are actually running the binary in anger. Ship
   profiles in a follow-up release.

## Open questions

- **Where do profile credentials live?** A flat TOML file in
  `~/.textral/` is fine for now; future work could integrate with
  the OS keychain (`keytar`) — out of scope.
  Answer: `~/.textral/` is sufficient.
- **What about `~/.textral/profiles.toml` on Windows?** `os.homedir()`
  resolves to `%USERPROFILE%`; the rest is path-agnostic. Verify in
  the smoke harness.
  Answer: I don't consider supporting powershell users as a priority.  Any dev worth their salt is in WSL Linux, or Linux.
- **Audit-trail implications.** Today the MCP server writes audit
  rows tagged with the spawning client. With profiles, each call
  may target a different tenant — audit writes must use the
  per-call resolved tenant, not the spawn-time tenant. Easy to get
  right; easy to forget.
  Answer: Once again, I worry about Claude having to figure out what environment the user is referring to when they ask an open ended question like "What is the SOP for this scenario ... X..Y..Z".. Any tokens spent thinking about "What env is the user wanting to see?" is bad.  We should have a way to set the profile explicitly. 
- **Does the embedded `POST /v1/mcp` HTTP transport on CF matter?**
  Probably no — the stdio path covers Claude Code, Cursor, and every
  other MCP client. Decision: declare HTTP-on-CF out-of-scope unless
  a concrete consumer (Slackbot, hosted Claude.ai integration) shows
  up needing it.
  Answer: I defer to your judgement.