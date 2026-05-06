# syntax=docker/dockerfile:1.7
#
# Multi-stage Node 24 build for the @textral/sandbox image.
# Stage 1 builds the static SPA (vite build), stage 2 serves it via
# nginx with an SPA fallback and a same-origin /v1 proxy to the api.

# ── builder ────────────────────────────────────────────────────
FROM node:24 AS builder
WORKDIR /work
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Workspace + lockfile first (cache layer for installs).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/sandbox/package.json ./apps/sandbox/
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @textral/sandbox...

# Source last so editing source doesn't bust the install cache.
COPY tsconfig.base.json ./
COPY apps/sandbox ./apps/sandbox

RUN pnpm --filter @textral/sandbox typecheck
RUN pnpm --filter @textral/sandbox build

# ── runtime ────────────────────────────────────────────────────
FROM nginx:alpine AS runtime
COPY --from=builder /work/apps/sandbox/dist /usr/share/nginx/html
COPY apps/sandbox/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 5173
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget -qO- http://localhost:5173/ >/dev/null || exit 1
