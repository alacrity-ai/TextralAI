// Cron registry + dispatcher.
//
// One scheduled handler in the Workers entrypoint dispatches by
// `event.cron` into this registry. Each entry is self-contained: a
// cron pattern, a short name, a description for telemetry/docs, and
// an idempotent runner that takes the runtime-shared `Bindings`.
//
// Adding a new cron is a four-step PR:
//   1. Implement the runner under `src/scheduled/{name}.ts`. It must
//      take `Bindings`, be idempotent, and return a JSON-serializable
//      result object (not throw on partial failure — the dispatcher
//      logs but doesn't propagate; throwing would not abort the
//      Workers `scheduled` invocation, just lose us a structured
//      log line).
//   2. Append to `SCHEDULES` below.
//   3. Add the cron pattern to `[env.{dev,prod}.triggers] crons` in
//      `apps/api/wrangler.toml`.
//   4. Add a row to the table in
//      `docs/development/cron/CRON_SCAFFOLD.md`.
//
// Local testing: `wrangler dev` exposes
// `http://localhost:8787/__scheduled?cron=<pattern>` for ad-hoc
// invocation against the dev D1 + R2 bindings. Remote invocation
// is via `npx wrangler triggers deploy` (which CF runs against the
// Worker on the schedule).

import type { Bindings } from '../runtime/shared/interfaces.js';
import { expireUnfinalizedBulkJobs } from './bulk-job-expire.js';

export interface CronJob {
  /** The cron pattern as it appears in `wrangler.toml`. Must be
   *  unique within `SCHEDULES` — the dispatcher uses it as the
   *  routing key. If you genuinely want two handlers on the same
   *  schedule, write one runner that calls both internally; do not
   *  duplicate the pattern in this list. */
  cron: string;
  /** Short snake_case identifier. Appears in dispatcher log lines
   *  (`cron_started`, `cron_completed`, `cron_failed`) and in the
   *  CRON_SCAFFOLD doc table. Stable — log queries depend on it. */
  name: string;
  /** Human-readable one-liner. Displayed in the scaffold doc. */
  description: string;
  /** The runner. Must be idempotent (CF can deliver the same cron
   *  twice on retry) and tolerate partial failures internally. */
  run(bindings: Bindings): Promise<unknown>;
}

export const SCHEDULES: CronJob[] = [
  {
    cron: '0 3 * * *',
    name: 'bulk-job-expire',
    description:
      'Sweep un-finalized bulk_jobs past their 7-day TTL; delete each job\'s tmp R2 keys; mark the row expired.',
    run: (bindings) => expireUnfinalizedBulkJobs(bindings),
  },
  // ── Future crons ────────────────────────────────────────────────
  //
  // See docs/development/cron/CRON_SCAFFOLD.md §Future for the
  // complete inventory of identified stale-data scenarios. Each
  // gets its own row here when implemented.
];

/** Match `event.cron` against the registry, run the handler, log
 *  structured telemetry. Errors are caught — a failing cron logs
 *  `cron_failed` and returns; it doesn't propagate. CF treats a
 *  thrown `scheduled` handler as a no-op anyway, but we log
 *  explicitly for grep-ability. */
export async function dispatchCron(
  cronExpr: string,
  bindings: Bindings,
): Promise<void> {
  const job = SCHEDULES.find((s) => s.cron === cronExpr);
  if (!job) {
    console.warn(
      JSON.stringify({
        event: 'cron_no_handler',
        cron: cronExpr,
      }),
    );
    return;
  }
  const startedAt = Date.now();
  console.log(
    JSON.stringify({
      event: 'cron_started',
      name: job.name,
      cron: cronExpr,
    }),
  );
  try {
    const result = await job.run(bindings);
    console.log(
      JSON.stringify({
        event: 'cron_completed',
        name: job.name,
        cron: cronExpr,
        duration_ms: Date.now() - startedAt,
        result,
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'cron_failed',
        name: job.name,
        cron: cronExpr,
        duration_ms: Date.now() - startedAt,
        error: String((err as Error)?.message ?? err),
      }),
    );
  }
}
