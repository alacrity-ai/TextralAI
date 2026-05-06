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
  c.json({ status: 'ok' as const, env: c.env.runtimeEnv, ts: Date.now() }),
);
