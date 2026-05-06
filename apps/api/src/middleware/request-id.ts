// request_id middleware. Generates a `req_<ulid>` per request, stashes
// it on the Hono context, and echoes it as `X-Request-Id` on the response.

import { createMiddleware } from 'hono/factory';
import { newId } from '@textral/contracts';
import type { Env, Variables } from '../types.js';

export const requestIdMiddleware = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    const incoming = c.req.header('X-Request-Id');
    const id = incoming ?? newId('req');
    c.set('request_id', id);
    c.header('X-Request-Id', id);
    await next();
  },
);
