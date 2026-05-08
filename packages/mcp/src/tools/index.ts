// Tool registry. Each tool file (Steps 5-9) appends to this list.

import type { ToolDef } from './types.js';
import { createNamespace, listNamespaces, getNamespace } from './namespaces.js';
import {
  ingestFile,
  listDocuments,
  getDocument,
  listChunks,
  getChunk,
} from './documents.js';
import { query, listQueryEvents, getQueryEvent, getQueryResponse } from './query.js';
import { registerProviderKey, listProviderKeys } from './provider-keys.js';
import {
  registerInfraKey,
  listInfraKeys,
  testInfraKey,
  revokeInfraKey,
} from './infra-keys.js';
import { listFailingJobs, retryFailingJob } from './ops.js';
import { listModels } from './models.js';
import {
  ingestLocalPaths,
  getBulkIngestJob,
  cancelBulkIngestJob,
} from './bulk-ingest.js';

export const allTools: ToolDef[] = [
  // namespaces
  createNamespace,
  listNamespaces,
  getNamespace,
  // documents + ingest
  ingestFile,
  listDocuments,
  getDocument,
  listChunks,
  getChunk,
  // query
  query,
  listQueryEvents,
  getQueryEvent,
  getQueryResponse,
  // provider keys (BYOK for embedding/inference/rerank)
  registerProviderKey,
  listProviderKeys,
  // infra keys (tenant-scoped vector-store credentials — Pinecone today)
  registerInfraKey,
  listInfraKeys,
  testInfraKey,
  revokeInfraKey,
  // operations
  listFailingJobs,
  retryFailingJob,
  // bulk ingest (Phase 2 — local FS multi-file)
  ingestLocalPaths,
  getBulkIngestJob,
  cancelBulkIngestJob,
  // meta
  listModels,
] as ToolDef[];
