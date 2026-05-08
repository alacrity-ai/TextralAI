// Ingestion dispatch.
//
// 1. Resolve version (explicit or current).
// 2. Resolve `provider_key_ref` (label) → `provider_key_id` (pkey_*).
// 3. Find-or-create the version_index for (chunking_profile, embedding_profile).
// 4. INSERT ingestion_jobs with config_json containing the resolved key id.
// 5. Send queue message: { job_id, tenant_id, attempt: 0 }.

import { TextralError, newId, type IngestRequest } from '@textral/contracts';
import { getProfileOrThrow, mergeProfile } from '@textral/corpus-profiles';
import type { Env } from '../types.js';
import { getDocumentById, findVersionIndex, getVersionById } from '../db/documents.js';
import { findActiveJobForVersionIndex, insertIngestionJob } from '../db/jobs.js';
import { getNamespaceById, getNamespaceBySlug } from '../db/namespaces.js';
import { resolveProviderKey as resolveUnifiedProviderKey } from '../auth/provider-key-resolver.js';
import { insertVersionIndex } from '../db/version-indexes.js';

export interface DispatchResult {
  job_id: string;
  status: string;
  version_index_id: string;
}

export async function dispatchIngestion(
  env: Env,
  tenantId: string,
  documentId: string,
  body: IngestRequest,
): Promise<DispatchResult> {
  const doc = await getDocumentById(env.db, tenantId, documentId);
  if (!doc) throw new TextralError('DOCUMENT_NOT_FOUND', 404, 'Document not found');

  // 1. Resolve version.
  const versionId = body.version_id ?? doc.current_version_id;
  if (!versionId) {
    throw new TextralError(
      'DOCUMENT_VERSION_NOT_FOUND',
      400,
      'No version_id supplied and document has no current_version_id (upload + finalize first)',
    );
  }
  const version = await getVersionById(env.db, tenantId, versionId);
  if (!version) {
    throw new TextralError('DOCUMENT_VERSION_NOT_FOUND', 404, 'Version not found');
  }

  // 2. Resolve provider_key_ref → provider_key_id.
  const resolvedKeyId = await resolveProviderKey(env, tenantId, body);

  // Resolve embedding profile dimensions: the contract requires explicit
  // `dimensions` for OpenAI text-embedding-3-large (Vectorize V2 cap at 1536).
  const embedding = {
    provider: body.embedding.provider,
    model: body.embedding.model,
    dimensions: resolveDimensions(body.embedding.model, body.embedding.dimensions),
    provider_key_id: resolvedKeyId,
  };

  // 3. Determine corpus_profile from the namespace (Phase 5 will
  // override based on profile bundles; Phase 3 takes the namespace
  // default verbatim).
  const ns = await getNamespaceById(env.db, tenantId, doc.namespace_id);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, 'Namespace not found');

  // Hard-lock: the namespace's `embedding_dimensions` was set at create
  // time and reflects the backing store's actual constraint (Vectorize
  // index size, Qdrant `vectors.size`, Pinecone index dim). Embedding
  // at any other dim would silently produce a partial ingest (chunks
  // marked `missing`) or fail downstream at the vector-store layer
  // with a confusing 4xx. Reject up front.
  if (embedding.dimensions !== ns.embedding_dimensions) {
    throw new TextralError(
      'NAMESPACE_DIMENSION_MISMATCH',
      400,
      `Namespace "${ns.slug}" is locked to ${ns.embedding_dimensions}-dim vectors. ` +
        `Requested ${embedding.dimensions}-dim. Embed with a profile that produces ` +
        `${ns.embedding_dimensions}-dim vectors, or create a new namespace.`,
      {
        namespace_dimensions: ns.embedding_dimensions,
        requested_dimensions: embedding.dimensions,
        namespace_slug: ns.slug,
      },
    );
  }

  const embeddingProfile = makeEmbeddingProfile(
    embedding.provider,
    embedding.model,
    embedding.dimensions,
  );

  // 4. Find-or-create version_index.
  let vidx = await findVersionIndex(env.db, versionId, body.chunking.profile, embeddingProfile);
  if (vidx) {
    if (vidx.status === 'ready' && !body.force_rebuild) {
      throw new TextralError(
        'INDEX_ALREADY_BUILT',
        409,
        'A ready version_index already exists for this (version, chunking, embedding) combo. Pass force_rebuild=true to re-run.',
        { version_index_id: vidx.id, status: vidx.status },
      );
    }
    // pending / partial / failed → reuse the row, kick off a fresh job.
  } else {
    const vidxId = newId('vidx');
    await insertVersionIndex(env.db, {
      id: vidxId,
      version_id: versionId,
      tenant_id: tenantId,
      chunking_profile: body.chunking.profile,
      chunking_target_tokens: body.chunking.target_tokens,
      chunking_overlap_tokens: body.chunking.overlap_tokens,
      embedding_profile: embeddingProfile,
      embedding_provider: embedding.provider,
      embedding_model: embedding.model,
      embedding_dimensions: embedding.dimensions,
      distance_metric: 'cosine',
      corpus_profile: ns.corpus_profile,
      enrichment_config: JSON.stringify(body.enrichment),
      // V3 Phase 1 — denormalize the namespace's vector backend
      // choice onto the version_index so the ingest hot path
      // (upsert / delete-by-filter) doesn't need a namespace
      // lookup per call. Fix Plan 08 added vector_namespace to the
      // denormalization set (Pinecone native namespace).
      vector_backend: ns.vector_backend,
      vector_index_name: ns.vector_index_name,
      vector_namespace: ns.vector_namespace,
    });
    vidx = await findVersionIndex(env.db, versionId, body.chunking.profile, embeddingProfile);
    if (!vidx) {
      throw new TextralError('INTERNAL', 500, 'version_index insert vanished');
    }
  }

  // Active-job conflict.
  const active = await findActiveJobForVersionIndex(env.db, vidx.id);
  if (active) {
    throw new TextralError(
      'INGESTION_IN_PROGRESS',
      409,
      'An ingestion job is already running for this version_index',
      { active_job_id: active.id },
    );
  }

  // 5. Resolve and persist the merged corpus profile (Phase 5). The
  //    merged shape is what the Container reads; replays use the
  //    persisted view, not whatever the YAMLs say at replay time.
  const baseProfile = getProfileOrThrow(ns.corpus_profile);
  // The request's `enrichment` block carries per-pass enable/required/model
  // overrides keyed by `name`; that shape doesn't structurally match
  // CorpusProfile.enrichment.passes (which has `id`, `scope`,
  // `produces`, …). For dispatch we only merge chunking overrides
  // here — per-pass model overrides flow into the runner via
  // request_pass_overrides at run time (see job_runner.py 5.6.3).
  const mergedProfile = mergeProfile(baseProfile, {
    chunking: body.chunking
      ? {
          profile: body.chunking.profile as 'generic' | 'code_aware' | 'legal_clause_aware',
          target_tokens: body.chunking.target_tokens,
          overlap_tokens: body.chunking.overlap_tokens,
        }
      : undefined,
  });

  // 6. INSERT ingestion_jobs.
  const jobId = newId('job');
  const configWithResolvedKey = {
    ...body,
    embedding,
    chunking: body.chunking,
    enrichment: body.enrichment,
    indexing: body.indexing,
    mode: body.mode,
    corpus_profile: ns.corpus_profile,
    /** Phase 5: merged profile so the Container has the full
     *  resolved shape without re-resolving. Replay-stable. */
    profile: mergedProfile,
  };
  await insertIngestionJob(env.db, {
    id: jobId,
    tenant_id: tenantId,
    document_id: documentId,
    version_id: versionId,
    version_index_id: vidx.id,
    mode: body.mode,
    config_json: JSON.stringify(configWithResolvedKey),
  });

  // 6. Send queue message.
  await env.queue.send({ job_id: jobId, tenant_id: tenantId, attempt: 0 });

  return { job_id: jobId, status: 'pending', version_index_id: vidx.id };
}

