# Phase 1.7 — Implementation Steps

> Companion to `docs/2-PHASES.md` Phase 1.7. Concrete, ordered steps for
> introducing OpenAPI 3.1 generation + a hosted docs UI on top of the
> existing Hono routes.
>
> A dev should be able to follow this document end-to-end and finish
> Phase 1.7 without making design decisions or asking questions. Where
> the design left a choice open, this document picks one.

---

**At completion, you will have:** a generated OpenAPI 3.1 document at
`GET /openapi.json`, a Scalar-rendered API reference at `GET /docs`,
every existing public route converted from `Hono` to `OpenAPIHono` with
typed Zod request/response definitions, and a coverage test that fails
the build if any future route lacks an OpenAPI definition. Phase 3+
inherits this for free: every new route in ingestion + retrieval will
register itself into the same spec.

---

## Prerequisites

Phase 1 is closed. Phase 2 is closed. Specifically:
- `apps/api` is a working Hono Worker with 6 mounted route groups: `healthRoute`,
  `meRoute`, `namespacesRoute`, `apiKeysRoute`, `providerKeysRoute`,
  `bootstrapRoute` (admin), plus two debug-only routes (`devIngestPing`
  and `redactionCheckRoute`).
- `packages/contracts` exposes Zod schemas for `Namespace`, `ProviderKey`,
  chat / embedding / rerank, error envelopes, and ID utilities.
- The dev environment has `ENABLE_DEBUG_ROUTES = "true"`.

You'll also need:
- `pnpm` and Node 24.

---

## Locked-in technology choices

These were left open in the phases doc; locking them now.

