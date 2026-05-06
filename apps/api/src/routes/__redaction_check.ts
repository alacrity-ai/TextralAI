// /__redaction_check — dev-only fuzz harness for the redaction middleware.
//
// POSTs a body containing a candidate secret. The route:
//   1. Logs the body via console.log (gets intercepted + redacted).
//   2. Constructs an AI Gateway-style metadata header value.
//   3. Returns what each sink WOULD have seen, plus the redacted form.
//
// The corresponding test (test/redaction-fuzz.test.ts) generates
// realistic provider-key shapes, posts them here, and asserts that NO
// sink ever observes the original substring.

import { Hono } from 'hono';
import type { Env, Variables } from '../types.js';
import { redact, redactHeaders, redactJson } from '../middleware/redaction.js';

export const redactionCheckRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

redactionCheckRoute.post('/', async (c) => {
  if (c.env.ENABLE_DEBUG_ROUTES !== 'true') return c.notFound();
  const raw = await c.req.text();
  const headers = redactHeaders(c.req.raw.headers);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }

  // Capture what each sink would emit (without actually emitting via
  // intercepted console — we want to inspect the redacted output here).
  const sinks = {
    redacted_body: redactJson(parsed),
    redacted_string_fallback: redact(raw),
    redacted_headers: headers,
  };
  return c.json(sinks);
});
