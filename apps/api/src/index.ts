// Textral API — Cloudflare Worker entrypoint.
//
// Runtime-agnostic Hono construction lives in `apps/api/src/app.ts`;
// this file is the CF-runtime-specific shell that wraps it with the
// Workers `fetch` + `queue` + `IngestContainer` exports wrangler
// needs to find.
//
// V3 Phase 2: every request builds a runtime-agnostic `Bindings`
// from the CF `Env` via `buildCfBindings(env, ctx)`. Routes consume
// the `Bindings` shape (`c.env.db`, `c.env.blobs`, ...) but, during
// the migration period, can also reach the legacy CF binding fields
// (`c.env.DB`, `c.env.BLOBS`, ...) since `Env extends Bindings`.

import app from './app.js';
import { processIngestQueue, type IngestQueueMessage } from './runtime/cf/queue-consumer.js';
import { dispatchCron } from './scheduled/index.js';
import type { Env } from './types.js';
import { buildCfBindings } from './runtime/cf/bindings.js';

export { IngestContainer } from './runtime/cf/container.js';

export default {
  async fetch(req, env, ctx) {
    const bindings = buildCfBindings(env, ctx);
    return app.fetch(req, bindings, ctx);
  },
  async queue(batch, env) {
    const bindings = buildCfBindings(env, null);
    await processIngestQueue(batch as MessageBatch<IngestQueueMessage>, bindings);
  },
  async scheduled(event, env, ctx) {
    const bindings = buildCfBindings(env, ctx);
    // ctx.waitUntil keeps the dispatcher alive past `scheduled`'s
    // synchronous return, mirroring how `fetch` waits on async
    // background work. Without it, a slow cron could be cut off
    // mid-run when the handler returns.
    ctx.waitUntil(dispatchCron(event.cron, bindings));
  },
} satisfies ExportedHandler<Env, IngestQueueMessage>;
