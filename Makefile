.DEFAULT_GOAL := help

# Resolve pnpm. Falls back to a Node-24-pinned wrapper when present (this
# host's setup), otherwise expects pnpm on PATH.
PNPM ?= $(shell test -x /home/leif/.local/share/npm-global/bin/pnpm-active && echo /home/leif/.local/share/npm-global/bin/pnpm-active || echo pnpm)

.PHONY: help install typecheck lint test test-ingest test-live test-node fmt fmt-check \
        dev-api dev-ingest \
        build-ingest push-ingest \
        deploy-dev deploy-prod \
        migrate-dev migrate-prod migrate-postgres-local migrate-postgres-selfhost \
        seed-dev \
        secret-put-dev secret-put-prod \
        bootstrap-secrets-dev tail-dev \
        selfhost-up selfhost-down selfhost-logs selfhost-seed-cookbook selfhost-validate \
        sandbox-dev sandbox-build sandbox-typecheck \
        mcp-dev mcp-typecheck mcp-validate

help: ## Show this help
	@awk 'BEGIN { FS = ":.*##"; printf "Usage: make <target>\n\nTargets:\n" } /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install workspace dependencies
	$(PNPM) install

typecheck: ## Typecheck all packages
	$(PNPM) -r typecheck

lint: ## Lint all packages + placement guards (D1, CF/Node import boundaries)
	$(PNPM) -r lint
	bash tools/check-no-inline-d1.sh
	bash tools/check-no-cf-imports-in-node.sh
	bash tools/check-no-node-imports-in-cf.sh

test: ## Run all tests (TS workspaces)
	$(PNPM) -r test

test-ingest: ## Run the Container's pytest suite (apps/ingest)
	cd apps/ingest && python -m pytest -v

test-live: ## Run live e2e (deployed Worker, Phase 3+4). Requires LIVE_WORKER_URL, LIVE_API_KEY, OPENAI_API_KEY
	$(PNPM) --filter @textral/api exec tsx scripts/test-live.ts

test-live-phase5: ## Run Phase 5 live e2e (narrative profile + rerank fallback). Same env vars as test-live
	$(PNPM) --filter @textral/api exec tsx scripts/test-live-phase5.ts

test-node: ## V3 Phase 2 — run the Node-runtime adapter test suite (testcontainers; Docker required)
	$(PNPM) --filter @textral/api test:node

fmt: ## Auto-format with prettier
	$(PNPM) exec prettier --write .

fmt-check: ## Verify formatting without writing
	$(PNPM) exec prettier --check .

dev-api: ## Run the Worker locally against dev bindings
	$(PNPM) --filter @textral/api dev

dev-api-remote: ## Run the Worker locally with --remote (real CF dev bindings; reaches host.docker.internal:6333 for V3 Qdrant)
	cd apps/api && npx wrangler dev --remote --env dev

dev-ingest: ## Run the Container locally on :8000
	cd apps/ingest && uvicorn app.main:app --reload --port 8000

dev-stack: ## V3 Phase 1 — bring up Qdrant + ingest in docker-compose
	docker compose -f infrastructure/docker/docker-compose.dev.yml up -d --wait
	@echo
	@echo "  Qdrant:  http://localhost:6333"
	@echo "  Ingest:  http://localhost:8000"
	@echo
	@echo "  Now run 'make dev-api-remote' in another terminal to start the Worker."

dev-stack-down: ## V3 Phase 1 — stop and remove the dev stack
	docker compose -f infrastructure/docker/docker-compose.dev.yml down

build-ingest: ## Build the Container image (mirrors corpus-profiles into apps/ingest/profiles/ first)
	@set -e; \
	if [ ! -d packages/corpus-profiles/profiles ]; then \
	  echo 'ERROR: packages/corpus-profiles/profiles is missing — Container image cannot be built without canonical YAML profiles.' >&2; \
	  echo 'Did you run pnpm install? Or rename the source-of-truth dir?' >&2; \
	  exit 1; \
	fi
	rm -rf apps/ingest/profiles
	cp -r packages/corpus-profiles/profiles apps/ingest/profiles
	cd apps/api && npx wrangler containers build ../ingest -t textral-ingest:dev

