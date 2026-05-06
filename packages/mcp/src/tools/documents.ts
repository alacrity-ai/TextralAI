// Document & ingest tools — Step 6.
//
// `ingest_file` is the headline. It collapses the four-step REST
// chain (register → upload → finalize → ingest) into one tool call,
// and (optionally) waits for the resulting ingestion job to reach a
// terminal state — emitting MCP progress notifications on each
// stage transition.

import { z } from 'zod';
import {
  EmbeddingConfig,
  ChunkingConfig,
  NamespaceSlug,
} from '@textral/contracts';
import { defineTool } from './types.js';
import { pollJobUntilTerminal } from '../util/polling.js';

// 25 MiB cap mirrors the API's UploadCreate.size_bytes ceiling.
const MAX_BYTES = 25 * 1024 * 1024;

const IngestFileInput = z
  .object({
    namespace: NamespaceSlug,
    bytes: z
      .string()
      .min(1)
      .describe('Base64-encoded file contents. The MCP server never reads from the local filesystem.'),
    content_type: z.string().min(1).default('text/markdown'),
    title: z.string().optional(),
    doc_type: z.string().default('passage'),
    embedding: EmbeddingConfig,
    chunking: ChunkingConfig.default({}),
    mode: z.enum(['full', 'embed_only', 'enrichment_only']).default('full'),
    wait: z.boolean().default(false),
    wait_timeout_ms: z.number().int().positive().max(30 * 60_000).default(300_000),
  });

export const ingestFile = defineTool({
  name: 'ingest_file',
  description:
    'Ingest one file into a namespace: register → upload → finalize → ingest. wait=true polls and emits progress per stage.',
  inputSchemaZod: IngestFileInput,
  handler: async ({ args, client, recordRestCall, progress, signal }) => {
    const bytes = Uint8Array.from(Buffer.from(args.bytes, 'base64'));
    if (bytes.byteLength === 0) {
      throw new Error('decoded bytes is empty');
    }
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error(
        `file is ${bytes.byteLength} bytes; the API caps uploads at ${MAX_BYTES} bytes`,
      );
    }

    await progress({ progress: 0, total: 5, message: 'registering document' });
    recordRestCall();
    const doc = await client.documents.register(args.namespace, {
      ...(args.title ? { title: args.title } : {}),
      doc_type: args.doc_type,
    });

    if (signal.aborted) throw new Error('cancelled');
    await progress({ progress: 1, total: 5, message: 'creating upload' });
    recordRestCall();
    const upload = await client.documents.createUpload(doc.id, {
      content_type: args.content_type,
      size_bytes: bytes.byteLength,
    });

    if (signal.aborted) throw new Error('cancelled');
    await progress({ progress: 2, total: 5, message: 'uploading bytes' });
    recordRestCall();
    const putRes = await client.documents.putUploadBytes(
      upload.url,
      bytes,
      args.content_type,
    );
    if (!putRes.ok) {
      throw new Error(`upload PUT failed with HTTP ${putRes.status}`);
    }

    if (signal.aborted) throw new Error('cancelled');
    await progress({ progress: 3, total: 5, message: 'finalizing upload' });
    recordRestCall();
    const fin = await client.documents.finalize(doc.id, upload.upload_id);

    if (signal.aborted) throw new Error('cancelled');
    await progress({ progress: 4, total: 5, message: 'starting ingestion' });
    recordRestCall();
    const ing = await client.documents.ingest(doc.id, {
      version_id: fin.version_id,
      embedding: args.embedding,
      chunking: args.chunking,
      mode: args.mode,
    });

    if (!args.wait) {
      return {
        document: doc,
        version_id: fin.version_id,
        job_id: ing.job_id,
        status: ing.status,
      };
    }

    const job = await pollJobUntilTerminal(
      { client, progress, signal, recordRestCall },
      { jobId: ing.job_id, timeoutMs: args.wait_timeout_ms },
    );
    return {
      document: doc,
      version_id: fin.version_id,
      job_id: ing.job_id,
      job,
    };
  },
});

export const listDocuments = defineTool({
  name: 'list_documents',
  description: 'List documents in a namespace, paginated.',
  inputSchemaZod: z.object({
    namespace: NamespaceSlug,
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    const q: { limit?: number; cursor?: string } = {};
    if (args.limit !== undefined) q.limit = args.limit;
    if (args.cursor !== undefined) q.cursor = args.cursor;
    return await client.namespaces.listDocuments(args.namespace, q);
  },
});

export const getDocument = defineTool({
  name: 'get_document',
  description: 'Fetch one document by id. 404 if not found.',
  inputSchemaZod: z.object({ id: z.string() }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.documents.get(args.id);
  },
});

export const listChunks = defineTool({
  name: 'list_chunks',
  description: 'List chunks of a document, paginated. Optional artifact_type and version_id filters.',
  inputSchemaZod: z.object({
    document_id: z.string(),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().optional(),
    artifact_type: z.string().optional(),
    version_id: z.string().optional(),
  }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    const q: { limit?: number; cursor?: string; artifact_type?: string; version_id?: string } = {};
    if (args.limit !== undefined) q.limit = args.limit;
    if (args.cursor !== undefined) q.cursor = args.cursor;
    if (args.artifact_type !== undefined) q.artifact_type = args.artifact_type;
    if (args.version_id !== undefined) q.version_id = args.version_id;
    return await client.documents.listChunks(args.document_id, q);
  },
});

export const getChunk = defineTool({
  name: 'get_chunk',
  description: 'Fetch one chunk by id, returning text + metadata. 404 if not found.',
  inputSchemaZod: z.object({ id: z.string() }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.chunks.get(args.id);
  },
});
