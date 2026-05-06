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
import { listFailingJobs, retryFailingJob } from './ops.js';

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
  // provider keys
  registerProviderKey,
  listProviderKeys,
  // operations
  listFailingJobs,
  retryFailingJob,
] as ToolDef[];
