/**
 * 02-ingest-and-query.ts — Full single-file ingest pipeline, then
 * query the freshly-ingested document.
 *
 * Demonstrates: register → upload → finalize → ingest → poll →
 * query. Cleanup pattern via try/finally so a flaky run doesn't
 * leave the namespace populated.
 *
 * Env: same as 01-quick-start.ts.
 *
 * Run:
 *     npx tsx 02-ingest-and-query.ts
 *
 * See also:
 *     SDK_COOKBOOK_OUTLINE.md §3
 */

import { TextralClient } from '@textral/sdk';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const profileName = process.env.TEXTRAL_PROFILE;
const providerKeyRef = process.env.TEXTRAL_PROVIDER_KEY_REF ?? 'openai';

const client = profileName
  ? new TextralClient({ profile: profileName })
  : new TextralClient({
      baseUrl: process.env.TEXTRAL_BASE_URL ?? 'https://api.textral.alacrity.ai',
      apiKey: process.env.TEXTRAL_API_KEY ?? '',
    });

// Use a scratch namespace so we don't pollute the user's data.
const scratchSlug = `cookbook-${Date.now().toString(36)}`;

const ns = await client.namespaces.create({
  slug: scratchSlug,
  vector_backend: 'vectorize',
  embedding_dimensions: 1536,
});

try {
  // 1. Register the document.
  const bytes = await readFile(join(__dirname, 'data', 'alexandria.md'));
  const doc = await client.documents.register(ns.slug, {
    title: 'alexandria.md',
    doc_type: 'narrative',
  });
  console.log(`document: ${doc.id}`);

  // 2. Reserve the upload slot.
  const upload = await client.documents.createUpload(doc.id, {
    content_type: 'text/markdown',
    size_bytes: bytes.byteLength,
  });

  // 3. PUT bytes.
  const putRes = await client.documents.putUploadBytes(
    upload.url,
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    'text/markdown',
  );
  if (!putRes.ok) {
    throw new Error(`PUT failed: ${putRes.status} ${await putRes.text()}`);
  }

  // 4. Finalize (server hashes + dedupes, returns the version_id).
  const fin = await client.documents.finalize(doc.id, upload.upload_id);
  console.log(`version:  ${fin.version_id}`);

  // 5. Kick off ingestion.
  const job = await client.documents.ingest(doc.id, {
    version_id: fin.version_id,
    embedding: {
      provider: 'openai',
      model: 'text-embedding-3-large',
      dimensions: 1536,
      provider_key_ref: providerKeyRef,
    },
    chunking: { profile: 'generic', target_tokens: 600, overlap_tokens: 80 },
    mode: 'full',
  });
  console.log(`job:      ${job.job_id}`);

  // 6. Poll until terminal.
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > 90_000) {
      throw new Error('ingestion did not terminate within 90s');
    }
    const j = await client.ingestionJobs.get(job.job_id);
    if (j.status === 'completed') break;
    if (j.status === 'failed') {
      throw new Error(`ingest failed: ${j.error_code ?? '?'} — ${j.error_message ?? ''}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 7. Query.
  const result = await client.query({
    namespace: ns.slug,
    query: 'What survived the Library of Alexandria?',
    embedding: {
      provider: 'openai',
      model: 'text-embedding-3-large',
      dimensions: 1536,
      provider_key_ref: providerKeyRef,
    },
    inference: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      provider_key_ref: providerKeyRef,
    },
  });
  console.log('---');
  console.log(typeof result.answer === 'string' ? result.answer : JSON.stringify(result.answer, null, 2));
} finally {
  // 8. Tear down the scratch namespace.
  // (No-op if the create failed; soft-delete is idempotent.)
  await client.namespaces
    .get(ns.slug)
    .then(() => fetch(`${process.env.TEXTRAL_BASE_URL ?? 'https://api.textral.alacrity.ai'}/v1/namespaces/${ns.slug}`, {
      method: 'DELETE',
      headers: { 'x-textral-api-key': process.env.TEXTRAL_API_KEY ?? '' },
    }).catch(() => {}))
    .catch(() => {});
}
