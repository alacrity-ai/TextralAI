// High-level helper that drives the full bulk-ingest choreography
// from a list of {filename, bytes} entries: submit manifest → upload
// each file in parallel under a concurrency cap → optional finalize →
// poll until terminal. Surfaces a snapshot to `onProgress` on every
// poll so the Sandbox UI can render live state.

import type {
  BulkConfig,
  BulkJobStatus,
  BulkOnExisting,
  BulkSubmitResponse,
} from '@textral/contracts';
import type { TextralClient } from './client.js';

export interface BulkOrchestrateFile {
  filename: string;
  /** Bytes to upload. Browser: `Blob` / `File`. Node: `Uint8Array`
   *  or a `ReadableStream`. */
  bytes: Blob | Uint8Array | ReadableStream<Uint8Array>;
  size_bytes: number;
  content_type: string;
  client_request_id?: string;
}

export interface BulkOrchestrateInput {
  namespace: string;
  config: BulkConfig;
  files: BulkOrchestrateFile[];
  on_existing?: BulkOnExisting;
  /** Default true (SDK + MCP). Set false in the Sandbox so the user
   *  reviews before paid work begins; the Sandbox calls
   *  `client.bulkIngest.finalize(id)` after the confirm step. */
  auto_finalize?: boolean;
  client_request_id?: string;
  /** Max parallel uploads. Default 6 — friendly to consumer-grade
   *  networks and the browser HTTP/2 multiplex window. */
  concurrency?: number;
  onProgress?: (snapshot: BulkJobStatus) => void;
  /** Polling cadence in ms. Default 1500. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Source label used by the API to attribute the job
   *  (`api` / `mcp` / `sandbox`). Defaults to `api`. */
  source?: 'api' | 'mcp' | 'sandbox';
}

export interface BulkOrchestrateResult {
  bulk_job_id: string;
  final_status: BulkJobStatus;
}

const TERMINAL_STATES = new Set([
  'complete',
  'partial',
  'failed',
  'cancelled',
  'expired',
]);

export async function bulkIngestOrchestrate(
  client: TextralClient,
  input: BulkOrchestrateInput,
): Promise<BulkOrchestrateResult> {
  const concurrency = input.concurrency ?? 6;
  const pollIntervalMs = input.pollIntervalMs ?? 1500;
  const autoFinalize = input.auto_finalize ?? true;

  // 1. Submit manifest. Files derived from inputs.
  const submitBody = {
    namespace: input.namespace,
    config: input.config,
    files: input.files.map((f, i) => ({
      ordinal: i,
      filename: f.filename,
      size_bytes: f.size_bytes,
      content_type: f.content_type,
      ...(f.client_request_id ? { client_request_id: f.client_request_id } : {}),
    })),
    on_existing: input.on_existing ?? 'skip_if_unchanged',
    auto_finalize: autoFinalize,
    ...(input.client_request_id ? { client_request_id: input.client_request_id } : {}),
  };
  const submitResp: BulkSubmitResponse = await client.bulkIngest.submit(submitBody);

  if (input.signal?.aborted) throw new Error('Aborted before upload phase');

  // 2. Upload bytes in parallel under the concurrency cap.
  const slots = submitResp.uploads;
  const tasks = slots.map((slot) => async () => {
    if (input.signal?.aborted) throw new Error('Aborted');
    const file = input.files[slot.ordinal]!;
    const init: RequestInit = {
      method: 'PUT',
      headers: {
        ...slot.headers,
        // The bulk PUT route is gated by X-Textral-Api-Key like every
        // other /v1/* route. The TextralClient injects it; for the
        // direct fetch we replicate.
        'X-Textral-Api-Key': (client as unknown as { apiKey: string }).apiKey,
      },
      body: file.bytes as BodyInit,
    };
    if (input.signal) init.signal = input.signal;
    const res = await fetch(slot.upload_url, init);
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => '');
      throw new Error(`PUT ${slot.upload_url} failed: ${res.status} ${text}`);
    }
  });
  await runWithConcurrency(tasks, concurrency);

  if (input.signal?.aborted) throw new Error('Aborted after upload phase');

  // 3. Finalize if not auto.
  if (!autoFinalize) {
    await client.bulkIngest.finalize(submitResp.bulk_job_id);
  }

  // 4. Poll until terminal.
  const finalStatus = await pollBulkJob(client, submitResp.bulk_job_id, {
    pollIntervalMs,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return { bulk_job_id: submitResp.bulk_job_id, final_status: finalStatus };
}

/** Poll a bulk job until it reaches a terminal state. Useful as a
 *  standalone helper in the MCP tool's `wait=true` mode. */
export async function pollBulkJob(
  client: TextralClient,
  bulkJobId: string,
  opts: {
    pollIntervalMs?: number;
    onProgress?: (snapshot: BulkJobStatus) => void;
    signal?: AbortSignal;
    /** Max wait, ms. Defaults to 1 hour; `Infinity` to wait
     *  indefinitely (until cancellation). */
    maxWaitMs?: number;
  } = {},
): Promise<BulkJobStatus> {
  const interval = opts.pollIntervalMs ?? 1500;
  const start = Date.now();
  const max = opts.maxWaitMs ?? 60 * 60 * 1000;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('Aborted while polling');
    if (Date.now() - start > max) {
      throw new Error(
        `Bulk job ${bulkJobId} did not reach terminal state within ${max}ms`,
      );
    }
    const snap = await client.bulkIngest.get(bulkJobId);
    opts.onProgress?.(snap);
    if (TERMINAL_STATES.has(snap.state)) return snap;
    await sleep(interval, opts.signal);
  }
}

async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const errs: Error[] = [];
  async function worker() {
    while (cursor < tasks.length) {
      const idx = cursor++;
      try {
        await tasks[idx]!();
      } catch (e) {
        errs.push(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  if (errs.length > 0) {
    // Per-file failures are tolerated by the API (failed files
    // become `state='failed'` and the bulk job becomes `partial`),
    // but a wholesale upload outage is worth surfacing.
    if (errs.length === tasks.length) {
      throw new AggregateError(errs, 'every bulk-upload PUT failed');
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new Error('Aborted'));
        },
        { once: true },
      );
    }
  });
}
