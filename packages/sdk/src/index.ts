export {
  TextralClient,
  type TextralClientOptions,
  type RequestOptions,
  type QueryStreamFrame,
  type MeResponse,
  type DocumentListResponse,
  type ChunkListResponse,
  type QueryEventListResponse,
  type FailingJobsResponse,
  type ProviderKeyTestResponse,
  type IngestionJobCreateResponse,
} from './client.js';
export {
  TextralError,
  TextralApiError,
  TextralRetryExhausted,
  TextralStreamInterrupted,
} from './errors.js';
export {
  DEFAULT_RETRY,
  NO_RETRY,
  parseRetryAfter,
  type RetryPolicy,
  type RetryInfo,
} from './retry.js';
export {
  paginate,
  type Page,
  type PaginateOptions,
} from './paginate.js';
export {
  streamSse,
  type SseFrame,
  type StreamSseOptions,
} from './stream.js';
// Re-export profile resolver for ergonomics — callers can import
// `loadProfile` straight from the SDK without adding a separate
// dep on @textral/profiles.
export {
  resolveProfile,
  resolveActiveProfile,
  loadProfileFile,
  configDir,
  configPath,
  TextralProfileNotFound,
  type Profile,
  type ProfileFile,
  type ResolvedActiveProfile,
  type ResolveProfileInput,
} from '@textral/profiles';
export {
  bulkIngestOrchestrate,
  pollBulkJob,
  type BulkOrchestrateInput,
  type BulkOrchestrateFile,
  type BulkOrchestrateResult,
} from './bulk-orchestrator.js';
