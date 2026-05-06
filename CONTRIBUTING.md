# Contributing to Textral

Thanks for the interest. This document covers what you need to know
before sending a pull request — licensing terms, code conventions,
local-dev setup, and the review loop.

## License & contributor terms

Textral is licensed under the **Elastic License 2.0** (see
[`LICENSE.md`](./LICENSE.md)).

By submitting any code, documentation, or other content to this
repository, you agree that:

1. **Your contribution is licensed under the same Elastic License
   2.0** as the rest of the project.
2. **You have the right to make the contribution.** You either
   wrote it yourself, or you have explicit permission from the
   author / your employer to submit it under the project's license.
3. **You sign off on every commit** using the
   [Developer Certificate of Origin (DCO)](https://developercertificate.org/)
   — see the next section.

We use the DCO rather than a Contributor License Agreement (CLA)
because it's lightweight and doesn't require a separate signing
flow. We may add a CLA later for substantial contributions if a
re-licensing scenario arises; we'd notify all contributors before
that change takes effect.

### Sign your commits (DCO)

Add a `Signed-off-by:` line to every commit message. Git does this
for you with the `-s` flag:

```bash
git commit -s -m "fix: handle empty namespace in pinecone adapter"
```

The line looks like:

```
Signed-off-by: Real Name <email@example.com>
```

By adding it, you're certifying — under your real name and a
working email — that the contribution conforms to the
[Developer Certificate of Origin v1.1](https://developercertificate.org/).

A GitHub Action enforces this on every PR. PRs without sign-offs
will be blocked from merging until every commit is signed. If you
forgot, rebase and `git commit --amend -s` (or for multiple
commits, `git rebase -i HEAD~N -x 'git commit --amend --no-edit -s'`).

### What "contribution" means here

- Code (TS, Python, SQL, shell)
- Documentation (`.md`, `.mdx`)
- Configuration (`Dockerfile`, `docker-compose.yml`, `.env.*.example`,
  CI workflows)
- Test fixtures and seed data
- Sandbox UI assets

If you're unsure whether something counts, sign it off — better
safe.

## Before you start work

For anything beyond a typo fix or one-line bug repair:

1. **Open an issue first.** Describe what you want to change and
   why. We'll discuss approach before you invest implementation
   time. The maintainers may have context (a competing in-flight
   change, a planned refactor that conflicts) that's faster to
   surface in an issue than in PR review.
2. **Read `docs/1-DESIGN.md`** for the high-level architecture and
   `docs/v3/` for the V3 (self-host + Cloudflare parity) design.
3. **For non-trivial features** (new connector, new MCP tool, new
   corpus profile), draft a short design note in `docs/ideas/` or
   `docs/fixes/` mirroring the existing format. PRs implementing
   features without a design rationale tend to bounce in review.

## Local development

```bash
# Install + typecheck across all packages
make install
make typecheck lint

# Self-host stack (Postgres + Redis + Qdrant + MinIO + api + ingest)
make selfhost-up
make selfhost-seed-cookbook  # prints SELFHOST_API_KEY=...

# Run tests
make test            # CF-pool TypeScript suites
make test-node       # Node-runtime adapter tests (testcontainers; Docker required)
make test-ingest     # Python ingest container pytest

# Sandbox dev server (HMR + Vite)
make sandbox-dev
```

Each app has its own README/docs:

- `apps/api/` — public + internal Hono API
- `apps/ingest/` — Python ingest pipeline
- `apps/sandbox/` — operator UI
- `packages/mcp/` — MCP server
- `packages/contracts/` — shared Zod schemas
- `packages/corpus-profiles/` — corpus profile registry

## Code conventions

These are summary rules; for the full picture, read existing code
in the area you're touching.

- **TypeScript.** Strict mode is on, including `exactOptionalPropertyTypes`.
  Use `?` for optional fields, never `| undefined` to mean "absent."
  When constructing optional config, conditional spread:
  `{ ...(x !== undefined ? { x } : {}) }`.
- **Zod is the source of truth for schemas.** Add new shapes to
  `packages/contracts/`; don't redefine them in routes or the
  sandbox. The MCP tool layer derives its JSON Schema from
  `@textral/contracts` automatically.
- **Tenant-scope everything.** Every DB read/write helper takes
  `tenant_id` as a non-optional first argument. If you find
  yourself writing a query without `WHERE tenant_id = ?`, stop.
  See `docs/security/THREAT_MODEL.md` §3.
- **No inline SQL outside `apps/api/src/db/`.** A CI guard
  (`tools/check-no-inline-d1.sh`) enforces this — extend the db
  helper rather than carving an exception.
- **CF/Node import boundaries.** Code in `apps/api/src/runtime/cf/`
  must not import from `node:*`; code in `apps/api/src/runtime/node/`
  must not import CF-specific types. Two CI guards enforce these.
- **Comments.** Default to no comments. Add one when the *why* is
  non-obvious — a hidden constraint, a workaround, a surprise. Don't
  re-state what the code does.
- **Error envelopes.** All API errors throw `TextralError` from
  `@textral/contracts`. Never return raw error JSON from a handler.
- **Audit trail invariance.** Every `/v1/query` writes a
  `query_events` row through every code path including failure.
  Every MCP tool call writes an `mcp_tool_calls` row. Don't
  bypass the wrappers.

## Tests

PRs need tests for the change they introduce, unless the change is
purely cosmetic. The conventions:

- **API routes**: `apps/api/test/<route>-route.test.ts` using the
  `cloudflare:test` pool.
- **Adapters / vector stores**: `apps/api/test/retrieval/<adapter>.test.ts`
  with mocked fetch.
- **MCP tools / server**: `packages/mcp/test/` (vitest, no
  cf-pool dependency).
- **Python ingest**: `apps/ingest/tests/` (pytest).
- **Cookbook validators**: `apps/api/scripts/validate-cookbook.ts`
  for the REST flows; `tools/mcp-validator/index.ts` for the MCP
  flows. Update these when you add a query/ingest pattern that
  should be regression-pinned.

Run before pushing:

```bash
make typecheck lint
pnpm --filter @textral/sdk --filter @textral/mcp test    # quick path — runs in seconds
make test-node                                            # full path — needs Docker
```

## Pull request flow

1. Branch off `main` (or whatever the active branch is at the
   time).
2. Commit small, focused changes. Each commit `Signed-off-by:`'d.
3. Open a PR with:
   - **Title**: short, in imperative mood (`fix: handle empty
     namespace in pinecone adapter`).
   - **Body**: what + why + scope. Link the issue or design doc.
     Include a "test plan" section listing what you ran.
4. CI must be green. The Node lane is the slow one (~6 min); the
   CF lane is fast.
5. A maintainer reviews. Expect a turn within ~3 business days for
   most PRs; complex architectural changes take longer.
6. Address review comments via additional commits (don't
   force-push during review unless asked — preserves the review
   thread).
7. After approval, the maintainer squash-merges or rebase-merges
   per the area's convention.

## License headers in source files

Optional but appreciated. If you want to mark new files with a
license header, the canonical block is:

```ts
// Copyright (c) 2026 Alacrity AI Solutions LLC.
// Licensed under the Elastic License 2.0. See LICENSE.md in the
// repository root.
```

For Python:

```python
# Copyright (c) 2026 Alacrity AI Solutions LLC.
# Licensed under the Elastic License 2.0. See LICENSE.md in the
# repository root.
```

To bulk-add headers to every source file in one pass (recommended
before the first public release; idempotent — won't double-add):

```bash
go install github.com/google/addlicense@latest
addlicense \
  -l elastic-2.0 \
  -c "Alacrity AI Solutions LLC" \
  -y 2026 \
  -ignore '**/node_modules/**' \
  -ignore '**/dist/**' \
  -ignore '**/__pycache__/**' \
  -ignore '**/.pnpm/**' \
  -ignore '**/migrations/**' \
  apps packages tools
```

Note: `addlicense` doesn't ship with an `elastic-2.0` template by
default; pass `-s -f LICENSE-HEADER.txt` instead, where
`LICENSE-HEADER.txt` is a file containing your two-line header.
The script above is illustrative.

## Reporting bugs (non-security)

Open a GitHub issue with:

- Steps to reproduce.
- The version / commit hash.
- The deploy mode (Cloudflare or self-host).
- Relevant log lines, redacted of secrets.

For **security** issues, follow [`SECURITY.md`](./SECURITY.md)
instead — do not open a public issue.

## Reporting documentation issues

Doc bugs are real bugs. Open an issue or — better — a PR that fixes
the doc. We try to keep docs as carefully-maintained as code.

## Code of conduct

Be civil. Treat reviewers and contributors with respect. We don't
have a formal code-of-conduct document yet; if behavior in this
repo crosses a line, contact a maintainer privately.

## Questions

If this document doesn't answer your question, open an issue with
the `question` label, or reach out to a maintainer directly. We'd
rather you ask than ship something that needs a major rewrite in
review.

Thanks for contributing.
