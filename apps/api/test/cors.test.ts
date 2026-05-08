// CORS middleware E2E. Hits public + auth-required routes through
// the Worker's default-export to prove ACAO header behavior is
// driven by ALLOWED_ORIGINS without leaking through other middleware.

import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';
import type { Env } from '../src/types.js';

const ALLOWED = 'http://localhost:5173';
const DISALLOWED = 'https://evil.example.com';

async function fetchWith(method: string, path: string, headers: Record<string, string>) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://x${path}`, { method, headers }),
    env as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('CORS middleware', () => {
  it('echoes ACAO when origin is on the allowlist (non-preflight)', async () => {
    const res = await fetchWith('GET', '/healthz', { origin: ALLOWED });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')?.toLowerCase()).toContain('origin');
  });

  it('omits ACAO when origin is not on the allowlist', async () => {
    const res = await fetchWith('GET', '/healthz', { origin: DISALLOWED });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('omits ACAO entirely when no Origin header is present', async () => {
    const res = await fetchWith('GET', '/healthz', {});
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('OPTIONS preflight with allowed origin returns 204 + ACAM/ACAH', async () => {
    const res = await fetchWith('OPTIONS', '/v1/me', {
      origin: ALLOWED,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-textral-api-key',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'x-textral-api-key',
    );
    expect(res.headers.get('access-control-max-age')).toBe('86400');
  });

  it('OPTIONS preflight with disallowed origin returns 403 (and no ACAO)', async () => {
    const res = await fetchWith('OPTIONS', '/v1/me', {
      origin: DISALLOWED,
      'access-control-request-method': 'GET',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('runs BEFORE auth so preflight does not need an api key', async () => {
    // No x-textral-api-key on the preflight — auth would 401 a real
    // GET. The preflight must short-circuit cleanly with 204.
    const res = await fetchWith('OPTIONS', '/v1/namespaces', {
      origin: ALLOWED,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-textral-api-key',
    });
    expect(res.status).toBe(204);
  });
});
