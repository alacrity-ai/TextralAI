// Set<Promise>-backed BackgroundTasks for the Node runtime.
//
// Each `spawn(p)` adds the promise to a tracked set. The `drain()`
// method (called from the SIGTERM handler in
// `runtime/node/index.ts`) waits up to 30 seconds for all pending
// tasks to settle, then logs a warning for any that didn't. This
// preserves Workers' `waitUntil`-style semantics under graceful
// shutdown — fire-and-forget work isn't lost when the server stops
// accepting requests.

import type { BackgroundTasks } from '../shared/interfaces.js';

const DRAIN_TIMEOUT_MS = 30_000;

export class NodeBackgroundTasks implements BackgroundTasks {
  private readonly pending = new Set<Promise<unknown>>();

  spawn(promise: Promise<unknown>): void {
    this.pending.add(promise);
    promise
      .catch((e) => {
        console.error(
          JSON.stringify({
            event: 'bg_task_failed',
            message: String((e as Error)?.message ?? e),
          }),
        );
      })
      .finally(() => this.pending.delete(promise));
  }

  /** Wait up to 30s for in-flight tasks to settle. Returns once
   *  drained (or the timeout fires). Idempotent. */
  async drain(): Promise<void> {
    if (this.pending.size === 0) return;
    const tasks = [...this.pending];
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS),
    );
    const result = await Promise.race([
      Promise.allSettled(tasks).then(() => 'settled' as const),
      timeout,
    ]);
    if (result === 'timeout' && this.pending.size > 0) {
      console.warn(
        JSON.stringify({
          event: 'bg_drain_timeout',
          pending: this.pending.size,
        }),
      );
    }
  }
}
