// Self-host api entrypoint. Node-runtime sibling of
// `apps/api/src/index.ts` (the CF Worker entrypoint). Same Hono app;
// different bindings + lifecycle.
//
// SIGTERM / SIGINT handler:
//   1. stop accepting new connections (server.close)
//   2. drain in-flight bg tasks (NodeBackgroundTasks; 30s timeout)
//   3. close pg pool
//   4. disconnect redis
//   5. exit cleanly
// Mirrors the `waitUntil`-style guarantees the CF runtime gets for
// free — fire-and-forget work isn't lost on graceful shutdown.

import { serve } from '@hono/node-server';
import app from '../../app.js';
import { buildNodeBindings } from './bindings.js';

const ctx = buildNodeBindings(process.env);

const server = serve({
  fetch: (req) => app.fetch(req, ctx.bindings),
  port: Number(process.env.PORT ?? 8787),
});

console.log(
  JSON.stringify({
    event: 'api_started',
    port: Number(process.env.PORT ?? 8787),
    runtime: 'node',
  }),
);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  server.close();
  await ctx.bg.drain();
  await ctx.pgPool.end();
  ctx.redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
