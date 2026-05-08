// /openapi.json + /docs — auto-generated spec + Scalar-rendered UI.
//
// Both routes are public. The spec describes the *contract* our
// consumers code against; hiding it in prod is security theater and
// degrades developer experience.
//
// Per docs/SCALAR_DOCS_ENHANCEMENT_PLAN.md (D1 + the cheap D5 polish):
//   * rich `info.description` markdown landing page
//   * `x-tagGroups` for sidebar grouping
//   * `x-displayName` to rename internal tag identifiers
//   * `x-internal: true` on bootstrap + dev-only debug routes
//   * per-tag descriptions (Markdown)
//   * Scalar auth preset (placeholder + persistAuth)
//   * `servers` array for env switching
//   * `metaData`, `hiddenClients`, `documentDownloadType`, search hotkey

import type { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import type { Env, Variables } from '../types.js';
import { LANDING_DESCRIPTION } from '../openapi/landing-description.js';
import { TAG_DESCRIPTIONS } from '../openapi/tag-descriptions.js';
import { applyCodeSamples } from '../openapi/code-samples.js';
import { renderErrorCatalogMarkdown } from '../openapi/error-catalog.js';

export interface DocsConfig {
  /** Path the spec is served at. Convention: `/openapi.json`. */
  specPath: string;
  /** Path the Scalar UI is served at. Convention: `/docs`. */
  uiPath: string;
}

const DEFAULT_CONFIG: DocsConfig = {
  specPath: '/openapi.json',
  uiPath: '/docs',
};

// Tag groups, in sidebar order. Tag names must match the strings used
// in routes' `tags: [...]` arrays.
const TAG_GROUPS = [
  { name: 'Get started', tags: ['Meta', 'Auth'] },
  {
    name: 'Core integration',
    tags: [
      'Provider Keys',
      'Infra Keys',
      'Namespaces',
      'Documents',
      'Chunks',
      'Ingestion',
      'Query',
      'Eval',
    ],
  },
  { name: 'Operations', tags: ['Admin'] },
  { name: 'Tenancy & keys', tags: ['Tenancy', 'API Keys'] },
  { name: 'Agent integration', tags: ['MCP'] },
];

// OperationIds that should never appear in public docs. They live on
// the spec as actual handlers but are hidden from the rendered UI.
//
// These are matched against operationIds; everything else falls
// through. operationId is auto-derived by @hono/zod-openapi from
// (method + path) when not specified, e.g.
//   POST /v1/admin/bootstrap → "postV1AdminBootstrap"
//   GET  /__redaction_check  → "get__redaction_check"
// We post-process the spec doc and walk path/method tuples instead,
// which is simpler and not coupled to the auto-id scheme.
interface InternalRoute {
  method: 'get' | 'post' | 'put' | 'delete' | 'patch';
  path: string;
}
const INTERNAL_ROUTES: InternalRoute[] = [
  // Bootstrap is admin-only / one-shot deploy machinery, not normal
  // onboarding. Hidden from public docs; documented conceptually in
  // the Tenancy tag description.
  { method: 'post', path: '/v1/admin/bootstrap/' },
  { method: 'post', path: '/v1/admin/bootstrap' },
  // Dev-only redaction probe. 404s in prod via ENABLE_DEBUG_ROUTES,
  // but should never appear in public docs at all.
  { method: 'get', path: '/__redaction_check' },
];

interface SpecLike {
  info: { title: string; version: string; description?: string };
  servers?: { url: string; description?: string }[];
  tags?: { name: string; description?: string; 'x-displayName'?: string }[];
  paths?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

function applySpecExtensions(
  spec: SpecLike,
  origin: string,
): SpecLike {
  // 1. Rich landing-page description + the error-catalog appendix.
  spec.info.description =
    LANDING_DESCRIPTION +
    '\n\n## Full error catalog\n\nEvery code, the typical HTTP status, when it fires, and the recovery action.\n\n' +
    renderErrorCatalogMarkdown();

  // 2. Servers array — env switcher.
  spec.servers = [
    { url: origin, description: 'Current host' },
    { url: 'http://localhost:8787', description: 'Local wrangler dev' },
  ];

  // 3. Tags with descriptions + display-name rename.
  const tagsByName = new Map<string, { name: string; description?: string; 'x-displayName'?: string }>();
  for (const t of spec.tags ?? []) tagsByName.set(t.name, t);
  for (const [name, description] of Object.entries(TAG_DESCRIPTIONS)) {
    const existing = tagsByName.get(name);
    const displayName = (() => {
      switch (name) {
        case 'API Keys':
          return 'API Keys (admin)';
        case 'Provider Keys':
          return 'Provider Keys (BYOK)';
        case 'Eval':
          return 'Evaluations';
        case 'Meta':
          return 'Reference & Debug';
        case 'Tenancy':
          return 'Tenancy (admin)';
        default:
          return undefined;
      }
    })();
    if (existing) {
      existing.description = description;
      if (displayName) existing['x-displayName'] = displayName;
    } else {
      tagsByName.set(name, {
        name,
        description,
        ...(displayName ? { 'x-displayName': displayName } : {}),
      });
    }
  }
  spec.tags = Array.from(tagsByName.values());

  // 4. Tag groups (Scalar sidebar grouping).
  (spec as Record<string, unknown>)['x-tagGroups'] = TAG_GROUPS;

  // 5. Hand-crafted code samples on flagship operations (Phase D3).
  applyCodeSamples(spec as Parameters<typeof applyCodeSamples>[0]);

  // 6. Per-tag badges (Phase D4). Operations tagged with admin-side
  //    surfaces get a red "Admin" badge so the UI distinguishes them
  //    from day-one integration work.
  if (spec.paths) {
    for (const ops of Object.values(spec.paths)) {
      for (const op of Object.values(ops)) {
        const o = op as { tags?: string[]; 'x-badges'?: { name: string; color?: string }[] };
        const tags = o.tags ?? [];
        const badges: { name: string; color?: string }[] = [];
        if (tags.includes('Admin')) {
          badges.push({ name: 'Admin', color: 'red' });
        }
        if (tags.includes('Tenancy') || tags.includes('API Keys')) {
          badges.push({ name: 'Operator only', color: 'orange' });
        }
        if (badges.length > 0) o['x-badges'] = badges;
      }
    }
  }

  // 7. Hide internal routes via path stripping. We delete the path
  //    entries entirely rather than `x-internal: true` because:
  //    (a) `x-internal` is Scalar-specific and not OpenAPI-canonical;
  //    (b) consumers using the spec for SDK gen shouldn't see them.
  if (spec.paths) {
    for (const r of INTERNAL_ROUTES) {
      for (const candidate of [r.path, r.path.replace(/\/$/, '')]) {
        const ops = spec.paths[candidate];
        if (!ops) continue;
        delete ops[r.method];
        if (Object.keys(ops).length === 0) {
          delete spec.paths[candidate];
        }
      }
    }
  }

  return spec;
}

export function mountDocs(
  app: OpenAPIHono<{ Bindings: Env; Variables: Variables }>,
  cfg: DocsConfig = DEFAULT_CONFIG,
): void {
  // Register security schemes BEFORE doc generation so they appear in
  // the components.securitySchemes map.
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

  // Serve the auto-generated OpenAPI 3.1 doc with our extensions.
  // We call `getOpenAPI31Document(...)` directly (not `app.doc31`)
  // because we need to post-process the *fully assembled* spec —
  // `app.doc31`'s configure callback only sees the static base, not
  // the runtime-discovered paths/operations.
  app.get(cfg.specPath, (c) => {
    const origin = new URL(c.req.url).origin;
    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: {
        title: 'Textral API',
        version: '0.1.0',
        description: 'replaced by applySpecExtensions',
      },
      servers: [{ url: origin, description: 'Current host' }],
    });
    const enriched = applySpecExtensions(doc as unknown as SpecLike, origin);
    return c.json(enriched as unknown as Record<string, unknown>);
  });

  // Mount the Scalar UI. Scalar's hono middleware returns HTML that
  // bootstraps the @scalar/api-reference standalone bundle from a
  // CDN. Configuration here is the cheap polish from D5 in the plan
  // (metadata + auth preset + hidden clients + layout).
  app.get(
    cfg.uiPath,
    Scalar({
      url: cfg.specPath,
      pageTitle: 'Textral API Reference',
      // Brand metadata for OG card / page <head>.
      metaData: {
        title: 'Textral API',
        description:
          'Multi-tenant retrieval-augmented generation API. ' +
          'Citation-grounded answers, profile-driven enrichment, ' +
          'and per-namespace evaluations on Cloudflare.',
      },
      // Defensive table styles. Scalar's default table CSS applies
      // an aggressive `word-break` that character-splits short cells
      // (e.g. HTTP status codes "429" → "4\n29") in the rendered
      // markdown description. Override globally so:
      //   * <code> never wraps mid-character (HTTP codes, error
      //     codes, paths stay readable in cells)
      //   * table cells use the browser-default word-break
      // The error-catalog table also pins column widths via
      // <colgroup> in its raw HTML; that's the primary fix for the
      // catalog itself, but this CSS is a defense against the same
      // class of problem on any other description table.
      customCss: `
        .markdown table th,
        .markdown table td,
        .markdown table th *,
        .markdown table td * {
          word-break: normal;
          overflow-wrap: normal;
        }
        .markdown table td code,
        .markdown table th code {
          white-space: nowrap;
        }
        .markdown table {
          table-layout: auto;
        }
      `,
      // Layout + UX defaults. `modern` is the three-pane responsive
      // layout (the default — explicit for clarity).
      layout: 'modern',
      defaultOpenAllTags: false,
      searchHotKey: 'k',
      documentDownloadType: 'json',
      // Trim noisy Try-It clients to the four languages our code
      // samples will eventually cover.
      hiddenClients: {
        csharp: true,
        java: true,
        php: true,
        ruby: true,
        go: true,
        // Curl + JS (fetch / Node) + Python remain visible.
      },
      // Auth preset: a placeholder so the field is populated; user
      // pastes their real key once and persistAuth keeps it in
      // localStorage. We never ship a write-capable demo key in
      // public docs.
      authentication: {
        preferredSecurityScheme: 'ApiKeyAuth',
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Textral-Api-Key',
            value: 'tx_demo_paste_yours_here',
          },
        },
      },
      persistAuth: true,
    }),
  );
}