push-ingest: build-ingest ## Push the Container image to Cloudflare's registry
	cd apps/api && npx wrangler containers push textral-ingest:dev

deploy-dev: ## Deploy Worker + Container application to the dev env
	cd apps/api && npx wrangler deploy --env dev

deploy-prod: ## Deploy Worker + Container application to the prod env
	cd apps/api && npx wrangler deploy --env prod

migrate-dev: ## Apply D1 migrations to the remote dev database
	cd apps/api && npx wrangler d1 migrations apply textral-dev --env dev --remote

migrate-prod: ## Apply D1 migrations to the remote prod database
	cd apps/api && npx wrangler d1 migrations apply textral-prod --env prod --remote

migrate-postgres-local: ## V3 Phase 2 — apply Postgres migrations to a local pg instance
	$(PNPM) --filter @textral/api exec tsx scripts/migrate-postgres.ts

migrate-postgres-selfhost: ## V3 Phase 2 — apply Postgres migrations inside the running self-host stack
	docker compose -f infrastructure/docker/docker-compose.yml run --rm api \
	  node dist/scripts/migrate-postgres.mjs

seed-dev: ## Seed dev D1 with a tenant + namespace + api key (idempotent)
	$(PNPM) --filter @textral/api exec tsx scripts/seed-dev.ts

secret-put-dev: ## Put a Worker secret into dev (interactive). Usage: make secret-put-dev NAME=FOO
	@if [ -z "$(NAME)" ]; then echo "Usage: make secret-put-dev NAME=<SECRET>"; exit 1; fi
	cd apps/api && npx wrangler secret put $(NAME) --env dev

secret-put-prod: ## Put a Worker secret into prod (interactive). Usage: make secret-put-prod NAME=FOO
	@if [ -z "$(NAME)" ]; then echo "Usage: make secret-put-prod NAME=<SECRET>"; exit 1; fi
	cd apps/api && npx wrangler secret put $(NAME) --env prod

bootstrap-secrets-dev: ## One-shot: generate + put the 4 Phase-3/4 worker secrets in dev. ROTATES every secret — invalidates all existing API keys.
	@echo "!! This rotates INTERNAL_HMAC_SECRET, AUDIT_HASH_SALT, API_KEY_PEPPER, ADMIN_BOOTSTRAP_TOKEN."
	@echo "!! Existing API keys (hashed with API_KEY_PEPPER) will stop working."
	@echo "!! Type 'rotate' to continue, anything else to abort:"
	@read confirm; [ "$$confirm" = "rotate" ] || (echo "aborted." && exit 1)
	@HMAC=$$(openssl rand -hex 32); \
	 SALT=$$(openssl rand -hex 16); \
	 PEPPER=$$(openssl rand -hex 32); \
	 BOOTSTRAP=$$(openssl rand -hex 32); \
	 cd apps/api && \
	  printf '%s' "$$HMAC" | npx wrangler secret put INTERNAL_HMAC_SECRET --env dev && \
	  printf '%s' "$$SALT" | npx wrangler secret put AUDIT_HASH_SALT --env dev && \
	  printf '%s' "$$PEPPER" | npx wrangler secret put API_KEY_PEPPER --env dev && \
	  printf '%s' "$$BOOTSTRAP" | npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN --env dev && \
	  printf 'INTERNAL_HMAC_SECRET=%s\nAUDIT_HASH_SALT=%s\nAPI_KEY_PEPPER=%s\nADMIN_BOOTSTRAP_TOKEN=%s\n' \
	    "$$HMAC" "$$SALT" "$$PEPPER" "$$BOOTSTRAP" > .secrets.dev.env && \
	  chmod 600 .secrets.dev.env
	@echo ">> Done. Wrote apps/api/.secrets.dev.env (mode 600, gitignored). Source it for seed-dev:"
	@echo "     set -a; . apps/api/.secrets.dev.env; set +a; make seed-dev"
	@echo ">> Re-deploy the Worker (make deploy-dev) so the Container picks up the new INTERNAL_HMAC_SECRET."