async function resolveProviderKey(
  env: Env,
  tenantId: string,
  body: IngestRequest,
): Promise<string> {
  const r = await resolveUnifiedProviderKey(env, tenantId, {
    kind: 'either',
    provider: body.embedding.provider,
    id: body.embedding.provider_key_id,
    ref: body.embedding.provider_key_ref,
  });
  if (!r) {
    throw new TextralError(
      'BAD_REQUEST',
      400,
      'embedding.provider_key_ref or provider_key_id is required for non-workers_ai providers',
    );
  }
  return r.id;
}

function resolveDimensions(model: string, requested?: number): number {
  if (requested !== undefined) return requested;
  // Defaults — text-embedding-3-large gets the Vectorize V2-compatible
  // 1536-dim variant; everything else falls through to provider defaults.
  switch (model) {
    case 'text-embedding-3-large':
      return 1536;
    case 'text-embedding-3-small':
      return 1536;
    case '@cf/baai/bge-large-en-v1.5':
      return 1024;
    case '@cf/baai/bge-base-en-v1.5':
      return 768;
    default:
      // Unknown model with no explicit dimensions → reject.
      throw new TextralError(
        'PROVIDER_UNSUPPORTED_MODEL',
        400,
        `embedding.dimensions must be specified for model: ${model}`,
      );
  }
}

function makeEmbeddingProfile(provider: string, model: string, dim: number): string {
  // Profile name encodes everything that affects compatibility.
  const cleanModel = model.replace(/^@/, '').replace(/[^a-zA-Z0-9]/g, '-');
  return `${provider}-${cleanModel}-${dim}`;
}

export { resolveDimensions, makeEmbeddingProfile, getNamespaceBySlug };
