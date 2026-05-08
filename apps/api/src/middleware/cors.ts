// CORS middleware. Reads `c.env.ALLOWED_ORIGINS` (comma-separated
// allowlist) and:
//   - On OPTIONS preflight, short-circuits with 204 + ACAO/ACAM/ACAH
//     headers if the Origin is allowed; 403 otherwise. Preflight runs
//     BEFORE auth so the browser never has to attach the api key to
//     the preflight request.
//   - On non-preflight, runs the downstream handler and adds ACAO +
//     credentials/Vary headers if the Origin is allowed.
//
// `*` in ALLOWED_ORIGINS allows all origins but disables credentials
// (browser spec — `*` + `credentials: include` is illegal).
//
// We intentionally don't emit ACAO when there's no Origin header
// (same-origin requests, server-to-server) — letting the browser
// default to same-origin behavior.

import { createMiddleware } from 'hono/factory';
import type { Env, Variables } from '../types.js';

const PREFLIGHT_HEADERS =
  'content-type, x-textral-api-key, x-textral-admin-token, accept, authorization, x-request-id, x-textral-internal-signature';

function parseAllowList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const corsMiddleware = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    const origin = c.req.header('origin');
    const allowList = parseAllowList(c.env.ALLOWED_ORIGINS);
    const wildcard = allowList.includes('*');
    const originAllowed = !!origin && (wildcard || allowList.includes(origin));

    if (c.req.method === 'OPTIONS') {
      if (!originAllowed) return c.body(null, 403);
      return c.body(null, 204, {
        'access-control-allow-origin': wildcard ? '*' : origin!,
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': PREFLIGHT_HEADERS,
        ...(wildcard ? {} : { 'access-control-allow-credentials': 'true' }),
        'access-control-max-age': '86400',
        vary: 'Origin',
      });
    }

    await next();

    if (originAllowed) {
      c.res.headers.set('access-control-allow-origin', wildcard ? '*' : origin!);
      if (!wildcard) {
        c.res.headers.set('access-control-allow-credentials', 'true');
      }
      c.res.headers.append('vary', 'Origin');
    }
  },
);
