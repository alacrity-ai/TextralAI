// Bulk ingest from local filesystem. The single tool that fixes the
// b64-into-context failure documented in
// docs/roadmap/LARGE_INGEST_ISSUE.md §1.
//
// Tool inputs are paths or globs — never bytes. The MCP server reads
// from disk in this process and PUTs to the bulk API. Agent context
// cost is constant in total bytes (just a path + a config).

import { z } from 'zod';
import {
  EmbeddingConfig,
  ChunkingConfig,
  NamespaceSlug,
} from '@textral/contracts';
import { defineTool } from './types.js';
import {
  loadFsConfigFromEnv,
  resolveExplicitFiles,
  resolveGlob,
  readResolvedFileBytes,
  type ResolvedFile,
  type SkippedFile,
} from '../fs/path-resolver.js';

const FilesMode = z.object({
  mode: z.literal('files'),
  namespace: NamespaceSlug,
  files: z.array(z.string().min(1)).min(1),
  defaults: z.object({
    embedding: EmbeddingConfig,
    chunking: ChunkingConfig.default({}),
    doc_type: z.string().optional(),
    title_from: z
      .enum(['filename', 'relative_path'])
      .default('filename'),
  }),
  on_existing: z
    .enum(['skip_if_unchanged', 'new_version', 'replace_current'])
    .default('skip_if_unchanged'),
  wait: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(16).default(4),
  dry_run: z.boolean().default(false),
  response_detail: z.enum(['summary', 'errors', 'full']).default('summary'),
});

const GlobMode = z.object({
  mode: z.literal('glob'),
  namespace: NamespaceSlug,
  root: z.string().min(1),
  patterns: z.array(z.string().min(1)).min(1),
  exclude: z.array(z.string()).default([]),
  defaults: FilesMode.shape.defaults,
  on_existing: FilesMode.shape.on_existing,
  wait: FilesMode.shape.wait,
  concurrency: FilesMode.shape.concurrency,
  dry_run: FilesMode.shape.dry_run,
  response_detail: FilesMode.shape.response_detail,
});

const IngestLocalPathsInput = z.discriminatedUnion('mode', [FilesMode, GlobMode]);

const TERMINAL_STATES = new Set([
  'complete',
  'partial',
  'failed',
  'cancelled',
  'expired',
]);

export const ingestLocalPaths = defineTool({
  name: 'ingest_local_paths',
  description:
    'Bulk-ingest local files. Pass paths (mode=files) or globs (mode=glob). MCP reads from disk; never base64 in tool args. Stdio-only. Use dry_run first.',
  inputSchemaZod: IngestLocalPathsInput,
  handler: async ({ args, client, recordRestCall, progress, signal }) => {
    const fsConfig = loadFsConfigFromEnv();
    if (fsConfig.mode === 'deny') {
      throw new Error(
        'TEXTRAL_MCP_FS_INGEST=deny — local filesystem ingestion is disabled by config.',
      );
    }

    // 1. Resolve files to upload.
    const resolveResult =
      args.mode === 'files'
        ? await resolveExplicitFiles(args.files, fsConfig)
        : await resolveGlob(args.root, args.patterns, fsConfig, args.exclude);

    if (args.dry_run) {
      return summarizeDryRun(resolveResult.files, resolveResult.skipped);
    }
    if (resolveResult.files.length === 0) {
      return {
        matched: 0,
        skipped: resolveResult.skipped.length,
        bulk_job_id: null,
        message:
          resolveResult.skipped.length > 0
            ? `No files matched after filtering. ${resolveResult.skipped.length} skipped — call dry_run=true to see why.`
            : 'No files matched.',
      };
    }

    // 2. Submit manifest to the bulk API.
    await progress({
      progress: 0,
      total: 4,
      message: `submitting manifest (${resolveResult.files.length} files)`,
    });
    recordRestCall();
    const submit = await client.bulkIngest.submit({
      namespace: args.namespace,
      config: {
        embedding: args.defaults.embedding,
        chunking: args.defaults.chunking,
        enrichment: { enabled: false, passes: [] },
        indexing: { replace_existing_vectors: false, artifact_types: ['passage'] },
        mode: 'full' as const,
        ...(args.defaults.doc_type ? { doc_type: args.defaults.doc_type } : {}),
      },
      files: resolveResult.files.map((f, i) => ({
        ordinal: i,
        filename: titleFor(f, args.defaults.title_from),
        size_bytes: f.size_bytes,
        content_type: f.content_type,
      })),
      on_existing: args.on_existing,
      auto_finalize: true,
    });

    if (signal.aborted) throw new Error('cancelled');

    // 3. Upload bytes in parallel under concurrency cap. Bytes
    //    stream from disk → fetch PUT; never enter agent context.
    await progress({
      progress: 1,
      total: 4,
      message: `uploading ${resolveResult.files.length} files (concurrency=${args.concurrency})`,
    });
    await uploadAll(
      resolveResult.files,
      submit.uploads,
      client,
      args.concurrency,
      signal,
    );

    if (signal.aborted) throw new Error('cancelled');

    // 4. Poll until terminal state. The status endpoint
    //    auto-finalizes on first read once all uploads have landed
    //    (server-side trigger when files_uploaded == total_files).
    if (!args.wait) {
      return {
        matched: resolveResult.files.length,
        skipped: resolveResult.skipped.length,
        bulk_job_id: submit.bulk_job_id,
        state: submit.state,
        message:
          'Submitted. Use get_bulk_ingest_job to poll status. Add wait=true for streaming progress.',
      };
    }

    await progress({
      progress: 2,
      total: 4,
      message: 'finalizing & ingesting',
    });
    const startTs = Date.now();
    let lastSent = -1;
    for (;;) {
      if (signal.aborted) throw new Error('cancelled');
      recordRestCall();
      const status = await client.bulkIngest.get(submit.bulk_job_id);
      if (status.progress_pct !== lastSent) {
        await progress({
          progress: 2 + (status.progress_pct / 100) * 2,
          total: 4,
          message: `${status.counts.succeeded} succeeded · ${status.counts.failed} failed · ${status.counts.processing + status.counts.enqueued} in flight`,
        });
        lastSent = status.progress_pct;
      }
      if (TERMINAL_STATES.has(status.state)) {
        return shapeResponse(
          status,
          submit.bulk_job_id,
          args.response_detail,
          args.mode === 'glob' ? args.root : null,
          resolveResult.skipped,
          Date.now() - startTs,
          client,
        );
      }
      await sleep(1500, signal);
    }
  },
});