| Concern | Choice | Rationale |
|---------|--------|-----------|
| OpenAPI generator | **`@hono/zod-openapi@^0.19.10`** | Last release that peer-deps `zod >=3.0.0`; we're on 3.25.x. The 1.x line requires zod 4 — out of scope until we bump. |
| Docs UI | **`@scalar/hono-api-reference@^0.10.13`** | Native Hono integration. The Worker serves the HTML shell; the `@scalar/api-reference` JS bundle is loaded client-side from jsDelivr (Scalar's default CDN). If we ever need to self-host the bundle for air-gapped use, swap the CDN later via Scalar's `cdn` option. |
| Spec version | **OpenAPI 3.1** | Default for `@hono/zod-openapi`; better Zod fidelity than 3.0. |
| Schema decoration | **In `apps/api`, not `packages/contracts`** | The contracts package stays framework-agnostic. The API package calls `extendZodWithOpenApi(z)` once at module-load and decorates contracts schemas with `.openapi('Name')` at the route boundary. |
| Routes excluded from the spec | **`/__redaction_check`, `/dev/*`** | Debug-only; gated by `ENABLE_DEBUG_ROUTES`. We don't advertise them in the public API surface. |
| Spec exposure in prod | **Always-on** | `GET /openapi.json` and `GET /docs` ship in both dev and prod. The spec describes the public contract; hiding it in prod has no security benefit and degrades developer experience. (If we ever need an internal-only sandbox, add an `INTERNAL_DOCS_ONLY` env var later.) |
| Coverage test | **One-pass spec walker** | A vitest test that loads the running Worker, fetches `/openapi.json`, and asserts every `/v1/*` and `/v1/admin/*` path the Worker actually serves is present in the spec. Fails the build on drift. |
| Test scaffolding | **Reuse `test/helpers/fetch.ts` + the `[env.test]` wrangler block** | Same patterns as Phase 1 / Phase 2. |

---

## Naming and locations

```
apps/api/src/
    openapi/
        z.ts                  — re-exports `z` with `extendZodWithOpenApi` applied
        components.ts         — named, openapi-decorated wrappers around contracts schemas
        registry.ts            — small helpers for common 401/404/422 response definitions
    routes/
        health.ts             — converted to createRoute() / OpenAPIHono
        me.ts                 — converted
        namespaces.ts         — converted
        api-keys.ts           — converted
        provider-keys.ts      — converted
        admin/bootstrap.ts    — converted
        docs.ts               — mounts /openapi.json + /docs
    index.ts                  — top-level uses OpenAPIHono, mounts docs.ts
```

---

# Step 1.7.1 — Add dependencies + Zod extension

**Goal:** Install the OpenAPI generator and the Scalar docs UI; teach
Zod to accept `.openapi(...)` decoration.

## 1.7.1.1 Install packages

**Files**
- `apps/api/package.json` (extended)

```bash
pnpm --filter @textral/api add \
  '@hono/zod-openapi@^0.19.10' \
  '@scalar/hono-api-reference@^0.10.13'
```

> Pin the **caret-on-minor** range (^0.19.10), not `latest`. The 1.x
> line of `@hono/zod-openapi` requires zod 4; we'd need a coordinated
> contracts-package upgrade to use it. That's a separate phase.

## 1.7.1.2 Install the Zod extension

**Files**
- `apps/api/src/openapi/z.ts` (NEW)

```ts
// apps/api/src/openapi/z.ts
//
// Single import site for `z` in the API package. Routes and components
// import from here, not directly from 'zod', so the openapi extension
// is guaranteed to be applied before any `.openapi(...)` call lands.
//
// Note: this re-exports the SAME zod singleton our contracts package
// uses (pnpm hoisting; verified by `node_modules/.pnpm/zod@*`). Calling
// `extendZodWithOpenApi(z)` mutates the prototype, so contracts schemas
// already in flight gain `.openapi()` for free — but we still decorate
// at the boundary in `components.ts` so contracts stays framework-agnostic.

import { z } from '@hono/zod-openapi';
export { z };
```

**Acceptance**
- `pnpm install` succeeds.
- `node_modules/.pnpm/@hono+zod-openapi@0.19.*` resolves.

---

# Step 1.7.2 — Decorate schemas

**Goal:** Every public schema appears under `components.schemas` with a
stable name. Routes reference the decorated wrapper, not the raw
contracts export.

## 1.7.2.1 Build the components module

**Files**
- `apps/api/src/openapi/components.ts` (NEW)

```ts
import {
  ErrorEnvelope as ErrorEnvelopeRaw,
  Namespace as NamespaceRaw,
  NamespaceCreate as NamespaceCreateRaw,
  NamespaceUpdate as NamespaceUpdateRaw,
  ProviderKey as ProviderKeyRaw,
  ProviderKeyCreate as ProviderKeyCreateRaw,
} from '@textral/contracts';
import { z } from './z.js';

// Each `.openapi('Name')` call registers the schema under
// components.schemas.Name in the generated document. Reuse these from
// every route — never write `Schema.openapi('Foo')` ad-hoc inside a
// route file (you'll get duplicate or shadowed entries).

export const ErrorEnvelopeSchema = ErrorEnvelopeRaw.openapi('ErrorEnvelope');
export const NamespaceSchema = NamespaceRaw.openapi('Namespace');
export const NamespaceCreateSchema = NamespaceCreateRaw.openapi('NamespaceCreate');
export const NamespaceUpdateSchema = NamespaceUpdateRaw.openapi('NamespaceUpdate');
export const ProviderKeySchema = ProviderKeyRaw.openapi('ProviderKey');
export const ProviderKeyCreateSchema = ProviderKeyCreateRaw.openapi('ProviderKeyCreate');

// Inline schemas for routes whose request/response shapes don't yet
// live in @textral/contracts. Move these to contracts when Phase 3+
// stabilizes the public surface.

export const HealthResponse = z
  .object({
    status: z.literal('ok'),
    env: z.enum(['dev', 'prod']),
    ts: z.number().int(),
  })
  .openapi('HealthResponse');

export const MeResponse = z
  .object({
    tenant: z.object({
      id: z.string(),
      display_name: z.string(),
      plan: z.string(),
      created_at: z.number().int(),
    }),
    api_key_id: z.string(),
  })
  .openapi('MeResponse');

export const ApiKeyMetadata = z
  .object({
    id: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    created_at: z.number().int(),
    last_used_at: z.number().int().nullable(),
    revoked_at: z.number().int().nullable(),
  })
  .openapi('ApiKeyMetadata');

export const ApiKeyCreateRequest = z
  .object({
    scopes: z.array(z.string()).default(['*']),
  })
  .openapi('ApiKeyCreateRequest');

export const ApiKeyCreateResponse = z
  .object({
    id: z.string(),
    raw: z.string().describe('Returned exactly once; never persisted in cleartext.'),
    prefix: z.string(),
    scopes: z.array(z.string()),
    created_at: z.number().int(),
  })
  .openapi('ApiKeyCreateResponse');

export const ProviderKeyTestResponse = z
  .object({
    ok: z.boolean(),
    error_code: z.string().optional(),
    error_message: z.string().optional(),
  })
  .openapi('ProviderKeyTestResponse');

export const BootstrapRequest = z
  .object({
    tenant_display_name: z.string().min(1).max(120),
    namespace_slug: z.string(),
    namespace_corpus_profile: z.string().default('generic'),
    namespace_default_embedding_profile: z
      .string()
      .default('openai-text-embedding-3-large'),
    api_key_scopes: z.array(z.string()).default(['*']),
  })
  .openapi('BootstrapRequest');

export const BootstrapResponse = z
  .object({
    tenant: z.object({ id: z.string(), display_name: z.string() }),
    namespace: NamespaceSchema,
    api_key: z.object({ id: z.string(), raw: z.string(), prefix: z.string() }),
  })
  .openapi('BootstrapResponse');

export const ListResponse = <T extends z.ZodTypeAny>(item: T): z.ZodObject<{ data: z.ZodArray<T> }> =>
  z.object({ data: z.array(item) });
```

## 1.7.2.2 Build the response-helper module

**Files**
- `apps/api/src/openapi/registry.ts` (NEW)

```ts
import { ErrorEnvelopeSchema } from './components.js';

// Common response definitions. Reuse from every route definition so
// 401 / 404 / 422 envelope shapes don't drift.
export const Json = {
  errorEnvelope: {
    'application/json': { schema: ErrorEnvelopeSchema },
  },
} as const;

export const Responses = {
  unauthorized: {
    description: 'Missing or invalid X-Textral-Api-Key.',
    content: Json.errorEnvelope,
  },
  forbiddenAdmin: {
    description: 'Missing or invalid X-Admin-Bootstrap-Token.',
    content: Json.errorEnvelope,
  },
  notFound: {
    description: 'Resource not found (or not visible to the caller).',
    content: Json.errorEnvelope,
  },
  badRequest: {
    description: 'Request body failed validation.',
    content: Json.errorEnvelope,
  },
  validationFailed: {
    description: 'Provider-key validation failed (returns ok:false).',
    content: Json.errorEnvelope,
  },
};
```

**Acceptance**
- `pnpm --filter @textral/api typecheck` returns 0.

---

# Step 1.7.3 — Convert the routes

**Goal:** Replace every `new Hono(...)` mounted in `src/index.ts` with
`new OpenAPIHono(...)`, replace ad-hoc handler signatures with
`createRoute(...)` definitions, and reuse the components module above.

The pattern is uniform; convert one route, then mechanically apply the
same shape to the others.

## 1.7.3.1 The conversion pattern (worked example: `health`)

**Before** (`apps/api/src/routes/health.ts`):
```ts
import { Hono } from 'hono';
export const healthRoute = new Hono<...>();
healthRoute.get('/', (c) => c.json({ status: 'ok', env: c.env.ENV, ts: Date.now() }));
```

**After**:
```ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Env, Variables } from '../types.js';
import { HealthResponse } from '../openapi/components.js';

export const healthRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const getHealth = createRoute({
  method: 'get',
  path: '/',
  tags: ['Meta'],
  summary: 'Health check',
  description: 'Returns 200 if the Worker is alive. Always public.',
  responses: {
    200: {
      description: 'Worker is healthy.',
      content: { 'application/json': { schema: HealthResponse } },
    },
  },
});

healthRoute.openapi(getHealth, (c) =>
  c.json({ status: 'ok' as const, env: c.env.ENV, ts: Date.now() }),
);
```

The handler still returns a typed JSON body. The difference is that the
`createRoute(...)` definition tells the spec generator what the
endpoint does and what shapes it produces.

## 1.7.3.2 Convert remaining routes

Apply the same pattern to:
- `me.ts` → 1 GET. 200/401.
- `namespaces.ts` → list / create / get-by-slug / patch / delete. 200/201/204/400/401/404/409.
- `api-keys.ts` → create / list / delete. 200/201/204/400/401/404.
- `provider-keys.ts` → create / list / delete / test. 200/201/204/400/401/404/409/422.
- `admin/bootstrap.ts` → create. 200/400/401. Tag: `Admin`.

Each createRoute call MUST set:
- `tags: [...]` — used by Scalar to group routes.
- `summary` — short imperative ("Create an API key", "List namespaces").
- `description` — 1–3 lines of context, including caveats ("the raw
  key is returned only once", "tenant-scoped via the auth header").
- `request` — body schema (where applicable), `params` schema (for
  `:slug` / `:id`), and `headers` schema (where the header is part of
  the contract — `X-Textral-Api-Key`, `X-Admin-Bootstrap-Token`).
- `responses` — every realistic status code, each with a `description`
  + a `content` block where there's a body. Reuse `Responses.*` from
  the registry helper for envelope-shaped errors.
- `security` — `[{ ApiKeyAuth: [] }]` for `/v1/*`, `[{ AdminToken: [] }]`
  for `/v1/admin/bootstrap`, omitted (means: public) for `/healthz` and
  `/openapi.json`.

## 1.7.3.3 Don't break the existing route bodies

The handler bodies stay almost unchanged — `c.req.json()`, `c.json(...)`,
`c.body(null, 204)`, `throw new TextralError(...)` all still work. The
`createRoute(...)` wrapper validates the request shape against the
defined schemas BEFORE the handler runs; the handler can then trust
`c.req.valid('json')` / `c.req.valid('param')`.

> **Important:** `OpenAPIHono.openapi()` does runtime request
> validation when a `request.body` schema is declared. This means
> existing manual `safeParse(...)` blocks become redundant for those
> routes. Replace them with the `c.req.valid('json')` accessor; let
> the framework throw on failure (it produces the standard 400 with
> Zod issues — wire its `defaultHook` to your existing error envelope
> in step 1.7.5 below).

**Acceptance**
- All converted routes typecheck.
- All existing tests still pass.

---

# Step 1.7.4 — Mount `/openapi.json` and `/docs`

## 1.7.4.1 Build the docs route module

**Files**
- `apps/api/src/routes/docs.ts` (NEW)

```ts
import { Scalar } from '@scalar/hono-api-reference';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Env, Variables } from '../types.js';

export interface DocsConfig {
  /** Path the spec is served at. Convention: `/openapi.json`. */
  specPath: string;
  /** Path the Scalar UI is served at. Convention: `/docs`. */
  uiPath: string;
}

export function mountDocs(
  app: OpenAPIHono<{ Bindings: Env; Variables: Variables }>,
  cfg: DocsConfig = { specPath: '/openapi.json', uiPath: '/docs' },
): void {
  // Serve the auto-generated OpenAPI 3.1 doc.
  app.doc31(cfg.specPath, (c) => ({
    openapi: '3.1.0',
    info: {
      title: 'Textral API',
      version: '0.1.0',
      description:
        'Multi-tenant retrieval-augmented generation API. ' +
        'Authenticate via X-Textral-Api-Key on every /v1/* request.',
    },
    servers: [
      // Workers fills in the request URL, so a relative server URL
      // works both in dev (workers.dev subdomain) and in prod (custom
      // domain). Scalar will use this as the "Try it" base.
      { url: new URL(c.req.url).origin, description: 'Current host' },
    ],
  }));

  // Register security schemes (referenced by `security: [...]` blocks
  // on individual routes).
  app.openAPIRegistry.registerComponent('securitySchemes', 'ApiKeyAuth', {
    type: 'apiKey',
    in: 'header',
    name: 'X-Textral-Api-Key',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'AdminToken', {
    type: 'apiKey',
    in: 'header',
    name: 'X-Admin-Bootstrap-Token',
  });

  // Mount Scalar UI.
  app.get(
    cfg.uiPath,
    Scalar({
      url: cfg.specPath,
      pageTitle: 'Textral API Reference',
    }),
  );
}
```

## 1.7.4.2 Wire it into `src/index.ts`

**Files**
- `apps/api/src/index.ts` (extended)

Replace `new Hono(...)` with `new OpenAPIHono(...)`, then call
`mountDocs(app)` after middleware is installed but before
`app.notFound`. Also: do NOT mount the docs behind `requireApiKey` —
the spec describes the *contract*, anyone may read it.

```ts
import { OpenAPIHono } from '@hono/zod-openapi';
import { mountDocs } from './routes/docs.js';
// … other imports …

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>({
  // Override the default Zod-validation 400 with our envelope shape.
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'BAD_REQUEST',
            message: 'Request validation failed',
            details: { issues: result.error.issues },
            ...(c.get('request_id') ? { request_id: c.get('request_id') } : {}),
          },
        },
        400,
      );
    }
  },
});

app.use('*', redactionMiddleware);
app.use('*', requestIdMiddleware);

mountDocs(app);                                  // public; no auth required

app.route('/healthz', healthRoute);
// … and so on, identical to before …
```

**Acceptance**
- `wrangler dev --env dev` starts.
- `curl http://localhost:8787/openapi.json | jq '.openapi, .info.title, .paths | keys'`
  prints `"3.1.0"`, `"Textral API"`, and the array of paths.
- `curl http://localhost:8787/docs` returns the Scalar HTML shell.

---

# Step 1.7.5 — Coverage tests

**Goal:** Lock in two contracts:
1. Every Worker-served `/v1/*` and `/v1/admin/*` path appears in the
   spec. Future-proofs against forgotten `createRoute(...)` definitions.
2. The spec is well-formed (parseable, has paths, has at least one
   security scheme, every path declares a non-empty `responses` map).

## 1.7.5.1 Coverage walker

**Files**
- `apps/api/test/openapi-coverage.test.ts` (NEW)

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { callJson } from './helpers/fetch.js';
import type { Env } from '../src/types.js';

interface OpenAPIDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components?: { securitySchemes?: Record<string, unknown> };
}

const EXPECTED_PATHS: Array<{ path: string; method: string }> = [
  { path: '/healthz', method: 'get' },
  { path: '/v1/me', method: 'get' },
  { path: '/v1/api-keys', method: 'post' },
  { path: '/v1/api-keys', method: 'get' },
  { path: '/v1/api-keys/{id}', method: 'delete' },
  { path: '/v1/namespaces', method: 'post' },
  { path: '/v1/namespaces', method: 'get' },
  { path: '/v1/namespaces/{slug}', method: 'get' },
  { path: '/v1/namespaces/{slug}', method: 'patch' },
  { path: '/v1/namespaces/{slug}', method: 'delete' },
  { path: '/v1/provider-keys', method: 'post' },
  { path: '/v1/provider-keys', method: 'get' },
  { path: '/v1/provider-keys/{id}', method: 'delete' },
  { path: '/v1/provider-keys/{id}/test', method: 'post' },
  { path: '/v1/admin/bootstrap', method: 'post' },
];

describe('OpenAPI spec', () => {
  it('is served at /openapi.json with correct headline fields', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', 'http://x/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as OpenAPIDoc;
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.info.title).toBe('Textral API');
    expect(doc.info.version).toBeTruthy();
    expect(typeof doc.paths).toBe('object');
  });

  it('declares ApiKeyAuth + AdminToken security schemes', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', 'http://x/openapi.json');
    const doc = (await res.json()) as OpenAPIDoc;
    expect(doc.components?.securitySchemes?.ApiKeyAuth).toBeDefined();
    expect(doc.components?.securitySchemes?.AdminToken).toBeDefined();
  });

  it('covers every public route', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', 'http://x/openapi.json');
    const doc = (await res.json()) as OpenAPIDoc;
    const missing: string[] = [];
    for (const { path, method } of EXPECTED_PATHS) {
      const ops = doc.paths[path];
      if (!ops || !(method in ops)) missing.push(`${method.toUpperCase()} ${path}`);
    }
    expect(missing, `Missing OpenAPI definitions: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not advertise debug-only routes', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', 'http://x/openapi.json');
    const doc = (await res.json()) as OpenAPIDoc;
    expect(doc.paths['/__redaction_check']).toBeUndefined();
    expect(doc.paths['/dev/ingest-ping']).toBeUndefined();
  });
});

describe('GET /docs (Scalar UI)', () => {
  it('returns HTML referencing the spec URL', async () => {
    const e = env as unknown as Env;
    const res = await callJson(e, 'GET', 'http://x/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/html/);
    const body = await res.text();
    expect(body).toContain('/openapi.json');
  });
});
```

**Acceptance**
- `pnpm --filter @textral/api test openapi-coverage` is green.
- Forgetting to add `createRoute(...)` to a future route causes the
  `'covers every public route'` test to fail with a clear "Missing
  OpenAPI definitions" message.

---

# Step 1.7.6 — Phase 1.7 close-out

```bash
pnpm -r typecheck                         # green
pnpm -r lint                              # green
pnpm -r test                              # all unit + fixture tests green
```

End-to-end verification:

```bash
# Local
pnpm --filter @textral/api dev            # wrangler dev --env dev
curl -s http://localhost:8787/openapi.json | jq '.info.title, (.paths | length)'
# → "Textral API"
# → 9    (or whatever the current path-count is)
open http://localhost:8787/docs           # the Scalar UI loads

# Deployed dev
make deploy-dev
curl -s "https://textral-api-dev.<your-subdomain>.workers.dev/openapi.json" | jq '.info'
open "https://textral-api-dev.<your-subdomain>.workers.dev/docs"
```

When every box above is green, Phase 1.7 is closed. The spec is
self-updating from the `createRoute(...)` definitions in each route
module — no separate doc to maintain. Phase 3+ adds new routes the
same way and they appear in the spec automatically.

---

# Appendix A — File tree added/modified in Phase 1.7

```
apps/api/src/
├── index.ts                          ← uses OpenAPIHono, mounts docs
├── openapi/                          ← NEW
│   ├── components.ts
│   ├── registry.ts
│   └── z.ts
└── routes/
    ├── admin/bootstrap.ts            ← converted
    ├── api-keys.ts                   ← converted
    ├── docs.ts                       ← NEW
    ├── health.ts                     ← converted
    ├── me.ts                         ← converted
    ├── namespaces.ts                 ← converted
    └── provider-keys.ts              ← converted

apps/api/test/
└── openapi-coverage.test.ts          ← NEW

apps/api/package.json                 ← +2 deps
```

---

# Appendix B — One-line answers to questions a dev might still have

| Q | A |
|---|---|
| Why not pin to `@hono/zod-openapi@1.x`? | The 1.x line peer-deps `zod ^4.0.0`. Our contracts package is on zod 3.25.x. Coordinated upgrade is its own (later) phase. |
| Why expose `/openapi.json` in prod? | The spec describes the contract our consumers code against. Hiding it in prod is security-theater and degrades developer experience. (If we ever need an internal-only sandbox spec, gate behind an `INTERNAL_DOCS_ONLY` env var.) |
| Why not generate a typed client from the spec? | Future phase. Today, Worker code shares Zod types directly via the workspace import. SDK generation is appropriate when we have external consumers — call it in Phase 7 or Phase 8. |
| Why decorate schemas in `apps/api`, not in `packages/contracts`? | Keeping `@textral/contracts` framework-agnostic. If we later add a Python SDK from the spec, we don't want zod-to-openapi metadata showing up in that pipeline. |
| What about Workers AI streaming responses in the spec? | OpenAPI 3.1 supports `text/event-stream` content-types. Phase 4 (query / streaming) will add the schema for `TokenEvent` shapes. Out of scope here. |
| What about API versioning? | Every public route is mounted under `/v1`. When `/v2` arrives, it gets its own group; the spec describes both sides until `/v1` is sunset. |

---

End of Phase 1.7 implementation guide. Phase 2 picks up immediately
after, with provider-abstraction work that does not touch the public
HTTP surface.
