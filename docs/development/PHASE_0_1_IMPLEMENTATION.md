# Phase 0 + 1 — Implementation Steps

> Companion to `docs/2-PHASES.md`. Concrete, ordered steps for Phase 0
> (repo scaffold) and Phase 1 (Cloudflare substrate + tenancy + BYOK).
>
> A dev should be able to follow this document end-to-end and finish
> Phases 0 and 1 without making design decisions or asking questions.
> Wherever the design doc left a choice open, this document picks one.

**At completion, you will have:** a deployable Worker on Cloudflare
with two environments, a deployable Container, working API-key
authentication, full namespace/tenant/provider-key CRUD, BYOK provider
keys stored in Secrets Store, redaction middleware proven against fuzz
attempts, and a green CI pipeline.

---

## Prerequisites

Before starting, confirm these are installed at the listed minimums:

| Tool | Minimum | Verify |
|------|---------|--------|
| Node | 20.x | `node -v` |
| pnpm | 9.x | `pnpm -v` |
| Docker | 24.x | `docker -v` |
| Wrangler | 3.95 (we use Containers + Vectorize V2) | `npx wrangler -v` |
| Python | 3.12 | `python3 --version` |

Also required:
- A Cloudflare account on the **Workers Paid plan** (Containers and
  Vectorize V2 require it).
- Logged in to wrangler: `npx wrangler login`.
- An OpenAI API key for end-to-end smoke testing in Phase 1.5
  (any tier works; we only issue 1-token validation calls).

---

## Locked-in technology choices

These were left open in the phases doc; locking them now so the rest
of the doc is unambiguous.

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Worker router | **Hono** | Type-safe, first-class CF support, smaller than Express, larger ecosystem than itty-router. |
| Validation | **Zod** | Already required by design doc §4.4. |
| Test runner (Worker) | **Vitest 3.2.4** + **`@cloudflare/vitest-pool-workers` 0.8.55** | Runs against Miniflare; native ESM. We pin both: Vitest 4 + pool 0.15 don't compose (the pool isn't recognized as a runner under Vitest 4's new pool API). 0.8.55 + 3.2.4 is the most recent stable combo. |
| ULID library | **`ulidx`** | Modern ESM, runs in Workers without polyfills. |
| API key hashing | **HMAC-SHA-256 with server-side pepper** | API keys are high-entropy random strings; HMAC + pepper is the industry pattern (Stripe / GitHub PATs). Argon2id is overkill per-request and the design's mention of it is superseded by this implementation choice. |
| Pepper storage | **Cloudflare Secrets Store binding** | Same primitive used for BYOK provider keys. |
| Tenant cache | **Workers KV** with 60 s TTL | Faster than re-reading D1 per request. |
| Container framework | **FastAPI + uvicorn** | Matches v1 RAG core; easy port. |
| Container image base | **`python:3.12-slim`** | Small, well-supported. |
| Lint config style | **Flat ESLint config** (`eslint.config.js`) | Matches `landlord-contracts` reference repo. |
| Module style | **ESM only** (`"type": "module"`) | Worker runtime is ESM-native; avoids dual-package hazards. |

---

## Naming conventions used throughout

```
Cloudflare resources (created in 1.1)
    D1 dev:     textral-dev
    D1 prod:    textral-prod
    R2 dev:     textral-blobs-dev
    R2 prod:    textral-blobs-prod
    Queue dev:  textral-ingest-dev
    Queue prod: textral-ingest-prod
    Vectorize:  textral-{env}-{provider}-{model-with-dashes}-{dims}-{metric}
                 e.g. textral-dev-openai-text-embedding-3-large-3072-cosine
    KV dev:     textral-cache-dev      (binding: CACHE)
    KV prod:    textral-cache-prod
    Secrets dev:  textral-secrets-dev   (binding: SECRETS)
    Secrets prod: textral-secrets-prod

Worker names
    Dev:  textral-api-dev
    Prod: textral-api

Container application name
    Dev:  textral-ingest-dev
    Prod: textral-ingest

Wrangler env switch
    --env dev   → all dev resources
    --env prod  → all prod resources
    (a bare `wrangler deploy` is intentionally non-functional)
```

---

# Phase 0 — Repo Scaffold & Developer Ergonomics

---

## Step 0.1 — pnpm workspace + TypeScript + linting

### 0.1.1 Initialize the workspace root

**Files**
- `pnpm-workspace.yaml`
- `package.json` (root)
- `.gitignore`
- `.npmrc`
- `.editorconfig`

**Contents**

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
  - "tools/*"
```

```jsonc
// package.json (root)
{
  "name": "textral",
  "private": true,
  "type": "module",
  "scripts": {
    "build":     "pnpm -r build",
    "lint":      "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test":      "pnpm -r test"
  },
  "engines": { "node": ">=20", "pnpm": ">=9" },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^20",
    "eslint": "^9",
    "@typescript-eslint/parser": "^8",
    "@typescript-eslint/eslint-plugin": "^8",
    "prettier": "^3"
  }
}
```

```gitignore
# .gitignore
node_modules
dist
.wrangler
.dev.vars
.env
.env.*
!.env.example
*.log
.DS_Store
```

```ini
# .npmrc
node-linker=isolated
```

```ini
# .editorconfig
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.{md,sql}]
trim_trailing_whitespace = false
```

**Acceptance**
```bash
pnpm install                # exits 0
pnpm typecheck              # no source files yet, exits 0
```

---

### 0.1.2 Shared TypeScript config

**Files**
- `tsconfig.base.json`

**Contents**

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true
  }
}
```

