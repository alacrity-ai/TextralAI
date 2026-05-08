// OpenAPI components — named, decorated wrappers around the contracts
// schemas. Every public schema appears under `components.schemas` with
// a stable name. Routes import from here, never call `.openapi('Name')`
// inline, so we don't get duplicate or shadowed registrations.

import {
  ErrorEnvelope as ErrorEnvelopeRaw,
  Namespace as NamespaceRaw,
  NamespaceCreate as NamespaceCreateRaw,
  NamespaceUpdate as NamespaceUpdateRaw,
  NamespaceSlug as NamespaceSlugRaw,
  ProviderKey as ProviderKeyRaw,
  ProviderKeyCreate as ProviderKeyCreateRaw,
  InfraKey as InfraKeyRaw,
  InfraKeyCreate as InfraKeyCreateRaw,
  Document as DocumentRaw,
  DocumentCreate as DocumentCreateRaw,
  UploadCreate as UploadCreateRaw,
  UploadResponse as UploadResponseRaw,
  FinalizeResponse as FinalizeResponseRaw,
  IngestRequest as IngestRequestRaw,
  IngestionJob as IngestionJobRaw,
  StageAttempt as StageAttemptRaw,
  Chunk as ChunkRaw,
  RegisterRequest as RegisterRequestRaw,
  RecoverRequest as RecoverRequestRaw,
  RedeemRequest as RedeemRequestRaw,
  AuthOkResponse as AuthOkResponseRaw,
  RedeemResponse as RedeemResponseRaw,
  BulkSubmitRequest as BulkSubmitRequestRaw,
  BulkSubmitResponse as BulkSubmitResponseRaw,
  BulkJobStatus as BulkJobStatusRaw,
  BulkJobFile as BulkJobFileRaw,
  BulkJobFileListResponse as BulkJobFileListResponseRaw,
  BulkJobListResponse as BulkJobListResponseRaw,
  BulkJobOk as BulkJobOkRaw,
} from '@textral/contracts';
import { z } from './z.js';

export const ErrorEnvelopeSchema = ErrorEnvelopeRaw.openapi('ErrorEnvelope');
export const NamespaceSchema = NamespaceRaw.openapi('Namespace');
export const NamespaceCreateSchema = NamespaceCreateRaw.openapi('NamespaceCreate');
export const NamespaceUpdateSchema = NamespaceUpdateRaw.openapi('NamespaceUpdate');
export const ProviderKeySchema = ProviderKeyRaw.openapi('ProviderKey');
export const ProviderKeyCreateSchema = ProviderKeyCreateRaw.openapi('ProviderKeyCreate');
export const InfraKeySchema = InfraKeyRaw.openapi('InfraKey');
export const InfraKeyCreateSchema = InfraKeyCreateRaw.openapi('InfraKeyCreate');

// ── Bulk ingest ────────────────────────────────────────────────────────
export const BulkSubmitRequestSchema = BulkSubmitRequestRaw.openapi('BulkSubmitRequest');
export const BulkSubmitResponseSchema = BulkSubmitResponseRaw.openapi('BulkSubmitResponse');
export const BulkJobStatusSchema = BulkJobStatusRaw.openapi('BulkJobStatus');
export const BulkJobFileSchema = BulkJobFileRaw.openapi('BulkJobFile');
export const BulkJobFileListResponseSchema = BulkJobFileListResponseRaw.openapi('BulkJobFileListResponse');
export const BulkJobListResponseSchema = BulkJobListResponseRaw.openapi('BulkJobListResponse');
export const BulkJobOkSchema = BulkJobOkRaw.openapi('BulkJobOk');

export const BulkJobIdParam = z.object({
  id: z.string().openapi({
    param: { name: 'id', in: 'path' },
    example: 'bjk_01HZQ...',
  }),
});

export const BulkUploadParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
  ordinal: z.coerce.number().int().openapi({
    param: { name: 'ordinal', in: 'path' },
    example: 0,
  }),
});

// Path parameter shapes. `.openapi({ param: ... })` is how
// @hono/zod-openapi tags param descriptions / examples.
export const NamespaceSlugParam = z.object({
  slug: NamespaceSlugRaw.openapi({
    param: { name: 'slug', in: 'path' },
    example: 'leases',
  }),
});

export const IdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'pkey_01HXY...' }),
});

// ── Inline shapes that don't yet live in @textral/contracts ──────────

export const HealthResponse = z
  .object({
    status: z.literal('ok'),
    env: z.enum(['dev', 'prod', 'self-host']),
    ts: z.number().int(),
  })
  .openapi('HealthResponse');

export const MeResponse = z
  .object({
    tenant: z.object({
      id: z.string(),
      display_name: z.string(),
      plan: z.string(),
      created_at: z.number().int(),
    }),
    api_key_id: z.string(),
    /** Runtime the API is running on. `cf` = Cloudflare Workers,
     *  `node` = self-host Node. MCP V2 reads this at profile-load
     *  time to gate any tools that have CF-runtime limitations. */
    runtime: z.enum(['cf', 'node']),
  })
  .openapi('MeResponse');