tail-dev: ## Stream live logs from the dev Worker
	cd apps/api && npx wrangler tail --env dev --format=pretty

selfhost-up: ## V3 Phase 2 — bring up the full self-host stack (postgres + redis + qdrant + minio + api + ingest-worker + ingest). Forces rebuild on source changes.
	docker compose -f infrastructure/docker/docker-compose.yml up -d --wait --build

selfhost-down: ## V3 Phase 2 — stop and remove the self-host stack
	docker compose -f infrastructure/docker/docker-compose.yml down

selfhost-logs: ## V3 Phase 2 — tail logs from every self-host service
	docker compose -f infrastructure/docker/docker-compose.yml logs -f

selfhost-seed-cookbook: ## V3 Phase 2 — provision the cookbook-qdrant namespace + ingest narrative-tiny fixture inside the running stack. Requires ADMIN_BOOTSTRAP_TOKEN + OPENAI_API_KEY.
	@if [ -z "$$ADMIN_BOOTSTRAP_TOKEN" ]; then echo "ERROR: ADMIN_BOOTSTRAP_TOKEN env var unset. Read it from .env.selfhost." >&2; exit 1; fi
	@if [ -z "$$OPENAI_API_KEY" ]; then echo "ERROR: OPENAI_API_KEY env var unset. The cookbook fixture needs a real OpenAI key for embeddings + synthesis." >&2; exit 1; fi
	$(PNPM) --filter @textral/api exec tsx scripts/seed-cookbook-self-host.ts

selfhost-validate: ## V3 Phase 2 — run the cookbook validator against the local self-host stack. Requires SELFHOST_API_KEY (printed by `make selfhost-seed-cookbook`).
	@if [ -z "$$SELFHOST_API_KEY" ]; then echo "ERROR: SELFHOST_API_KEY env var unset. Run \`make selfhost-seed-cookbook\` first and export the printed key." >&2; exit 1; fi
	LIVE_WORKER_URL=http://localhost:8787 LIVE_API_KEY=$$SELFHOST_API_KEY \
	  $(PNPM) --filter @textral/api exec tsx scripts/validate-cookbook.ts --backend qdrant

sandbox-dev: ## V3 sandbox — start the Vite dev server (proxies /v1 to localhost:8787)
	$(PNPM) --filter @textral/sandbox dev

sandbox-build: ## V3 sandbox — production build (writes apps/sandbox/dist)
	$(PNPM) --filter @textral/sandbox build

sandbox-typecheck: ## V3 sandbox — typecheck only
	$(PNPM) --filter @textral/sandbox typecheck

mcp-dev: ## MCP — start the stdio server. Requires TEXTRAL_BASE_URL + TEXTRAL_API_KEY env vars.
	@if [ -z "$$TEXTRAL_BASE_URL" ]; then echo "ERROR: TEXTRAL_BASE_URL env var unset" >&2; exit 1; fi
	@if [ -z "$$TEXTRAL_API_KEY" ]; then echo "ERROR: TEXTRAL_API_KEY env var unset" >&2; exit 1; fi
	$(PNPM) --filter @textral/mcp exec node ./bin/textral-mcp.mjs

mcp-typecheck: ## MCP — typecheck @textral/sdk + @textral/mcp + @textral/mcp-validator
	$(PNPM) --filter @textral/sdk typecheck
	$(PNPM) --filter @textral/mcp typecheck
	$(PNPM) --filter @textral/mcp-validator typecheck

mcp-validate: ## MCP — run the cookbook validator against the local self-host stack (HTTP transport). Requires SELFHOST_API_KEY.
	@if [ -z "$$SELFHOST_API_KEY" ]; then echo "ERROR: SELFHOST_API_KEY env var unset. Run \`make selfhost-seed-cookbook\` first and export the printed key." >&2; exit 1; fi
	TEXTRAL_BASE_URL=http://localhost:8787 TEXTRAL_API_KEY=$$SELFHOST_API_KEY \
	  COOKBOOK_NAMESPACE=$${COOKBOOK_NAMESPACE:-cookbook-qdrant} \
	  $(PNPM) --filter @textral/mcp-validator exec tsx index.ts --transport=http