**Acceptance**
- File parses (`pnpm exec tsc -p tsconfig.base.json --noEmit` returns
  with "no inputs found" — that's expected at this point).

---

### 0.1.3 Linting and formatting

**Files**
- `eslint.config.js`
- `.prettierrc`

**Contents**

```js
// eslint.config.js — flat config
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: false }
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off"
    }
  }
];
```

```jsonc
// .prettierrc
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "semi": true
}
```

**Acceptance**
```bash
pnpm exec eslint .          # exits 0 (no source yet)
pnpm exec prettier --check .  # exits 0
```

---

## Step 0.2 — `apps/api` Worker skeleton

### 0.2.1 Worker package scaffold

**Files**
- `apps/api/package.json`
- `apps/api/tsconfig.json`

**Contents**

```jsonc
// apps/api/package.json
{
  "name": "@textral/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "dev":       "wrangler dev --env dev",
    "deploy:dev":  "wrangler deploy --env dev",
    "deploy:prod": "wrangler deploy --env prod",
    "typecheck": "tsc --noEmit",
    "lint":      "eslint src",
    "test":      "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@textral/contracts": "workspace:*",
    "hono": "^4.6.0",
    "ulidx": "^2.4.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4",
    "@cloudflare/vitest-pool-workers": "^0.8.55",
    "vitest": "~3.2.4",
    "tsx": "^4.19.0",
    "wrangler": "^3.95"
  }
}
```

```jsonc
// apps/api/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types"],
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src/**/*", "test/**/*"]
}
```

**Acceptance**
```bash
pnpm install
pnpm --filter @textral/api typecheck    # exits 0 once src/ exists
```

---

### 0.2.2 Wrangler config (dev + prod environments)

**Files**
- `apps/api/wrangler.toml`

**Contents**

```toml
name = "textral-api"
main = "src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = false
preview_urls = false

# Persist worker logs to the dashboard for ~3 days. Critical for
# diagnosing failures after the fact.
[observability]
enabled = true
head_sampling_rate = 1.0

# ── prod ──────────────────────────────────────────────────────
[env.prod]
name = "textral-api"
workers_dev = false
preview_urls = false

[env.prod.vars]
ENV = "prod"
ENABLE_DEBUG_ROUTES = "false"
ALLOWED_ORIGINS = "https://textral.example.com"

# (D1, R2, Queues, Vectorize, KV, Secrets, Container bindings added in 1.1)

# ── dev ───────────────────────────────────────────────────────
[env.dev]
name = "textral-api-dev"
workers_dev = true
preview_urls = false

[env.dev.vars]
ENV = "dev"
ENABLE_DEBUG_ROUTES = "true"
ALLOWED_ORIGINS = "http://localhost:5173"

# ── test ──────────────────────────────────────────────────────
# Used by vitest-pool-workers (see vitest.config.ts in 0.2.4).
# Bindings are deliberately minimal:
#   • No Secrets Store binding — miniflare can't inline-stub one. We
#     replace API_KEY_PEPPER with a plain string here; the
#     readPepper(env) helper (Phase 1.3) accepts both shapes.
#   • No Vectorize / AI Gateway / Containers — no local emulation;
#     later-phase tests stub them per-suite.
# Phase 1.1 will add D1, R2, KV bindings here too.
[env.test]
name = "textral-api-test"
workers_dev = false

[env.test.vars]
ENV = "dev"
ENABLE_DEBUG_ROUTES = "true"
ALLOWED_ORIGINS = "http://localhost:5173"
API_KEY_PEPPER = "test-pepper-do-not-use-in-prod"
```

> Note: this is the Phase 0 skeleton. We add D1/R2/Queues/Vectorize/KV/
> Secrets bindings in Step 1.1 and the Container binding in Step 0.3.3.
> The `[env.test]` block grows the same D1/R2/KV bindings (just no
> Secrets Store / Vectorize / Containers).

**Acceptance**
```bash
cd apps/api
npx wrangler whoami         # confirms login
```

---

### 0.2.3 Hono app entry point

**Files**
- `apps/api/src/index.ts`
- `apps/api/src/types.ts`
- `apps/api/src/routes/health.ts`

**Contents (high level)**

```ts
// apps/api/src/types.ts
export interface Env {
  ENV: 'dev' | 'prod';
  ENABLE_DEBUG_ROUTES: string;          // "true"|"false"
  ALLOWED_ORIGINS: string;
  // bindings filled in by Phase 1:
  // DB: D1Database;
  // BLOBS: R2Bucket;
  // INGEST_QUEUE: Queue;
  // VECTORIZE_LARGE: VectorizeIndex;
  // CACHE: KVNamespace;
  // SECRETS: SecretsStoreSecret;
  // INGEST_CONTAINER: DurableObjectNamespace; // added in 0.3.3
}

export type Variables = {
  // populated by middleware
  // tenant_id?: string;
  // request_id: string;
};
```

```ts
// apps/api/src/index.ts
import { Hono } from 'hono';
import type { Env, Variables } from './types';
import { healthRoute } from './routes/health';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.route('/healthz', healthRoute);
app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

export default {
  async fetch(req, env, ctx) {
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

```ts
// apps/api/src/routes/health.ts
import { Hono } from 'hono';
import type { Env, Variables } from '../types';

export const healthRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

healthRoute.get('/', (c) => c.json({ status: 'ok', env: c.env.ENV, ts: Date.now() }));
```

**Acceptance**
```bash
cd apps/api
npx wrangler dev --env dev --port 8787
# in another terminal:
curl -s http://localhost:8787/healthz
# → {"status":"ok","env":"dev","ts":...}

npx wrangler deploy --env dev
curl -s https://textral-api-dev.<your-subdomain>.workers.dev/healthz
# → {"status":"ok","env":"dev","ts":...}
```

---

### 0.2.4 Vitest setup

**Files**
- `apps/api/vitest.config.ts`
- `apps/api/test/setup.ts`           ← global setup, applies D1 migrations
- `apps/api/test/helpers/fetch.ts`   ← canonical Worker invocation helper
- `apps/api/test/health.test.ts`

> Use a **separate `[env.test]` block in `wrangler.toml`** for test runs
> (defined in 0.2.2). Two reasons: (1) Secrets Store has no inline test
> stub in miniflare, so we replace `API_KEY_PEPPER` with a plain string
> in test mode; the `readPepper(env)` helper in Phase 1.3 transparently
> accepts both shapes. (2) Vectorize, AI Gateway, and Containers have
> no local emulation — the test env omits them; later-phase tests stub
> them per-suite as needed.

**Contents**

```ts
// apps/api/vitest.config.ts
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml', environment: 'test' },
        miniflare: {
          // Migrations are read at config-resolution time and applied
          // by the setup file via `applyD1Migrations`. The pool does
          // NOT auto-apply `migrations_dir` from wrangler.toml.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      },
    },
  },
});
```

```ts
// apps/api/test/setup.ts
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import type { D1Migration } from '@cloudflare/vitest-pool-workers/config';
import type { Env } from '../src/types.js';

beforeAll(async () => {
  const e = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
});
```

```ts
// apps/api/test/helpers/fetch.ts
//
// Wraps the Worker handler with the necessary cast: `new Request(...)`
// has `cf: CfProperties<unknown>` while ExportedHandler.fetch expects
// `cf: IncomingRequestCfProperties<unknown>` (the runtime synthesizes
// the extra fields; client construction can't). One cast lives here so
// no test file has to re-cast.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/index.js';
import type { Env } from '../../src/types.js';