export const ApiKeyMetadata = z
  .object({
    id: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    created_at: z.number().int(),
    last_used_at: z.number().int().nullable(),
    revoked_at: z.number().int().nullable(),
  })
  .openapi('ApiKeyMetadata');

export const ApiKeyCreateRequest = z
  .object({
    scopes: z.array(z.string()).default(['*']),
  })
  .openapi('ApiKeyCreateRequest');

export const ApiKeyCreateResponse = z
  .object({
    id: z.string(),
    raw: z.string().describe('Returned exactly once on creation; never persisted in cleartext.'),
    prefix: z.string(),
    scopes: z.array(z.string()),
    created_at: z.number().int(),
  })
  .openapi('ApiKeyCreateResponse');

export const ProviderKeyTestResponse = z
  .object({
    ok: z.boolean(),
    error_code: z.string().optional(),
    error_message: z.string().optional(),
  })
  .openapi('ProviderKeyTestResponse');

// ── Phase B — self-service tenant registration ──────────────────────

export const RegisterRequestSchema = RegisterRequestRaw.openapi('RegisterRequest');
export const RecoverRequestSchema = RecoverRequestRaw.openapi('RecoverRequest');
export const RedeemRequestSchema = RedeemRequestRaw.openapi('RedeemRequest');
export const AuthOkResponseSchema = AuthOkResponseRaw.openapi('AuthOkResponse');
export const RedeemResponseSchema = RedeemResponseRaw.openapi('RedeemResponse');

export const BootstrapRequest = z
  .object({
    tenant_display_name: z.string().min(1).max(120),
    namespace_slug: NamespaceSlugRaw,
    namespace_corpus_profile: z.string().default('generic'),
    namespace_default_embedding_profile: z.string().default('openai-text-embedding-3-large'),
    /** Optional override for the bootstrapped namespace's vector
     *  backend. Unset → runtime default ('vectorize' on Cloudflare,
     *  'qdrant' on self-host). Self-host deploys reject 'vectorize'. */
    namespace_vector_backend: z.enum(['vectorize', 'qdrant', 'pinecone']).optional(),
    /** Required when `namespace_vector_backend` is 'qdrant' (collection
     *  name) or 'pinecone' (full host URL). */
    namespace_vector_index_name: z.string().min(1).optional(),
    api_key_scopes: z.array(z.string()).default(['*']),
  })
  .openapi('BootstrapRequest');

export const BootstrapResponse = z
  .object({
    tenant: z.object({ id: z.string(), display_name: z.string() }),
    namespace: NamespaceSchema,
    api_key: z.object({ id: z.string(), raw: z.string(), prefix: z.string() }),
  })
  .openapi('BootstrapResponse');

export const NamespaceList = z.object({ data: z.array(NamespaceSchema) }).openapi('NamespaceList');

export const ApiKeyList = z.object({ data: z.array(ApiKeyMetadata) }).openapi('ApiKeyList');

export const ProviderKeyList = z
  .object({ data: z.array(ProviderKeySchema) })
  .openapi('ProviderKeyList');

export const InfraKeyList = z
  .object({ data: z.array(InfraKeySchema) })
  .openapi('InfraKeyList');

export const InfraKeyTestResponse = z
  .object({
    ok: z.boolean(),
    error_code: z.string().optional(),
    error_message: z.string().optional(),
  })
  .openapi('InfraKeyTestResponse');

// ── Phase 3 ingestion shapes ─────────────────────────────────────────

export const DocumentSchema = DocumentRaw.openapi('Document');
export const DocumentCreateSchema = DocumentCreateRaw.openapi('DocumentCreate');
export const UploadCreateSchema = UploadCreateRaw.openapi('UploadCreate');
export const UploadResponseSchema = UploadResponseRaw.openapi('UploadResponse');
export const FinalizeResponseSchema = FinalizeResponseRaw.openapi('FinalizeResponse');
export const IngestRequestSchema = IngestRequestRaw.openapi('IngestRequest');
export const IngestionJobSchema = IngestionJobRaw.openapi('IngestionJob');
export const StageAttemptSchema = StageAttemptRaw.openapi('StageAttempt');

export const ChunkSchema = ChunkRaw.openapi('Chunk');

export const IngestionJobCreateResponse = z
  .object({
    job_id: z.string(),
    status: z.string(),
    version_index_id: z.string(),
  })
  .openapi('IngestionJobCreateResponse');

export const StageAttemptList = z
  .object({ data: z.array(StageAttemptSchema) })
  .openapi('StageAttemptList');

export const IngestionJobList = z
  .object({ data: z.array(IngestionJobSchema) })
  .openapi('IngestionJobList');

export const NamespaceSlugAndIdParam = z.object({
  slug: NamespaceSlugRaw.openapi({
    param: { name: 'slug', in: 'path' },
    example: 'leases',
  }),
});

export const DocumentIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'doc_01HX...' }),
});

export const UploadIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'doc_01HX...' }),
  upload_id: z.string().openapi({ param: { name: 'upload_id', in: 'path' } }),
});

export const JobIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'job_01HX...' }),
});
