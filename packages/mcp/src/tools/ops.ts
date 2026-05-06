// Operations tools — Step 9. DLQ inspection + retry. The retry tool
// supports `wait=true` so the agent can confirm a recovery completed
// (or failed again) without separately polling.

import { z } from 'zod';
import { defineTool } from './types.js';
import { pollJobUntilTerminal } from '../util/polling.js';

export const listFailingJobs = defineTool({
  name: 'list_failing_jobs',
  description: 'List dead-lettered ingestion jobs for the calling tenant, paginated. Used to inspect ingestion failures.',
  inputSchemaZod: z.object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    const q: { limit?: number; cursor?: string } = {};
    if (args.limit !== undefined) q.limit = args.limit;
    if (args.cursor !== undefined) q.cursor = args.cursor;
    return await client.admin.listFailingJobs(q);
  },
});

export const retryFailingJob = defineTool({
  name: 'retry_failing_job',
  description: 'Retry a dead-lettered ingestion job. wait=true blocks until the retry terminates and emits progress per stage.',
  inputSchemaZod: z.object({
    job_id: z.string(),
    wait: z.boolean().default(false),
    wait_timeout_ms: z.number().int().positive().max(30 * 60_000).default(300_000),
  }),
  handler: async ({ args, client, recordRestCall, progress, signal }) => {
    recordRestCall();
    await client.ingestionJobs.retry(args.job_id);

    if (!args.wait) {
      return { job_id: args.job_id, status: 'retrying' as const };
    }

    const job = await pollJobUntilTerminal(
      { client, progress, signal, recordRestCall },
      { jobId: args.job_id, timeoutMs: args.wait_timeout_ms },
    );
    return { job_id: args.job_id, job };
  },
});