export async function callWorker(env: Env, req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    req as unknown as Parameters<NonNullable<typeof worker.fetch>>[0],
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export async function callJson(
  env: Env, method: string, url: string,
  headers: Record<string, string> = {}, body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return callWorker(env, new Request(url, init));
}
```

```ts
// apps/api/test/health.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

describe('healthz', () => {
  it('returns ok', async () => {
    const res = await callJson(env as unknown as Env, 'GET', 'http://x/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});
```

**Acceptance**
```bash
pnpm --filter @textral/api test
# 1 passed
```

> **`pnpm install` warning to ignore:** "Ignored build scripts: esbuild,
> sharp, workerd." These post-install scripts are convenience-only.
> `pnpm approve-builds` lets you opt in interactively, but the tests
> work without it. Don't chase this warning.

---

## Step 0.3 — `apps/ingest` Container skeleton

### 0.3.1 Python application skeleton

**Files**
- `apps/ingest/app/__init__.py`
- `apps/ingest/app/main.py`
- `apps/ingest/requirements.txt`
- `apps/ingest/Dockerfile`
- `apps/ingest/.dockerignore`

**Contents**

```python
# apps/ingest/app/main.py
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="textral-ingest", version="0.0.0")

@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": "textral-ingest"}

class JobRequest(BaseModel):
    job_id: str
    tenant_id: str
    document_id: str
    version_id: str

@app.post("/jobs/run")
def run_job(req: JobRequest):
    # Stub. Real pipeline lands in Phase 3.
    return {"job_id": req.job_id, "status": "noop_completed"}
```

```
# apps/ingest/requirements.txt
fastapi==0.115.0
uvicorn[standard]==0.30.6
pydantic==2.9.2
httpx==0.27.2
```

```dockerfile
# apps/ingest/Dockerfile
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```
# apps/ingest/.dockerignore
__pycache__
*.pyc
.venv
.pytest_cache
.mypy_cache
node_modules
```

**Acceptance**
```bash
cd apps/ingest
docker build -t textral-ingest:dev .
docker run --rm -p 8000:8000 textral-ingest:dev
# in another shell:
curl -s http://localhost:8000/healthz
# → {"status":"ok","service":"textral-ingest"}
```

---

### 0.3.2 Container application config (Wrangler)

**Files**
- `apps/api/wrangler.toml` (extended)

**Add to both `[env.dev]` and `[env.prod]` blocks** (paths shown for dev):

```toml
[[env.dev.containers]]
class_name   = "IngestContainer"
image        = "../ingest/Dockerfile"
max_instances = 3
# instance_type = "standard"   # uncomment when set up
# Sleep when idle. Containers cold-start in ~5–10 s.
# Acceptable for queue-driven ingestion.
# (See docs/1-DESIGN.md §3.2 for the rationale.)

[[env.dev.durable_objects.bindings]]
class_name = "IngestContainer"
name       = "INGEST_CONTAINER"

[[env.dev.migrations]]
tag = "v1"
new_sqlite_classes = ["IngestContainer"]
```

**Acceptance**
```bash
# Build the image and confirm it succeeds:
cd apps/api
npx wrangler containers build ../ingest -t textral-ingest:dev
```

---

### 0.3.3 Worker → Container handshake

**Files**
- `apps/api/src/lib/container.ts`
- `apps/api/src/routes/dev/ingest-ping.ts`
- `apps/api/src/index.ts` (extended)

**Contents**

```ts
// apps/api/src/lib/container.ts
import { Container } from '@cloudflare/containers';
import type { Env } from '../types.js';
// `@cloudflare/containers` is a separate package (we install ^0.3.0).
// `wrangler containers ...` commands ship with wrangler 3.95+.

// `defaultPort` and `sleepAfter` exist on the base Container class, so
// `override` is required under our `noImplicitOverride` tsconfig setting.
export class IngestContainer extends Container<Env> {
  override defaultPort = 8000;
  override sleepAfter = '10m';
}

export async function callContainer(
  binding: DurableObjectNamespace,
  routingKey: string,
  request: Request,
): Promise<Response> {
  const id = binding.idFromName(routingKey);
  const stub = binding.get(id);
  return stub.fetch(request);
}
```

```ts
// apps/api/src/routes/dev/ingest-ping.ts
import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

export const devIngestPing = new Hono<{ Bindings: Env; Variables: Variables }>();

devIngestPing.get('/', async (c) => {
  if (c.env.ENABLE_DEBUG_ROUTES !== 'true') return c.notFound();
  // Cast widening — full env type lands in 1.1.
  const env = c.env as unknown as { INGEST_CONTAINER: DurableObjectNamespace };
  const id = env.INGEST_CONTAINER.idFromName('ping');
  const stub = env.INGEST_CONTAINER.get(id);
  const res = await stub.fetch('http://container/healthz');
  return c.json({ container: await res.json() });
});
```

```ts
// apps/api/src/index.ts (add)
import { devIngestPing } from './routes/dev/ingest-ping';
// Re-export the Container class so the runtime can find it:
export { IngestContainer } from './lib/container';

// inside the Hono app:
app.route('/dev/ingest-ping', devIngestPing);
```

**Acceptance**
```bash
# Push the image to Cloudflare's managed registry:
cd apps/api
npx wrangler containers push textral-ingest:dev

# Deploy the worker (which provisions the Container application):
npx wrangler deploy --env dev

# Hit the ping route and verify a round-trip:
curl -s https://textral-api-dev.<subdomain>.workers.dev/dev/ingest-ping
# → {"container":{"status":"ok","service":"textral-ingest"}}
```

First request may take 5–10 s (cold start). Subsequent requests under 200 ms.

---

## Step 0.4 — `packages/contracts` skeleton

### 0.4.1 Contracts package scaffold

**Files**
- `packages/contracts/package.json`
- `packages/contracts/tsconfig.json`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/id.ts`
- `packages/contracts/src/error.ts`

**Contents**

```jsonc
// packages/contracts/package.json
{
  "name": "@textral/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build":     "tsc",
    "typecheck": "tsc --noEmit",
    "lint":      "eslint src",
    "test":      "vitest run"
  },
  "dependencies": {
    "ulidx": "^2.4.0",
    "zod":   "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest":     "~3.2.4"
  }
}
```

```jsonc
// packages/contracts/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

```ts
// packages/contracts/src/id.ts
import { ulid } from 'ulidx';

export type Prefix =
  | 'ten'   // tenant
  | 'ns'    // namespace
  | 'doc'   // document
  | 'ver'   // version
  | 'job'   // ingestion job
  | 'chunk'
  | 'ak'    // api key
  | 'pkey'  // provider key
  | 'qev';  // query event

/** Generate a prefixed ULID identifier, e.g. `doc_01HZ8YQ8P...` */
export function newId(prefix: Prefix): string {
  return `${prefix}_${ulid()}`;
}

/** Parse a prefixed ID; throws if shape is wrong. */
export function parseId(id: string, expectedPrefix: Prefix): { prefix: Prefix; ulid: string } {
  const idx = id.indexOf('_');
  if (idx === -1) throw new Error(`Malformed id: ${id}`);
  const prefix = id.slice(0, idx) as Prefix;
  if (prefix !== expectedPrefix) throw new Error(`Expected ${expectedPrefix} id, got ${prefix}`);
  return { prefix, ulid: id.slice(idx + 1) };
}
```

```ts
// packages/contracts/src/error.ts
import { z } from 'zod';

/** Stable error codes — extended in Phase 6.1. Phase 0/1 starter set: */
export const ErrorCode = z.enum([
  'INVALID_API_KEY',
  'TENANT_NOT_FOUND',
  'NAMESPACE_NOT_FOUND',
  'NAMESPACE_ALREADY_EXISTS',
  'PROVIDER_KEY_NOT_FOUND',
  'PROVIDER_KEY_VALIDATION_FAILED',
  'NOT_FOUND',
  'BAD_REQUEST',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code:        ErrorCode,
    message:     z.string(),
    request_id:  z.string().optional(),
    details:     z.record(z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export class TextralError extends Error {
  constructor(
    public code: ErrorCode,
    public httpStatus: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
```

```ts
// packages/contracts/src/index.ts
export * from './id';
export * from './error';
```

**Acceptance**
```bash
pnpm --filter @textral/contracts typecheck    # exits 0
```

Then in `apps/api/src/routes/health.ts` swap the inline 200 body for
something using `@textral/contracts`:

```ts
import { newId } from '@textral/contracts';
healthRoute.get('/', (c) => c.json({ status: 'ok', env: c.env.ENV, request_id: newId('qev') }));
```

```bash
pnpm --filter @textral/api typecheck    # still exits 0
curl -s http://localhost:8787/healthz   # request_id present
```

---

## Step 0.5 — CI + Makefile + secrets convention

### 0.5.1 Makefile

**Files**
- `Makefile` (root)

**Contents**

```makefile
.DEFAULT_GOAL := help

.PHONY: help install typecheck lint test \
        dev-api dev-ingest \
        build-ingest push-ingest \
        deploy-dev deploy-prod \
        migrate-dev migrate-prod \
        secret-put-dev secret-put-prod

help: ## Show this help
	@awk 'BEGIN { FS = ":.*##"; printf "Usage: make <target>\n\nTargets:\n" } /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install workspace dependencies
	pnpm install

typecheck: ## Typecheck all packages
	pnpm -r typecheck

lint: ## Lint all packages
	pnpm -r lint

test: ## Run all tests
	pnpm -r test

dev-api: ## Run the Worker locally against dev bindings
	pnpm --filter @textral/api dev

dev-ingest: ## Run the Container locally
	cd apps/ingest && uvicorn app.main:app --reload --port 8000

build-ingest: ## Build the Container image
	cd apps/api && npx wrangler containers build ../ingest -t textral-ingest:dev

push-ingest: build-ingest ## Push the Container image to Cloudflare's registry
	cd apps/api && npx wrangler containers push textral-ingest:dev

deploy-dev: ## Deploy Worker + Container application to the dev env
	cd apps/api && npx wrangler deploy --env dev

deploy-prod: ## Deploy Worker + Container application to the prod env
	cd apps/api && npx wrangler deploy --env prod

migrate-dev: ## Apply D1 migrations to dev
	cd apps/api && npx wrangler d1 migrations apply textral-dev --env dev

migrate-prod: ## Apply D1 migrations to prod
	cd apps/api && npx wrangler d1 migrations apply textral-prod --env prod

secret-put-dev: ## Put a secret into the dev Worker (interactive)
	cd apps/api && npx wrangler secret put $(NAME) --env dev

secret-put-prod: ## Put a secret into the prod Worker (interactive)
	cd apps/api && npx wrangler secret put $(NAME) --env prod
```

**Acceptance**
```bash
make help    # shows the target list
make install
make typecheck
```

---

### 0.5.2 GitHub Actions CI

**Files**
- `.github/workflows/ci.yml`

**Contents**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r typecheck
      - run: pnpm -r lint
      - run: pnpm -r test
```

**Acceptance**
- Open a no-op PR and confirm the workflow passes.

---

### 0.5.3 Secrets convention

**Files**
- `SECRETS.md` (root)

**Contents (high level)**
- One markdown table per environment (dev, prod) listing the required
  secrets.
- For Phase 0/1, the table contains:

| Secret | Where set | Purpose |
|--------|-----------|---------|
| `API_KEY_PEPPER` | `wrangler secret put` | Server-side pepper for HMAC-hashing customer API keys |
| `ADMIN_BOOTSTRAP_TOKEN` | `wrangler secret put` | One-time bootstrap token for creating the first tenant |

Phase 2 will add provider-related secrets.

**Acceptance**
- `SECRETS.md` exists and lists every secret the system depends on.
- Anyone can run `make secret-put-dev NAME=API_KEY_PEPPER` and get a
  prompt.

---

### 0.5.4 Phase 0 close-out

**Acceptance (Phase 0 exit gate)**
```bash
make install                          # green
make typecheck                        # green
make lint                             # green
make test                             # green
make deploy-dev                       # Worker live
curl -s https://textral-api-dev.<subdomain>.workers.dev/healthz   # ok
curl -s https://textral-api-dev.<subdomain>.workers.dev/dev/ingest-ping   # round-trip ok
```

---

# Phase 1 — Cloudflare Substrate, Tenancy & BYOK

---

## Step 1.1 — Provision dev/prod resources

This is one-time setup per environment. Output IDs go into
`docs/runbooks/PROVISIONING.md` and into `apps/api/wrangler.toml`.

### 1.1.1 Create D1 databases

**Commands**
```bash
npx wrangler d1 create textral-dev
npx wrangler d1 create textral-prod
```

Each command prints a `database_id` UUID. Copy both.

**Acceptance**
```bash
npx wrangler d1 list   # both databases visible
```

---

### 1.1.2 Create R2 buckets

**Commands**
```bash
npx wrangler r2 bucket create textral-blobs-dev
npx wrangler r2 bucket create textral-blobs-prod
```

**Acceptance**
```bash
npx wrangler r2 bucket list   # both buckets visible
```

---

### 1.1.3 Create Queues

**Commands**
```bash
npx wrangler queues create textral-ingest-dev
npx wrangler queues create textral-ingest-prod
```

**Acceptance**
```bash
npx wrangler queues list      # both queues visible
```

---

### 1.1.4 Create Vectorize indexes

We provision **one index per supported embedding profile**. Phase 1
provisions only the OpenAI 3-large profile (3072 dim). Additional
profiles get added during Phase 5 alongside their corpus profiles.

**Commands**
```bash
# Dev
npx wrangler vectorize create textral-dev-openai-text-embedding-3-large-3072-cosine \
  --dimensions=3072 --metric=cosine

# Prod
npx wrangler vectorize create textral-prod-openai-text-embedding-3-large-3072-cosine \
  --dimensions=3072 --metric=cosine

# Pre-declare metadata indexes on each (max 10 per index).
# These are the filters every query relies on.
for env in dev prod; do
  IDX="textral-${env}-openai-text-embedding-3-large-3072-cosine"
  for prop in tenant_id namespace_id document_id version_id artifact_type; do
    npx wrangler vectorize create-metadata-index "$IDX" \
      --property-name=$prop --type=string
  done
done
```

**Acceptance**
```bash
npx wrangler vectorize list   # both indexes visible
npx wrangler vectorize list-metadata-index \
  textral-dev-openai-text-embedding-3-large-3072-cosine
# → 5 metadata indexes listed
```

---

### 1.1.5 Create KV namespaces (tenant cache)

**Commands**
```bash
npx wrangler kv namespace create textral-cache-dev
npx wrangler kv namespace create textral-cache-prod
```

Each prints a namespace ID. Copy both.

---

### 1.1.6 Create Secrets Store namespaces

Used in Phase 1.5 (BYOK provider keys) and for the API key pepper.

**Commands**
```bash
npx wrangler secrets-store store create textral-secrets-dev
npx wrangler secrets-store store create textral-secrets-prod
```

Each prints a store ID. Copy both.

**Acceptance**
```bash
npx wrangler secrets-store store list
# → both stores visible
```

---

### 1.1.7 Wire bindings into wrangler.toml

**Files**
- `apps/api/wrangler.toml` (extended)

Replace the dev/prod env blocks (skeleton from 0.2.2) with bindings:

```toml
# ── prod ──────────────────────────────────────────────────────
[env.prod]
name = "textral-api"
workers_dev = false
preview_urls = false

[env.prod.vars]
ENV = "prod"
ENABLE_DEBUG_ROUTES = "false"
ALLOWED_ORIGINS = "https://textral.example.com"

[[env.prod.d1_databases]]
binding        = "DB"
database_name  = "textral-prod"
database_id    = "PASTE_PROD_D1_UUID_HERE"
migrations_dir = "migrations"

[[env.prod.r2_buckets]]
binding     = "BLOBS"
bucket_name = "textral-blobs-prod"

[[env.prod.queues.producers]]
binding = "INGEST_QUEUE"
queue   = "textral-ingest-prod"

[[env.prod.queues.consumers]]
queue                  = "textral-ingest-prod"
max_batch_size         = 1
max_batch_timeout      = 5
max_retries            = 3
dead_letter_queue      = "textral-ingest-prod-dlq"

[[env.prod.vectorize]]
binding    = "VECTORIZE_OPENAI_LARGE"
index_name = "textral-prod-openai-text-embedding-3-large-3072-cosine"

[[env.prod.kv_namespaces]]
binding = "CACHE"
id      = "PASTE_PROD_KV_ID_HERE"

[[env.prod.secrets_store_secrets]]
binding   = "API_KEY_PEPPER"
store_id  = "PASTE_PROD_SECRETS_STORE_ID_HERE"
secret_name = "api-key-pepper"

[[env.prod.containers]]
class_name    = "IngestContainer"
image         = "../ingest/Dockerfile"
max_instances = 5

[[env.prod.durable_objects.bindings]]
class_name = "IngestContainer"
name       = "INGEST_CONTAINER"

[[env.prod.migrations]]
tag = "v1"
new_sqlite_classes = ["IngestContainer"]

# ── dev ───────────────────────────────────────────────────────
# (mirror of the above with -dev suffixes; remote=true on bindings
#  that have no local emulation, e.g. Vectorize, Containers.)
```

> Also create the `textral-ingest-prod-dlq` and -dev-dlq queues:
> ```bash
> npx wrangler queues create textral-ingest-dev-dlq
> npx wrangler queues create textral-ingest-prod-dlq
> ```

**Acceptance**
```bash
cd apps/api
npx wrangler deploy --env dev   # all bindings resolve
```

---

### 1.1.8 Provisioning runbook

**Files**
- `docs/runbooks/PROVISIONING.md`

**Contents**
- A copy-paste log of the IDs created in 1.1.1–1.1.6 for each env.
- The exact commands above, in order, so the steps are reproducible
  on a fresh CF account.
- A note: prod-side provisioning happens once during go-live, not
  during dev iteration.

**Acceptance**
- A second engineer can stand up a parallel "staging" environment
  using only the runbook and finish in under 30 minutes.

---

### 1.1.9 Set the API key pepper

**Commands**
```bash
# Generate a 32-byte random hex pepper:
PEPPER=$(openssl rand -hex 32)

# Put it into Secrets Store under the binding-referenced name:
npx wrangler secrets-store secret put api-key-pepper \
  --store textral-secrets-dev --value "$PEPPER"

# Repeat for prod with a *different* pepper:
PEPPER=$(openssl rand -hex 32)
npx wrangler secrets-store secret put api-key-pepper \
  --store textral-secrets-prod --value "$PEPPER"
```

**Acceptance**
```bash
npx wrangler secrets-store secret list --store textral-secrets-dev
# → contains api-key-pepper
```

---

## Step 1.2 — D1 baseline migrations

### 1.2.1 Migration 0001 — baseline schema

**Files**
- `apps/api/migrations/0001_baseline.sql`

**Contents**

```sql
-- 0001_baseline.sql — tenants, api_keys, namespaces, provider_keys, usage_records.
-- See docs/1-DESIGN.md §5.1 for the canonical schema reference.

PRAGMA foreign_keys = ON;

-- ── Tenants ─────────────────────────────────────────────────────
CREATE TABLE tenants (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    plan         TEXT NOT NULL DEFAULT 'free',
    created_at   INTEGER NOT NULL,
    deleted_at   INTEGER
);

-- ── API keys ────────────────────────────────────────────────────
-- key_hash is HMAC-SHA-256(server_pepper, raw_key) stored as a hex string.
-- Implementation choice supersedes the design doc's argon2id mention —
-- API keys are high-entropy random strings, so HMAC + pepper is the
-- correct primitive (matches Stripe / GitHub PAT model).
CREATE TABLE api_keys (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL REFERENCES tenants(id),
    key_hash      TEXT NOT NULL UNIQUE,
    key_prefix    TEXT NOT NULL,           -- first 12 chars for display only
    scopes        TEXT NOT NULL,           -- JSON array
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    revoked_at    INTEGER
);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX idx_api_keys_active ON api_keys(key_hash) WHERE revoked_at IS NULL;

-- ── Namespaces ──────────────────────────────────────────────────
CREATE TABLE namespaces (
    id                          TEXT PRIMARY KEY,
    tenant_id                   TEXT NOT NULL REFERENCES tenants(id),
    slug                        TEXT NOT NULL,
    corpus_profile              TEXT NOT NULL DEFAULT 'generic',
    default_embedding_profile   TEXT NOT NULL DEFAULT 'openai-text-embedding-3-large',
    default_inference_model     TEXT,
    default_prompt_template_id  TEXT,
    created_at                  INTEGER NOT NULL,
    UNIQUE(tenant_id, slug)
);

-- ── Provider key registrations (BYOK) ───────────────────────────
-- The encrypted raw key lives in Secrets Store (referenced by
-- secrets_store_secret_name). Only metadata lives in D1.
CREATE TABLE provider_keys (
    id                       TEXT PRIMARY KEY,
    tenant_id                TEXT NOT NULL REFERENCES tenants(id),
    provider                 TEXT NOT NULL,
    label                    TEXT NOT NULL,
    secrets_store_secret_name TEXT NOT NULL,
    last_validated_at        INTEGER,
    last_error_code          TEXT,
    created_at               INTEGER NOT NULL,
    revoked_at               INTEGER,
    UNIQUE(tenant_id, provider, label)
);
CREATE INDEX idx_provider_keys_tenant ON provider_keys(tenant_id);

-- ── Usage records ───────────────────────────────────────────────
CREATE TABLE usage_records (
    tenant_id        TEXT NOT NULL,
    period_start     INTEGER NOT NULL,
    queries          INTEGER NOT NULL DEFAULT 0,
    ingestion_jobs   INTEGER NOT NULL DEFAULT 0,
    input_tokens     INTEGER NOT NULL DEFAULT 0,
    output_tokens    INTEGER NOT NULL DEFAULT 0,
    embedding_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(tenant_id, period_start)
);
```

**Apply**
```bash
make migrate-dev
```

**Acceptance**
```bash
npx wrangler d1 execute textral-dev --env dev \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
# → tenants, api_keys, namespaces, provider_keys, usage_records, plus _cf_KV / d1_migrations
```

---

### 1.2.2 Dev seed script

**Files**
- `apps/api/scripts/seed-dev.ts`
- `apps/api/scripts/tsconfig.json`

**Contents (high level)**
- Reads `ADMIN_BOOTSTRAP_TOKEN` from env; refuses if not set.
- Hits the deployed dev Worker's `POST /v1/admin/bootstrap` endpoint
  (added in 1.4.4) to create:
  - One tenant (`ten_dev_seed`)
  - One namespace (`ns_dev_default`, profile `generic`)
  - One API key (writes the raw key to stdout once)
- Idempotent: re-running with the same `ADMIN_BOOTSTRAP_TOKEN` exits
  with the existing IDs.

**Add to Makefile**
```makefile
seed-dev: ## Seed the dev D1 with a tenant + namespace + api key
	pnpm --filter @textral/api exec tsx scripts/seed-dev.ts
```

**Acceptance**
```bash
ADMIN_BOOTSTRAP_TOKEN=$(openssl rand -hex 16) make seed-dev
# → tenant=ten_..., namespace=ns_..., api_key=tx_live_...
make seed-dev   # second run prints the same IDs (no duplicate rows)
```

> The seed script depends on Step 1.4.4 (admin bootstrap endpoint)
> and is therefore actually written *after* that step. The Makefile
> target lands here so the convention is in place.

---

## Step 1.3 — API key authentication middleware

### 1.3.1 Key generation + hashing helpers

**Files**
- `apps/api/src/auth/api-key.ts`

**Contents**

```ts
// Format:  tx_live_<26-char-ulid>_<32-char-secret>
//          tx_test_<26-char-ulid>_<32-char-secret>   (reserved)
//
// HMAC the entire string against the server-side pepper to derive
// key_hash. Lookup is O(1) via the unique index on key_hash.

import { ulid } from 'ulidx';

const ENCODER = new TextEncoder();

export interface GeneratedKey {
  id:        string;        // ak_<ulid>
  raw:       string;        // returned to caller exactly once
  prefix:    string;        // first 12 chars
  hash:      string;        // hex HMAC-SHA-256
}

function randomSecret(byteLen = 20): string {
  // 20 raw bytes → exactly 32 base32 chars (160 bits of entropy).
  // 24 bytes would yield 39 chars due to base32's 5-bit grouping;
  // we want a fixed-shape regex `[A-Z2-7]{32}` to match.
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return base32(buf);
}

function base32(buf: Uint8Array): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

export async function generateApiKey(pepper: string): Promise<GeneratedKey> {
  const u = ulid();
  const secret = randomSecret(20);
  const raw = `tx_live_${u}_${secret}`;
  return {
    id:     `ak_${u}`,
    raw,
    prefix: raw.slice(0, 12),
    hash:   await hmacKey(pepper, raw),
  };
}

export async function hmacKey(pepper: string, raw: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', keyMaterial, ENCODER.encode(raw));
  return toHex(new Uint8Array(sig));
}

function toHex(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

**Acceptance**
- Unit test in `apps/api/test/api-key.test.ts`:
  - `generateApiKey` returns a string matching `/^tx_live_[A-Z0-9]{26}_[A-Z2-7]{32}$/`.
  - `hmacKey(pepper, raw)` is deterministic and 64 chars.
  - `hmacKey(pepper, raw) !== hmacKey(other_pepper, raw)`.

---

### 1.3.2 Auth middleware + tenant resolution + pepper helper

**Files**
- `apps/api/src/auth/pepper.ts`        ← reads pepper from either binding shape
- `apps/api/src/auth/middleware.ts`
- `apps/api/src/auth/tenant-cache.ts`

**Why `readPepper(env)` exists.** In production the pepper is bound via
Cloudflare Secrets Store (`SecretsStoreSecret` with a `.get()` method).
In the test env it's bound as a plain string (miniflare doesn't
inline-stub Secrets Store). One helper hides the shape difference; no
caller has to know which env it's running in.

```ts
// apps/api/src/auth/pepper.ts
import type { Env } from '../types.js';
import { TextralError } from '@textral/contracts';

export async function readPepper(env: Env): Promise<string> {
  const binding = env.API_KEY_PEPPER as unknown;
  let value: string | undefined;
  if (typeof binding === 'string') {
    value = binding;
  } else if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    value = await (binding as { get: () => Promise<string> }).get();
  }
  if (!value) throw new TextralError('INTERNAL', 500, 'API_KEY_PEPPER not configured');
  return value;
}
```

**Contents (high level)**

```ts
// apps/api/src/auth/middleware.ts
//
// Order of operations on every /v1/* request:
//   1. Read X-Textral-Api-Key header (reject if missing).
//   2. Compute hmacKey(readPepper(env), header).
//   3. Cache lookup by key_hash → resolved tenant (KV TTL 60 s).
//   4. On miss: SELECT tenant_id FROM api_keys
//                WHERE key_hash = ? AND revoked_at IS NULL.
//   5. Populate Hono context: c.set('tenant_id', ...), c.set('api_key_id', ...).
//   6. Best-effort fire-and-forget UPDATE last_used_at via ctx.waitUntil.
//   7. On miss after DB lookup: throw TextralError('INVALID_API_KEY', 401, ...).

import { createMiddleware } from 'hono/factory';
import { TextralError } from '@textral/contracts';
import { hmacKey } from './api-key.js';
import { readPepper } from './pepper.js';
import { resolveTenantFromCache, cacheTenant } from './tenant-cache.js';

export const requireApiKey = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    const raw = c.req.header('X-Textral-Api-Key');
    if (!raw) throw new TextralError('INVALID_API_KEY', 401, 'Missing X-Textral-Api-Key');

    const pepper = await readPepper(c.env);
    const keyHash = await hmacKey(pepper, raw);

    let resolved = await resolveTenantFromCache(c.env.CACHE, keyHash);
    if (!resolved) {
      const row = await c.env.DB.prepare(
        `SELECT id AS api_key_id, tenant_id FROM api_keys
         WHERE key_hash = ? AND revoked_at IS NULL`,
      ).bind(keyHash).first<{ api_key_id: string; tenant_id: string }>();
      if (!row) throw new TextralError('INVALID_API_KEY', 401, 'API key invalid or revoked');
      resolved = row;
      c.executionCtx.waitUntil(cacheTenant(c.env.CACHE, keyHash, resolved));
    }
    c.set('tenant_id', resolved.tenant_id);
    c.set('api_key_id', resolved.api_key_id);
    c.executionCtx.waitUntil(
      c.env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
        .bind(Date.now(), resolved.api_key_id).run(),
    );
    await next();
  },
);
```

```ts
// apps/api/src/auth/tenant-cache.ts
const TTL_SECS = 60;

export async function resolveTenantFromCache(kv: KVNamespace, keyHash: string) {
  return kv.get<{ api_key_id: string; tenant_id: string }>(`auth:${keyHash}`, 'json');
}
export async function cacheTenant(kv: KVNamespace, keyHash: string, v: object) {
  await kv.put(`auth:${keyHash}`, JSON.stringify(v), { expirationTtl: TTL_SECS });
}
```

Update `apps/api/src/index.ts` to:
- Apply `requireApiKey` to `/v1/*` only (not `/healthz`, not `/dev/*`).
- Add a global error handler that turns `TextralError` into the
  envelope shape (full implementation lands in Phase 6.1; for now,
  inline a small handler).

**Acceptance**
- Add a stub route `GET /v1/me` that returns `{ tenant_id }` from the
  context.
- Test:
  ```bash
  curl -i http://localhost:8787/v1/me                       # 401, INVALID_API_KEY
  curl -i -H "X-Textral-Api-Key: bad" http://localhost:8787/v1/me   # 401
  # After running seed-dev:
  curl -s -H "X-Textral-Api-Key: <SEEDED_KEY>" http://localhost:8787/v1/me
  # → {"tenant_id":"ten_..."}
  ```

---

## Step 1.4 — Namespaces + tenants + API key endpoints

### 1.4.1 Namespace contracts

**Files**
- `packages/contracts/src/namespace.ts`

**Contents (high level)**
- Zod schemas: `NamespaceCreate`, `Namespace`, `NamespaceUpdate`.
- A `slug` validator: `/^[a-z][a-z0-9-]{1,30}$/`.
- Re-export from `packages/contracts/src/index.ts`.

---

### 1.4.2 Namespace routes

**Files**
- `apps/api/src/routes/namespaces.ts`
- `apps/api/src/db/namespaces.ts`

**Contents (high level)**

```
POST   /v1/namespaces                  → create (validates Zod, INSERT)
GET    /v1/namespaces                  → list for the resolved tenant
GET    /v1/namespaces/:slug            → get one (404 if not owned)
PATCH  /v1/namespaces/:slug            → partial update
DELETE /v1/namespaces/:slug            → soft-delete (write deleted_at)
```

Every query MUST include `WHERE tenant_id = ?` against the
context-resolved tenant. Helpers in `db/namespaces.ts` enforce this
by accepting `tenant_id` as a non-optional first argument.

**Acceptance**
- Vitest E2E (`test/namespaces.test.ts`):
  ```ts
  // 1. Create namespace 'leases'
  // 2. List → contains 'leases'
  // 3. Patch description
  // 4. Get → reflects update
  // 5. Delete → 204
  // 6. Get → 404 NAMESPACE_NOT_FOUND
  // 7. Cross-tenant: with API key for tenant B, GET /v1/namespaces/leases → 404
  ```

---

### 1.4.3 API key management routes

**Files**
- `apps/api/src/routes/api-keys.ts`

**Contents (high level)**

```
POST   /v1/api-keys                    → create (returns raw key once)
GET    /v1/api-keys                    → list (metadata only)
DELETE /v1/api-keys/:id                → revoke (set revoked_at)
```

`POST` returns the raw key in the response body **only on creation**.
Subsequent reads return only the prefix.

**Acceptance**
- E2E:
  ```bash
  # Using the seeded admin key:
  curl -s -X POST -H "X-Textral-Api-Key: <SEED>" \
       -H "Content-Type: application/json" \
       -d '{"scopes":["query","ingest"]}' \
       http://localhost:8787/v1/api-keys
  # → {"id":"ak_...","raw":"tx_live_...","prefix":"tx_live_01H","scopes":[...]}

  # The new key works:
  NEW=$(... | jq -r .raw)
  curl -s -H "X-Textral-Api-Key: $NEW" http://localhost:8787/v1/me
  # → {"tenant_id":"ten_..."}

  # Revoke and re-test:
  curl -s -X DELETE -H "X-Textral-Api-Key: <SEED>" http://localhost:8787/v1/api-keys/<NEW_ID>
  curl -i -H "X-Textral-Api-Key: $NEW" http://localhost:8787/v1/me
  # → 401 (cache may still resolve for up to 60 s; second call after TTL is 401)
  ```

---

### 1.4.4 Admin bootstrap endpoint

**Files**
- `apps/api/src/routes/admin/bootstrap.ts`

**Contents (high level)**
- `POST /v1/admin/bootstrap` accepts a one-time bootstrap token (set
  via `wrangler secret put ADMIN_BOOTSTRAP_TOKEN`).
- Body: `{ tenant_display_name, namespace_slug, api_key_scopes }`.
- Idempotent: if a tenant with the same `display_name` exists,
  returns existing IDs without re-creating.
- Used by `make seed-dev`.

**Acceptance**
- `seed-dev` runs cleanly twice; second run returns the same IDs and
  the same API key prefix (the raw key is returned only on first
  creation; subsequent runs return `null` for `raw_api_key`).

---

## Step 1.5 — Provider key registration via Secrets Store

> Note: per Phase 2.7, the `POST /v1/provider-keys/:id/test`
> validation endpoint depends on the provider abstraction. We
> implement the full register/list/delete in 1.5; the **test**
> endpoint is stubbed here and completed in Phase 2.

### 1.5.1 Provider key contracts

**Files**
- `packages/contracts/src/provider-key.ts`

**Contents (high level)**
- Zod enum `ProviderName = 'openai' | 'anthropic' | 'cohere' | 'voyage' | 'workers_ai'`.
- `ProviderKeyCreate { provider, label, key }` — `key` field is
  redacted from logs by Phase 1.6 middleware.
- `ProviderKey { id, provider, label, prefix, last_validated_at, last_error_code, created_at }`
  — note: never includes the raw key.

---

### 1.5.2 Secrets Store helper

**Files**
- `apps/api/src/lib/secrets-store.ts`

**Contents (high level)**

```ts
// Wraps the Cloudflare Secrets Store binding API.
//
// We address each provider key by a deterministic name:
//   pkey-{tenant_id}-{provider}-{label}
//
// putProviderKey(env, { tenant_id, provider, label, raw_key })
//   → secrets_store_secret_name
// getProviderKey(env, secrets_store_secret_name) → raw_key
// deleteProviderKey(env, secrets_store_secret_name) → void
//
// Implementation calls env.SECRETS_API.put(...) etc. (Secrets Store
// binding: see wrangler config).

export function providerKeySecretName(tenantId: string, provider: string, label: string): string {
  return `pkey-${tenantId}-${provider}-${label}`;
}
```

**Acceptance**
- Unit-test the helper round-trips a value through Secrets Store
  (against the dev environment).

---

### 1.5.3 Provider key routes

**Files**
- `apps/api/src/routes/provider-keys.ts`

**Contents (high level)**

```
POST   /v1/provider-keys                    body: { provider, label, key }
GET    /v1/provider-keys                    metadata-only list
DELETE /v1/provider-keys/:id                revoke (D1 + Secrets Store delete)
POST   /v1/provider-keys/:id/test           STUB (Phase 2): returns 501 NOT_IMPLEMENTED
```

**Implementation notes (high level)**
- On `POST`:
  1. Validate the body (Zod).
  2. Compute `secrets_store_secret_name`.
  3. Write the raw key into Secrets Store.
  4. INSERT the metadata row in `provider_keys`.
  5. Return the `ProviderKey` record (no raw key).
- On `DELETE`:
  1. Look up the row (404 if not owned).
  2. Delete from Secrets Store first (best-effort), then from D1.

**Acceptance**
- E2E `apps/api/test/provider-keys.test.ts`:
  ```ts
  // 1. Register an OpenAI key with label 'prod'.
  // 2. List → returns 1 entry, no `key` field.
  // 3. Direct D1 inspection: `provider_keys` row exists, no `key`
  //    column anywhere; only `secrets_store_secret_name`.
  // 4. R2 has no provider-key data anywhere.
  // 5. DELETE → 204.
  // 6. List → empty.
  ```

---

### 1.5.4 Provider key resolver

**Files**
- `apps/api/src/auth/provider-keys.ts`

**Contents (high level)**

```ts
// resolveProviderKey(env, tenantId, provider, label):
//   1. SELECT secrets_store_secret_name FROM provider_keys
//      WHERE tenant_id = ? AND provider = ? AND label = ? AND revoked_at IS NULL.
//   2. fetch raw key from Secrets Store.
//   3. Return { provider_key_id, raw_key }.
//   4. Caller MUST never log raw_key.
//
// Used by Phase 2 (provider abstraction) and Phase 3 (ingestion).
// In Phase 1, exists but is exercised only by the (still-stubbed)
// /test endpoint.
```

**Acceptance**
- Unit test stubs the binding and asserts the SELECT + fetch order.

---

## Step 1.6 — Redaction middleware + verification harness

### 1.6.1 Redaction middleware

**Files**
- `apps/api/src/middleware/redaction.ts`

**Contents (high level)**

```ts
// Single source of truth for what counts as a "secret" in our system.
// Patterns are matched against the request URL, headers, and body
// JSON values BEFORE any logger or error reporter sees them.
//
// Patterns (extend liberally — a false positive is acceptable, a
// missed leak is not):
//   - sk-[A-Za-z0-9_-]{16,}             (OpenAI)
//   - sk-proj-[A-Za-z0-9_-]{16,}        (OpenAI project keys)
//   - sk-ant-[A-Za-z0-9_-]{16,}         (Anthropic)
//   - xai-[A-Za-z0-9_-]{16,}            (xAI)
//   - r8_[A-Za-z0-9_-]{16,}             (Replicate)
//   - voy-[A-Za-z0-9]{16,}              (Voyage)
//   - co-[A-Za-z0-9]{16,}               (Cohere)
//   - tx_(live|test)_[A-Z0-9]{26}_.+    (our own keys — also redact)
//
// Header redactions:
//   - Authorization
//   - X-Textral-Api-Key
//   - X-Provider-Key-*
//   - cf-aig-authorization
//
// JSON field redactions (any depth):
//   - "key", "apiKey", "api_key", "secret", "password",
//     "authorization", "bearer"
//
// The middleware:
//   1. Wraps console.log/warn/error with a redacting interceptor.
//   2. Wraps env.LOGS-style writers (e.g., Analytics Engine).
//   3. Wraps any AI Gateway tag construction site.
//
// On dev (ENV=dev), the middleware also asserts at the END of the
// request that no redaction pattern matched any pre-redaction
// captured state — this catches new leak surfaces during testing.

export const redactionMiddleware = createMiddleware(async (c, next) => {
  // ... install interceptors, run handler, restore on completion.
  await next();
});

export function redact(s: string): string { /* applies all patterns */ }
```

Apply redaction middleware **first** in the Hono chain, before
auth/routing/error-handling.

**Acceptance**
- Unit tests `apps/api/test/redaction.test.ts`:
  - Each known pattern is correctly matched and replaced with
    `[REDACTED]`.
  - `redact("Hello sk-proj-abcd1234567890abcdef world")` returns
    `"Hello [REDACTED] world"`.
  - JSON: `redact(JSON.stringify({ apiKey: "sk-..." }))` → no key
    fragment in output.

---

### 1.6.2 Verification harness route

**Files**
- `apps/api/src/routes/__redaction_check.ts`
- `apps/api/test/redaction-fuzz.test.ts`

**Contents (high level)**
- Route gated on `c.env.ENABLE_DEBUG_ROUTES === 'true'` — 404s in
  prod.
- **Mounted directly on the app under `/__redaction_check`, NOT under
  `/v1/*`.** The harness must run BEFORE auth so it tests what the
  unauthenticated edge sees — that's the whole point. Wire it in
  `apps/api/src/index.ts` alongside `/healthz` and `/dev/ingest-ping`,
  outside the `requireApiKey`-protected `/v1` Hono sub-app.
- Accepts POST bodies and header values containing fake-but-realistic
  provider key shapes.
- Returns the redacted-shape of each sink (body, header dictionary,
  raw-string fallback) so tests can assert the shape directly.
- Test asserts **no key fragment** appears in any captured output.

**Fuzz test contents**
- Generates 50 randomized strings matching each known pattern.
- Posts each to `/__redaction_check` via the Vitest worker fixture.
- Inspects every captured sink for the original substring; failure
  causes the test to fail.

**Acceptance**
```bash
pnpm --filter @textral/api test redaction
# 50 patterns × all sinks, all green
```

```bash
# Confirm the route is 404 in prod-mode:
ENABLE_DEBUG_ROUTES=false npx wrangler dev --env dev --local-env
curl -i -X POST http://localhost:8787/__redaction_check
# → 404
```

---

### 1.6.3 Phase 1 close-out

**Acceptance (Phase 1 exit gate)**

```bash
# Substrate:
make migrate-dev                         # green, all tables present
npx wrangler d1 execute textral-dev --env dev \
  --command "SELECT COUNT(*) FROM tenants"
# → 1 (the seed tenant)

# Auth:
curl -i http://localhost:8787/v1/me                                # 401
curl -s -H "X-Textral-Api-Key: <SEED>" http://localhost:8787/v1/me # 200

# Namespaces:
curl -s -X POST -H "X-Textral-Api-Key: <SEED>" \
     -H "Content-Type: application/json" \
     -d '{"slug":"leases","corpus_profile":"generic","default_embedding_profile":"openai-text-embedding-3-large"}' \
     http://localhost:8787/v1/namespaces

# Provider keys:
curl -s -X POST -H "X-Textral-Api-Key: <SEED>" \
     -H "Content-Type: application/json" \
     -d '{"provider":"openai","label":"prod","key":"sk-proj-..."}' \
     http://localhost:8787/v1/provider-keys
curl -s -H "X-Textral-Api-Key: <SEED>" http://localhost:8787/v1/provider-keys
# Listed metadata, no `key` field.

# Direct D1 confirms no raw key in row:
npx wrangler d1 execute textral-dev --env dev \
  --command "SELECT * FROM provider_keys"
# → only `secrets_store_secret_name`, no raw key column

# Redaction harness:
pnpm --filter @textral/api test redaction
# all green

# CI:
# Open a PR with no source changes → green.
```

When every box above is green, Phase 1 is closed. Tag the commit
`phase-1-complete` and write a one-page retrospective at
`docs/retrospectives/phase-1.md` capturing what changed vs the plan
(per the cross-phase convention in `docs/2-PHASES.md`).

---

# Appendix A — Cumulative file tree at end of Phase 1

```
TEXTRAL_REFACTOR_WIP/
├── .editorconfig
├── .github/workflows/ci.yml
├── .gitignore
├── .npmrc
├── .prettierrc
├── eslint.config.js
├── Makefile
├── package.json
├── pnpm-workspace.yaml
├── README.md
├── SECRETS.md
├── tsconfig.base.json
│
├── apps/
│   ├── api/
│   │   ├── migrations/
│   │   │   └── 0001_baseline.sql
│   │   ├── scripts/
│   │   │   ├── seed-dev.ts
│   │   │   └── tsconfig.json
│   │   ├── src/
│   │   │   ├── auth/
│   │   │   │   ├── api-key.ts
│   │   │   │   ├── middleware.ts
│   │   │   │   ├── provider-keys.ts
│   │   │   │   └── tenant-cache.ts
│   │   │   ├── db/
│   │   │   │   ├── namespaces.ts
│   │   │   │   ├── api-keys.ts
│   │   │   │   └── provider-keys.ts
│   │   │   ├── lib/
│   │   │   │   ├── container.ts
│   │   │   │   └── secrets-store.ts
│   │   │   ├── middleware/
│   │   │   │   └── redaction.ts
│   │   │   ├── routes/
│   │   │   │   ├── admin/bootstrap.ts
│   │   │   │   ├── api-keys.ts
│   │   │   │   ├── dev/ingest-ping.ts
│   │   │   │   ├── health.ts
│   │   │   │   ├── me.ts
│   │   │   │   ├── namespaces.ts
│   │   │   │   ├── provider-keys.ts
│   │   │   │   └── __redaction_check.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── test/
│   │   │   ├── api-key.test.ts
│   │   │   ├── health.test.ts
│   │   │   ├── namespaces.test.ts
│   │   │   ├── provider-keys.test.ts
│   │   │   ├── redaction.test.ts
│   │   │   └── redaction-fuzz.test.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── wrangler.toml
│   │
│   └── ingest/
│       ├── app/
│       │   ├── __init__.py
│       │   └── main.py
│       ├── Dockerfile
│       ├── .dockerignore
│       └── requirements.txt
│
├── packages/
│   └── contracts/
│       ├── src/
│       │   ├── error.ts
│       │   ├── id.ts
│       │   ├── index.ts
│       │   ├── namespace.ts
│       │   └── provider-key.ts
│       ├── package.json
│       └── tsconfig.json
│
└── docs/
    ├── 0-MIGRATION_PLAN_DRAFT.md
    ├── 1-DESIGN.md
    ├── 2-PHASES.md
    ├── development/
    │   └── PHASE_0_1_IMPLEMENTATION.md   ← this file
    ├── retrospectives/
    │   ├── phase-0.md
    │   └── phase-1.md
    ├── runbooks/
    │   └── PROVISIONING.md
    └── third-party/
        ├── CONTAINERS.md
        ├── VECTORIZE.md
        └── WORKERS_AI.md
```

# Appendix B — One-line answers to questions a dev might still have

| Q | A |
|---|---|
| What if `wrangler containers build` says "instance type required"? | Add `instance_type = "standard"` under each `[[env.X.containers]]` block. |
| Local dev for the Container — do I run uvicorn directly? | Yes. `make dev-ingest` runs uvicorn at :8000 — the Worker dev binding can be pointed at `http://localhost:8000` only via a wrangler dev override; for E2E we deploy the dev Container and hit the dev Worker. |
| The dev seed key was lost — how do I recover? | Re-run `make seed-dev` with a fresh `ADMIN_BOOTSTRAP_TOKEN`. The bootstrap endpoint creates a *new* api_key row even if the tenant exists; revoke the old one via DELETE. |
| Why is `.dev.vars` git-ignored but referenced nowhere? | It's a wrangler convention for local-only env vars; we don't depend on it in Phase 0/1 but want the gitignore to be ready when it's needed. |
| KV cache miss penalty — is 60 s TTL right? | Yes for MVP. Revisit if `last_used_at` lag becomes a billing concern. |
| Why HMAC-SHA-256 instead of argon2id (the design said argon2id)? | API keys are 32+ char random strings. Their entropy is already higher than any KDF can usefully add against. HMAC + pepper is the industry pattern. The design doc note about argon2id is superseded by this implementation choice; document the deviation in `docs/retrospectives/phase-1.md`. |
| Why do we route the dev `__redaction_check` test through the deployed Worker rather than a unit test? | Both. Unit tests catch the regex layer; the integration route catches log-sink wiring. We need both to claim coverage. |

---

End of Phase 0 + 1 implementation guide. Phase 2 begins in
`PHASE_2_IMPLEMENTATION.md` (next doc to draft).