export const getBulkIngestJob = defineTool({
  name: 'get_bulk_ingest_job',
  description:
    'Poll a bulk ingest job. Returns aggregate counts, progress, and first failure. Pass only_failures=true to get just failed file rows.',
  inputSchemaZod: z.object({
    bulk_job_id: z.string().min(1),
    only_failures: z.boolean().default(false),
  }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    const status = await client.bulkIngest.get(args.bulk_job_id);
    if (args.only_failures) {
      recordRestCall();
      const files = await client.bulkIngest.files(args.bulk_job_id, {
        state: 'failed',
        page_size: 1000,
      });
      return { status, failures: files.data };
    }
    return { status };
  },
});

export const cancelBulkIngestJob = defineTool({
  name: 'cancel_bulk_ingest_job',
  description:
    'Cancel a running bulk ingest job. Refuses if any file already succeeded — submit a new job for the rest. Cancellation is terminal.',
  inputSchemaZod: z.object({
    bulk_job_id: z.string().min(1),
  }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.bulkIngest.cancel(args.bulk_job_id);
  },
});

// ── helpers ────────────────────────────────────────────────────────────

function titleFor(
  f: ResolvedFile,
  mode: 'filename' | 'relative_path',
): string {
  if (mode === 'relative_path') return f.rel_path;
  const base = f.realpath.split('/').pop() ?? f.realpath;
  return base;
}

interface BulkUploadSlot {
  ordinal: number;
  upload_url: string;
  upload_id: string;
  expires_at: number;
  method: 'PUT';
  headers: Record<string, string>;
}

async function uploadAll(
  files: ResolvedFile[],
  slots: BulkUploadSlot[],
  client: import('@textral/sdk').TextralClient,
  concurrency: number,
  signal: AbortSignal,
): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (cursor < slots.length) {
      const i = cursor++;
      if (signal.aborted) return;
      const slot = slots[i]!;
      const file = files[slot.ordinal]!;
      const bytes = await readResolvedFileBytes(file);
      const headers: Record<string, string> = {
        ...slot.headers,
        'X-Textral-Api-Key': (client as unknown as { apiKey: string }).apiKey,
      };
      // Buffer → ArrayBuffer slice for fetch BodyInit. Node's
      // Buffer/Uint8Array are accepted by fetch at runtime; the DOM
      // BodyInit type is stricter.
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      const init: RequestInit = {
        method: 'PUT',
        headers,
        body: body as BodyInit,
      };
      if (signal) init.signal = signal;
      const res = await fetch(slot.upload_url, init);
      if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => '');
        throw new Error(`PUT ${file.realpath} failed: ${res.status} ${text}`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, slots.length) }, () => worker()),
  );
}

async function shapeResponse(
  status: {
    state: string;
    total_files: number;
    counts: {
      pending: number;
      uploaded: number;
      finalized: number;
      enqueued: number;
      processing: number;
      succeeded: number;
      failed: number;
      skipped: number;
    };
    first_failure: unknown;
  },
  bulkJobId: string,
  detail: 'summary' | 'errors' | 'full',
  root: string | null,
  skipped: SkippedFile[],
  durationMs: number,
  client: import('@textral/sdk').TextralClient,
): Promise<unknown> {
  const summary = {
    bulk_job_id: bulkJobId,
    state: status.state,
    matched: status.total_files,
    ingested: status.counts.succeeded,
    skipped_unchanged: status.counts.skipped,
    failed: status.counts.failed,
    fs_skipped: skipped.length,
    duration_ms: durationMs,
    audit_query_filter: `bulk_job_id:${bulkJobId}`,
    ...(root ? { root } : {}),
  };
  if (detail === 'summary') return summary;

  const failedFiles = await client.bulkIngest.files(bulkJobId, {
    state: 'failed',
    page_size: 1000,
  });

  if (detail === 'errors') {
    return { ...summary, failures: failedFiles.data, first_failure: status.first_failure };
  }
  // full
  const all = await client.bulkIngest.files(bulkJobId, { page_size: 1000 });
  return { ...summary, files: all.data, first_failure: status.first_failure };
}

function summarizeDryRun(
  files: ResolvedFile[],
  skipped: SkippedFile[],
): unknown {
  const totalBytes = files.reduce((s, f) => s + f.size_bytes, 0);
  return {
    matched_count: files.length,
    total_size_bytes: totalBytes,
    skipped: skipped.slice(0, 50),
    skipped_total: skipped.length,
    files: files.slice(0, 50).map((f) => ({
      path: f.abs_path,
      size_bytes: f.size_bytes,
      content_type: f.content_type,
    })),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    }
  });
}
