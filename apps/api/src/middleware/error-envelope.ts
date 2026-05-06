// Global error→envelope handler. Wired as the top-level `app.onError` and
// reused by sub-app onError handlers. Wraps a `TextralError` in the
// canonical envelope; for unknown errors it logs structured fields and
// returns a generic 500 (no leakage of internal details).

import type { Context } from 'hono';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../types.js';

export function handleError(err: Error, c: Context<{ Bindings: Env; Variables: Variables }>) {
  if (err instanceof TextralError) {
    return c.json(
      err.toEnvelope(c.get('request_id')),
      err.httpStatus as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503,
    );
  }
  console.error('unhandled_error', { message: err.message });
  return c.json(
    {
      error: {
        code: 'INTERNAL',
        message: 'Internal server error',
        ...(c.get('request_id') ? { request_id: c.get('request_id') } : {}),
      },
    },
    500,
  );
}
