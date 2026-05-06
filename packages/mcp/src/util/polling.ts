// Polling helper for long-running ingestion jobs. Emits MCP progress
// notifications on stage transitions when the caller requested
// progress (i.e., progressToken was set).
//
// Stage sequence under `mode=full`:
//   fetch → normalize → chunk → enrich (optional) → embed → index
// We don't hardcode the sequence — we just emit on every change to
// `current_stage`. The progress count is the count of distinct
// stages observed so far.

import type { TextralClient } from '@textral/sdk';
import { TextralApiError } from '@textral/sdk';
import type { IngestionJob } from '@textral/contracts';
import type { ToolHandlerCtx } from '../tools/types.js';

export interface PollOptions {
  jobId: string;
  timeoutMs: number;
  intervalMs?: number;
}

/** Polls `/v1/ingestion-jobs/{id}` until terminal (`completed` or
 *  `failed`) or the timeout is reached. Emits one progress event
 *  per `current_stage` transition plus a final event on terminal
 *  state. Honours the AbortSignal — if cancelled, throws a
 *  CancelledError. */
export class PollTimeoutError extends Error {
  override name = 'PollTimeoutError';
  constructor(public lastJob: IngestionJob | null, timeoutMs: number) {
    super(`ingestion job did not reach a terminal state within ${timeoutMs}ms`);
  }
}

export class CancelledError extends Error {
  override name = 'CancelledError';
  constructor() {
    super('request cancelled');
  }
}

export async function pollJobUntilTerminal<TInput>(
  ctx: Pick<ToolHandlerCtx<TInput>, 'client' | 'progress' | 'signal' | 'recordRestCall'>,
  opts: PollOptions,
): Promise<IngestionJob> {
  const interval = opts.intervalMs ?? 1500;
  const deadline = Date.now() + opts.timeoutMs;
  const seenStages = new Set<string>();
  let lastStage: string | null = null;
  let lastJob: IngestionJob | null = null;

  while (Date.now() < deadline) {
    if (ctx.signal.aborted) throw new CancelledError();

    let job: IngestionJob;
    try {
      ctx.recordRestCall();
      job = await ctx.client.ingestionJobs.get(opts.jobId);
    } catch (e) {
      // 404 during early polling can happen if dispatch races. Retry
      // a few times before bubbling.
      if (e instanceof TextralApiError && e.status === 404) {
        await sleepWithSignal(interval, ctx.signal);
        continue;
      }
      throw e;
    }
    lastJob = job;

    if (job.current_stage && job.current_stage !== lastStage) {
      lastStage = job.current_stage;
      seenStages.add(job.current_stage);
      await ctx.progress({
        progress: seenStages.size,
        message: `stage: ${job.current_stage}`,
      });
    }

    if (job.status === 'completed' || job.status === 'failed') {
      await ctx.progress({
        progress: seenStages.size + 1,
        message: `terminal: ${job.status}`,
      });
      return job;
    }

    await sleepWithSignal(interval, ctx.signal);
  }

  throw new PollTimeoutError(lastJob, opts.timeoutMs);
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
