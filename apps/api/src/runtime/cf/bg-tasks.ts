// ExecutionContext.waitUntil → BackgroundTasks adapter. Per-request
// instance built in `buildCfBindings`.

import type { BackgroundTasks } from '../shared/interfaces.js';

export class CfBackgroundTasks implements BackgroundTasks {
  constructor(private readonly ctx: ExecutionContext) {}
  spawn(promise: Promise<unknown>): void {
    this.ctx.waitUntil(promise);
  }
}

/** Used by the queue-consumer entry path where no `ExecutionContext`
 *  is available. The queue handler runs to completion synchronously
 *  per Workers semantics, so any post-message work has nowhere to
 *  outlive it.
 *
 *  DO NOT add `bindings.bg.spawn(...)` calls inside `runIngestMessage`
 *  expecting `waitUntil`-style "fire and outlive the request"
 *  behavior — the Workers isolate may be reused immediately after
 *  the queue handler returns and any unawaited promise will be lost.
 *  If you need post-message work, `await` it directly within the
 *  message body. The Node-side ingest-consumer (Step 19) wires a
 *  proper `NodeBackgroundTasks` shim that drains pending promises on
 *  SIGTERM, but the CF queue path has no equivalent. */
export class NoopBackgroundTasks implements BackgroundTasks {
  spawn(promise: Promise<unknown>): void {
    // Best-effort: at least catch the rejection so it doesn't
    // surface as unhandled.
    promise.catch(() => {});
  }
}
