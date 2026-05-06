# syntax=docker/dockerfile:1.7
#
# Multi-stage Node 24 build for the self-host @textral/api image.
# Two entrypoints share this image (compose picks via `command:`):
#   - api          → dist/runtime/node/index.mjs           (Hono server)
#   - ingest-worker → dist/runtime/node/workers/ingest-consumer.mjs
#                                                            (BRPOP loop)
# The migrate-postgres CLI also lands in the image at
# dist/scripts/migrate-postgres.mjs; the `migrate-postgres-selfhost`
# Makefile target runs it via `docker compose run`.
#
# Build context is the repo root (compose passes `context: ../..`),
# so paths below are repo-rooted.

# ── builder ────────────────────────────────────────────────────
FROM node:24 AS builder
WORKDIR /work
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Workspace + lockfile first (cache layer for installs).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# Source last so editing source doesn't bust the install cache.
COPY tsconfig.base.json ./
COPY apps/api ./apps/api

# Run typecheck against the Node tsconfig before bundling so type
# errors fail the build rather than landing in the image.
RUN pnpm --filter @textral/api typecheck:node
RUN pnpm --filter @textral/api build:node

# ── runtime ────────────────────────────────────────────────────
# Alpine for size. Bundles are fully self-contained (esbuild inlines
# every dep), so the runtime stage carries no node_modules — only
# `dist/` and `migrations/postgres/` (read by migrate-postgres at runtime).
FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=builder /work/apps/api/dist ./dist
COPY --from=builder /work/apps/api/migrations ./migrations
ENV NODE_ENV=production
# Pin migrate-postgres at the runtime path. The bundled script's
# `import.meta.dirname` resolves to /app/dist/scripts/, which would
# look for /app/dist/migrations/postgres — but we deliberately keep
# migrations at /app/migrations (they're data, not bundle output).
ENV POSTGRES_MIGRATIONS_DIR=/app/migrations/postgres
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/runtime/node/index.mjs"]
