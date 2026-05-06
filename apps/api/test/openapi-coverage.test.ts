// OpenAPI spec + Scalar UI coverage.
//
// Pins two contracts:
//   1. Every Worker-served public path appears in the generated spec.
//      Future-proofs against forgotten createRoute(...) definitions.
//   2. The spec is well-formed: parseable, has `paths`, has at least one
//      security scheme, and the `/docs` UI references the spec URL.
//
// Debug-only routes (`/dev/ingest-ping`, `/__redaction_check`) MUST NOT
// appear in the spec — they are gated by ENABLE_DEBUG_ROUTES and are
// not part of the public contract.

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
  // /v1/admin/bootstrap is a real endpoint but intentionally hidden
  // from the public spec (Phase D1 — operator/admin only, not normal
  // onboarding). Pin its absence in the docs-regression test instead.
  // Phase 3
  { path: '/v1/namespaces/{slug}/documents', method: 'post' },
  { path: '/v1/namespaces/{slug}/documents', method: 'get' },
  { path: '/v1/documents/{id}', method: 'get' },
  { path: '/v1/documents/{id}/chunks', method: 'get' },
  { path: '/v1/documents/{id}/uploads', method: 'post' },
  { path: '/v1/documents/{id}/uploads/{upload_id}/finalize', method: 'post' },
  { path: '/v1/documents/{id}/ingest', method: 'post' },
  { path: '/v1/ingestion-jobs/{id}', method: 'get' },
  { path: '/v1/ingestion-jobs/{id}/logs', method: 'get' },
  // Phase 4
  { path: '/v1/query', method: 'post' },
  { path: '/v1/query-events', method: 'get' },
  { path: '/v1/query-events/{id}', method: 'get' },
  { path: '/v1/query-events/{id}/response', method: 'get' },
  { path: '/v1/chunks/{id}', method: 'get' },
];

async function fetchSpec(): Promise<OpenAPIDoc> {
  const e = env as unknown as Env;
  const res = await callJson(e, 'GET', 'http://x/openapi.json');
  expect(res.status).toBe(200);
  return (await res.json()) as OpenAPIDoc;
}

describe('OpenAPI spec', () => {
  it('is served at /openapi.json with correct headline fields', async () => {
    const doc = await fetchSpec();
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.info.title).toBe('Textral API');
    expect(doc.info.version).toBeTruthy();
    expect(typeof doc.paths).toBe('object');
  });

  it('declares ApiKeyAuth + AdminToken security schemes', async () => {
    const doc = await fetchSpec();
    expect(doc.components?.securitySchemes?.ApiKeyAuth).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'X-Textral-Api-Key',
    });
    expect(doc.components?.securitySchemes?.AdminToken).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'X-Admin-Bootstrap-Token',
    });
  });

  it('covers every public route', async () => {
    const doc = await fetchSpec();
    const missing: string[] = [];
    for (const { path, method } of EXPECTED_PATHS) {
      const ops = doc.paths[path];
      if (!ops || !(method in ops)) missing.push(`${method.toUpperCase()} ${path}`);
    }
    expect(missing, `Missing OpenAPI definitions: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not advertise debug-only routes', async () => {
    const doc = await fetchSpec();
    expect(doc.paths['/__redaction_check']).toBeUndefined();
    expect(doc.paths['/dev/ingest-ping']).toBeUndefined();
  });

  it('every operation declares at least one response', async () => {
    const doc = await fetchSpec();
    const empties: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const responses = (op as { responses?: Record<string, unknown> }).responses;
        if (!responses || Object.keys(responses).length === 0) {
          empties.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(empties).toEqual([]);
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
