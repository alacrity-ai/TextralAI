/**
 * 03-bulk-ingest.ts — Bulk-ingest the cookbook corpus.
 *
 * Demonstrates: bulkIngestOrchestrate(), progress callback,
 * on_existing policy. Re-runs are cheap because of
 * skip_if_unchanged.
 *
 * Env: same as 01-quick-start.ts.
 *
 * Run:
 *     npx tsx 03-bulk-ingest.ts
 *
 * See also:
 *     SDK_COOKBOOK_OUTLINE.md §4
 */

import { TextralClient, bulkIngestOrchestrate } from '@textral/sdk';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const profileName = process.env.TEXTRAL_PROFILE;
const namespace = process.env.TEXTRAL_NAMESPACE ?? 'cookbook';
const providerKeyRef = process.env.TEXTRAL_PROVIDER_KEY_REF ?? 'openai';

const client = profileName
  ? new TextralClient({ profile: profileName })
  : new TextralClient({
      baseUrl: process.env.TEXTRAL_BASE_URL ?? 'https://api.textral.alacrity.ai',
      apiKey: process.env.TEXTRAL_API_KEY ?? '',
    });

const filenames = ['alexandria.md', 'lighthouse.md', 'scholars.md', 'decline.md'];
const files = await Promise.all(
  filenames.map(async (name) => {
    const buf = await readFile(join(__dirname, 'data', name));
    return {
      filename: name,
      bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      size_bytes: buf.byteLength,
      content_type: 'text/markdown',
    };
  }),
);

const result = await bulkIngestOrchestrate(client, {
  namespace,
  config: {
    embedding: {
      provider: 'openai',
      model: 'text-embedding-3-large',
      dimensions: 1536,
      provider_key_ref: providerKeyRef,
    },
    chunking: { profile: 'generic', target_tokens: 600, overlap_tokens: 80 },
    mode: 'full',
  },
  files,
  on_existing: 'skip_if_unchanged',
  auto_finalize: true,
  concurrency: 4,
  onProgress: (snap) => {
    console.log(
      `${snap.state.padEnd(12)} ${snap.counts.succeeded}/${snap.total_files} (${snap.progress_pct}%)`,
    );
  },
});

console.log('---');
console.log(`bulk_job_id: ${result.bulk_job_id}`);
console.log(`final state: ${result.final_status.state}`);
console.log(
  `succeeded: ${result.final_status.counts.succeeded}, ` +
    `skipped: ${result.final_status.counts.skipped}, ` +
    `failed: ${result.final_status.counts.failed}`,
);
