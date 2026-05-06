// Internal back-channel HMAC authentication.
//
// Every Container → Worker request carries:
//   X-Textral-Internal-Timestamp:  unix ms (decimal)
//   X-Textral-Internal-Signature:  hex(hmac_sha256(secret, canonical))
//   X-Textral-Internal-KeyId:      reserved for rotation; defaults to 'v1'
//
// `canonical = method + "\n" + path + "\n" + sha256(body) + "\n" + timestamp`.
//
// Middleware enforces:
//   1. INTERNAL_HMAC_SECRET is set; otherwise 404 (the route doesn't exist).
//   2. |now - timestamp| ≤ 5 min.
//   3. Constant-time HMAC verify against `INTERNAL_HMAC_SECRET`.
//   4. body_hash re-validated against actual request bytes.
//
// This is defense in depth on top of: (a) network isolation (the
// Container only talks to the Worker over HTTPS within the CF data plane),
// (b) the IT engineer's deploy-time secret distribution.

import { createMiddleware } from 'hono/factory';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../types.js';

const WINDOW_MS = 5 * 60 * 1000;

export const internalAuth = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const secret = c.env.INTERNAL_HMAC_SECRET;
  if (!secret) {
    // No secret → no internal back-channel. 404 to keep the surface invisible.
    return c.notFound();
  }

  const tsHeader = c.req.header('x-textral-internal-timestamp');
  const sigHeader = c.req.header('x-textral-internal-signature');
  if (!tsHeader || !sigHeader) {
    throw new TextralError('INTERNAL_AUTH_REQUIRED', 401, 'Missing internal HMAC headers');
  }
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) {
    throw new TextralError('INTERNAL_AUTH_REQUIRED', 401, 'Invalid internal timestamp');
  }
  if (Math.abs(Date.now() - ts) > WINDOW_MS) {
    throw new TextralError(
      'INTERNAL_TIMESTAMP_OUT_OF_WINDOW',
      401,
      'Internal timestamp outside the 5-minute window',
    );
  }

  // Capture the body bytes once; re-expose them as the request body so
  // the downstream handler can still parse JSON normally.
  const bodyBytes = await c.req.raw.clone().arrayBuffer();
  const bodyHashBuf = await crypto.subtle.digest('SHA-256', bodyBytes);
  const bodyHashHex = bytesToHex(new Uint8Array(bodyHashBuf));

  // Hono's URL accessor strips query strings on `c.req.path` (which is
  // route-pattern, not actual path). For HMAC we want the raw path the
  // client signed.
  const url = new URL(c.req.url);
  const path = url.pathname;
  const method = c.req.method.toUpperCase();
  const canonical = `${method}\n${path}\n${bodyHashHex}\n${ts}`;

  const expected = await hmacSha256Hex(secret, canonical);
  if (!constantTimeEqual(expected, sigHeader)) {
    throw new TextralError('INTERNAL_SIGNATURE_INVALID', 401, 'Internal HMAC signature mismatch');
  }

  await next();
});

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Re-export — used by the internal route handlers to compute the same
 *  HMAC for outbound responses (rare; the Container is the signer). */
export { hmacSha256Hex };
