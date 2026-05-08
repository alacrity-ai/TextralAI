// Internal Worker endpoints — Container ↔ Worker back-channel.
//
// All routes are HMAC-authenticated (see middleware/internal-auth.ts).
// Every write endpoint re-validates tenant + job ownership against D1
// — the Container is not trusted to self-attribute.

import { Hono } from 'hono';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../../types.js';
import { internalAuth } from '../../middleware/internal-auth.js';
import { resolveVectorBinding } from '../../auth/infra-key-resolver.js';
import { recordIngestionUsage } from '../../observability/usage.js';
import { writeMetric } from '../../observability/metrics.js';
import { claimJob, heartbeatJob, transitionJob, DEFAULT_LEASE_MS } from '../../ingestion/lease.js';
import { getJobByIdAny, rowToJob, type IngestionJobRow } from '../../db/jobs.js';
import {
  getDocumentById,
  getVersionById,
  promoteCurrentVersionId,
} from '../../db/documents.js';
import { getNamespaceByIdAny } from '../../db/namespaces.js';
import {
  countMissingEmbeddingsForVersionIndex,
  deleteChunksByIds,
  insertChunksBatch,
  listEmbeddedChunkIdsForFilter,
} from '../../db/chunks.js';
import {
  listEnrichAttemptsForJob,
  upsertStageAttempt,
} from '../../db/stage-attempts.js';
import {
  getVersionIndexById,
  updateVersionIndexStatuses,
} from '../../db/version-indexes.js';

interface VectorRecord {
  id: string;
  values: number[];
  metadata: {
    tenant_id: string;
    namespace_id: string;
    document_id: string;
    version_id: string;
    version_index_id: string;
    artifact_type: string;
  };
}

export const internalRoute = new Hono<{ Bindings: Env; Variables: Variables }>();
internalRoute.use('*', internalAuth);

// Defensive: Worker uses TextralError for predictable envelopes.
internalRoute.onError((err, c) => {
  if (err instanceof TextralError) {
    return c.json(
      err.toEnvelope(c.get('request_id')),
      err.httpStatus as 400 | 401 | 403 | 404 | 500,
    );
  }
  console.error('internal_unhandled_error', { message: err.message });
  return c.json(
    {
      error: {
        code: 'INTERNAL',
        message: 'Internal error',
        ...(c.get('request_id') ? { request_id: c.get('request_id') } : {}),
      },
    },
    500,
  );
});

async function loadJobOrThrow(env: Env, jobId: string): Promise<IngestionJobRow> {
  const job = await getJobByIdAny(env.db, jobId);
  if (!job) throw new TextralError('NOT_FOUND', 404, 'Ingestion job not found');
  return job;
}

function assertOwnership(job: IngestionJobRow, body: { tenant_id?: string }): void {
  if (body.tenant_id && body.tenant_id !== job.tenant_id) {
    throw new TextralError(
      'INTERNAL_OWNERSHIP_MISMATCH',
      403,
      `Payload tenant_id ${body.tenant_id} does not match job tenant_id ${job.tenant_id}`,
    );
  }
}

// ── GET /internal/jobs/{id} ──────────────────────────────────────────
internalRoute.get('/jobs/:id', async (c) => {
  const job = await loadJobOrThrow(c.env, c.req.param('id'));
  const version = await getVersionById(c.env.db, job.tenant_id, job.version_id);
  const vidx = await getVersionIndexById(c.env.db, job.version_index_id);
  const doc = await getDocumentById(c.env.db, job.tenant_id, job.document_id);
  const nsRow = doc ? await getNamespaceByIdAny(c.env.db, doc.namespace_id) : null;
  return c.json({
    job: rowToJob(job),
    config: JSON.parse(job.config_json) as Record<string, unknown>,
    version: version
      ? {
          id: version.id,
          content_hash: version.content_hash,
          source_r2_key: version.source_r2_key,
          content_type: version.content_type,
          size_bytes: version.size_bytes,
        }
      : null,
    version_index: vidx,
    namespace: nsRow
      ? { id: nsRow.id, slug: nsRow.slug, corpus_profile: nsRow.corpus_profile }
      : null,
  });
});

// ── POST /internal/jobs/{id}/claim ───────────────────────────────────
internalRoute.post('/jobs/:id/claim', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as {
    container_instance_id?: string;
    lease_seconds?: number;
  };
  if (!body.container_instance_id) {
    throw new TextralError('BAD_REQUEST', 400, 'container_instance_id required');
  }
  const leaseMs = (body.lease_seconds ?? DEFAULT_LEASE_MS / 1000) * 1000;
  const result = await claimJob(c.env.db, id, body.container_instance_id, leaseMs);
  if (!result.ok) return c.json({ ok: false, reason: result.reason }, 200);
  return c.json({ ok: true }, 200);
});

// ── POST /internal/jobs/{id}/heartbeat ───────────────────────────────
internalRoute.post('/jobs/:id/heartbeat', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as {
    container_instance_id?: string;
    lease_seconds?: number;
  };
  if (!body.container_instance_id) {
    throw new TextralError('BAD_REQUEST', 400, 'container_instance_id required');
  }
  const leaseMs = (body.lease_seconds ?? DEFAULT_LEASE_MS / 1000) * 1000;
  const ok = await heartbeatJob(c.env.db, id, body.container_instance_id, leaseMs);
  return c.json({ ok }, 200);
});

// ── POST /internal/jobs/{id}/transition ──────────────────────────────
internalRoute.post('/jobs/:id/transition', async (c) => {
  const id = c.req.param('id');
  const job = await loadJobOrThrow(c.env, id);
  const body = (await c.req.json()) as {
    status: 'pending' | 'running' | 'retrying' | 'completed' | 'failed';
    current_stage?: string | null;
    error_code?: string | null;
    error_message?: string | null;
    tenant_id?: string;
  };
  assertOwnership(job, body);
  await transitionJob(c.env.db, id, body);

  // Phase 5: terminal transitions need to roll up enrichment outcomes
  // and decide what status the version_index lands in. enrichment_status
  // lives on version_indexes (per migration 0002), NOT on ingestion_jobs.
  if (body.status === 'completed' || body.status === 'failed') {
    const summary = await summarizeJobOutcome(c.env, job);

    if (body.status === 'completed') {
      // Promote the version to be the document's current version so
      // the query path can resolve it.
      await promoteCurrentVersionId(c.env.db, job.tenant_id, job.document_id, job.version_id);

      // Phase 6.7 cost rollup — bump ingestion_jobs on success only.
      // Per-batch embedding tokens already recorded at /providers/embed.
      c.env.bg.spawn(
        recordIngestionUsage(c.env, job.tenant_id, { embedding_tokens: 0 }).catch(
          (e: unknown) => {
            console.error('usage_record_ingestion_failed', {
              message: (e as Error).message,
            });
          },
        ),
      );
    }

    await updateVersionIndexStatuses(c.env.db, {
      id: job.version_index_id,
      tenant_id: job.tenant_id,
      status: summary.versionIndexStatus,
      enrichment_status: summary.enrichmentStatus,
    });
  }
  return c.json({ ok: true }, 200);
});

interface OutcomeSummary {
  enrichmentStatus: 'none' | 'full' | 'partial' | 'failed';
  versionIndexStatus: 'ready' | 'partial' | 'failed';
}

async function summarizeJobOutcome(env: Env, job: IngestionJobRow): Promise<OutcomeSummary> {
  const enrichAttempts = await listEnrichAttemptsForJob(env.db, job.id);
  const hasMissing =
    (await countMissingEmbeddingsForVersionIndex(env.db, job.version_index_id)) > 0;

  // Required-pass set comes from config_json.profile.enrichment.passes.
  let requiredPassIds = new Set<string>();
  try {
    const cfg = JSON.parse(job.config_json) as {
      profile?: {
        enrichment?: {
          passes?: Array<{ id: string; required?: boolean }>;
        };
      };
    };
    for (const p of cfg.profile?.enrichment?.passes ?? []) {
      if (p.required) requiredPassIds.add(p.id);
    }
  } catch {
    requiredPassIds = new Set();
  }

  // No enrichment attempts → 'none'.
  if (enrichAttempts.length === 0) {
    return {
      enrichmentStatus: 'none',
      versionIndexStatus: hasMissing ? 'partial' : 'ready',
    };
  }

  // Required-fail → 'failed' across the board.
  const requiredFailed = enrichAttempts.some(
    (a) => a.status === 'failed' && requiredPassIds.has(a.stage.slice('enrich.'.length)),
  );
  if (requiredFailed) {
    return { enrichmentStatus: 'failed', versionIndexStatus: 'failed' };
  }

  // Any optional failure / skip / missing → 'partial'.
  const anyImperfect = enrichAttempts.some((a) => a.status === 'failed' || a.status === 'skipped');
  if (anyImperfect || hasMissing) {
    return { enrichmentStatus: 'partial', versionIndexStatus: 'partial' };
  }

  return { enrichmentStatus: 'full', versionIndexStatus: 'ready' };
}

// ── POST /internal/jobs/{id}/stage-attempt ───────────────────────────
internalRoute.post('/jobs/:id/stage-attempt', async (c) => {
  const id = c.req.param('id');
  const job = await loadJobOrThrow(c.env, id);
  // Defense in depth: even if the runner missed the cancellation check
  // at the top of its stage loop, we refuse to record more progress
  // against a cancelled job. The runner's WorkerError handler treats
  // 409s as fatal-for-this-stage; the queue won't re-deliver because
  // status is already terminal.
  if (job.status === 'failed' && job.error_code === 'USER_CANCELLED') {
    throw new TextralError(
      'JOB_CANCELLED',
      409,
      'Cannot record stage progress: job was cancelled by user',
    );
  }
  const body = (await c.req.json()) as {
    stage: string;
    attempt: number;
    status: 'started' | 'completed' | 'failed' | 'skipped';
    started_at: number;
    completed_at?: number | null;
    duration_ms?: number | null;
    metadata?: Record<string, unknown> | null;
    error_code?: string | null;
    error_message?: string | null;
    tenant_id?: string;
  };
  assertOwnership(job, body);
  // Cap metadata at 16 KB JSON. Prevents a Container instance from
  // blowing through D1's row-size limit by stuffing arbitrary blobs
  // into stage-attempt metadata (audit finding #13).
  if (body.metadata) {
    const size = JSON.stringify(body.metadata).length;
    if (size > 16 * 1024) {
      throw new TextralError(
        'BAD_REQUEST',
        400,
        `metadata exceeds 16 KB cap (got ${size} bytes)`,
      );
    }
  }
  await upsertStageAttempt(c.env.db, {
    job_id: id,
    tenant_id: job.tenant_id,
    stage: body.stage,
    attempt: body.attempt,
    status: body.status,
    started_at: body.started_at,
    completed_at: body.completed_at ?? null,
    duration_ms: body.duration_ms ?? null,
    metadata: body.metadata ?? null,
    error_code: body.error_code ?? null,
    error_message: body.error_message ?? null,
  });

  // Phase 6.3 — Analytics Engine point per stage-attempt commit.
  // Only terminal states (completed | failed | skipped); 'started' is
  // a marker and would double-count.
  if (body.status !== 'started') {
    writeMetric(c.env, 'ingestion_stage_outcomes', {
      blobs: [body.stage, body.status, body.error_code ?? ''],
      doubles: [body.duration_ms ?? 0],
      indexes: [job.tenant_id],
    });
  }
  return c.json({ ok: true }, 200);
});

// ── POST /internal/r2/object ─────────────────────────────────────────
// Worker-proxied R2 read. The presigned-URL path was removed in the
// post-Phase-5 cleanup (audit §6); this is the only fetch path. The
// Container POSTs `{job_id, key}` and gets the bytes back over the
// HMAC-signed back-channel. Ownership check confirms the key prefix
// matches the job's tenant_id.
internalRoute.post('/r2/object', async (c) => {
  const body = (await c.req.json()) as { job_id: string; key: string };
  const job = await loadJobOrThrow(c.env, body.job_id);
  if (!body.key.startsWith(`${job.tenant_id}/`)) {
    throw new TextralError(
      'INTERNAL_OWNERSHIP_MISMATCH',
      403,
      'Read key not under job tenant_id prefix',
    );
  }
  const obj = await c.env.blobs.get(body.key);
  if (!obj) {
    throw new TextralError('UPLOAD_INTENT_NOT_FOUND', 404, `R2 object not found: ${body.key}`);
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': obj.contentType ?? 'application/octet-stream',
      ...(obj.size !== undefined ? { 'content-length': String(obj.size) } : {}),
    },
  });
});

// ── POST /internal/chunks/batch ──────────────────────────────────────
internalRoute.post('/chunks/batch', async (c) => {
  const body = (await c.req.json()) as {
    job_id: string;
    chunks: Array<{
      id: string;
      tenant_id: string;
      namespace_id: string;
      document_id: string;
      version_id: string;
      version_index_id: string;
      artifact_type: string;
      section_path: string | null;
      ord: number;
      text: string;
      metadata?: Record<string, unknown> | null;
      embedding_profile: string;
      chunking_profile: string;
      embedding_status: 'pending' | 'embedded' | 'missing';
      embedding_input_hash?: string | null;
      embedding_provider_request_id?: string | null;
      embedding_dimensions?: number | null;
      parent_chunk_id?: string | null;
      enrichment_pass_id?: string | null;
    }>;
  };
  const job = await loadJobOrThrow(c.env, body.job_id);
  // Per-chunk ownership check.
  for (const ch of body.chunks) {
    if (
      ch.tenant_id !== job.tenant_id ||
      ch.document_id !== job.document_id ||
      ch.version_id !== job.version_id ||
      ch.version_index_id !== job.version_index_id
    ) {
      throw new TextralError(
        'INTERNAL_OWNERSHIP_MISMATCH',
        403,
        `Chunk ${ch.id} ownership does not match job`,
      );
    }
  }
  const result = await insertChunksBatch(
    c.env.db,
    body.chunks.map((ch) => ({
      id: ch.id,
      tenant_id: ch.tenant_id,
      namespace_id: ch.namespace_id,
      document_id: ch.document_id,
      version_id: ch.version_id,
      version_index_id: ch.version_index_id,
      artifact_type: ch.artifact_type,
      section_path: ch.section_path,
      ord: ch.ord,
      text: ch.text,
      metadata: ch.metadata ?? null,
      embedding_profile: ch.embedding_profile,
      chunking_profile: ch.chunking_profile,
      embedding_status: ch.embedding_status,
      embedding_input_hash: ch.embedding_input_hash ?? null,
      embedding_provider_request_id: ch.embedding_provider_request_id ?? null,
      embedding_dimensions: ch.embedding_dimensions ?? null,
      parent_chunk_id: ch.parent_chunk_id ?? null,
      enrichment_pass_id: ch.enrichment_pass_id ?? null,
    })),
  );
  return c.json({ ok: true, inserted: result.inserted }, 200);
});

// ── POST /internal/vectorize/upsert ──────────────────────────────────
internalRoute.post('/vectorize/upsert', async (c) => {
  const body = (await c.req.json()) as { job_id: string; vectors: VectorRecord[] };
  const job = await loadJobOrThrow(c.env, body.job_id);
  for (const v of body.vectors) {
    if (
      v.metadata.tenant_id !== job.tenant_id ||
      v.metadata.document_id !== job.document_id ||
      v.metadata.version_id !== job.version_id ||
      v.metadata.version_index_id !== job.version_index_id
    ) {
      throw new TextralError(
        'INTERNAL_OWNERSHIP_MISMATCH',
        403,
        `Vector ${v.id} metadata does not match job`,
      );
    }
  }
  if (body.vectors.length === 0) {
    return c.json({ ok: true, mutation_id: null }, 200);
  }
  // Resolve the right index from the job's version_index. Today only
  // the OpenAI-1536 profile is registered; future profiles add cases
  // in the runtime's vector-store factory.
  const vidx = await getVersionIndexById(c.env.db, job.version_index_id);
  if (!vidx) {
    throw new TextralError('INTERNAL', 500, 'version_index vanished mid-upsert');
  }
  // V3 Phase 1 — read the backend choice from the version_index row
  // (denormalized from the namespace at vidx-create time). For
  // Pinecone we resolve the tenant's infra key here.
  const binding = await resolveVectorBinding(c.env, job.tenant_id, {
    backend: vidx.vector_backend,
    index_name: vidx.vector_index_name,
    embedding_dimensions: vidx.embedding_dimensions,
    namespace: vidx.vector_namespace,
  });
  const store = c.env.vectors.forBinding(binding);
  try {
    const { mutation_id } = await store.upsert(body.vectors);
    return c.json({ ok: true, mutation_id }, 200);
  } catch (e) {
    const sample = body.vectors[0];
    console.error('vectorize_upsert_failed', {
      backend: vidx.vector_backend,
      index_name: vidx.vector_index_name,
      embedding_dimensions: vidx.embedding_dimensions,
      vector_count: body.vectors.length,
      sample_id: sample?.id,
      sample_values_len: sample?.values?.length,
      sample_metadata: sample?.metadata,
      error_message: (e as Error).message,
      error_name: (e as Error).name,
      error_stack: (e as Error).stack?.split('\n').slice(0, 3).join(' | '),
    });
    throw new TextralError(
      'INTERNAL',
      500,
      `Vectorize upsert failed: ${(e as Error).message}`,
      { vector_count: body.vectors.length, dimensions: vidx.embedding_dimensions },
    );
  }
});

// ── POST /internal/vectorize/delete-by-filter ────────────────────────
internalRoute.post('/vectorize/delete-by-filter', async (c) => {
  const body = (await c.req.json()) as {
    job_id: string;
    document_id: string;
    version_id: string;
    embedding_profile: string;
    chunking_profile: string;
  };
  const job = await loadJobOrThrow(c.env, body.job_id);
  if (body.document_id !== job.document_id || body.version_id !== job.version_id) {
    throw new TextralError(
      'INTERNAL_OWNERSHIP_MISMATCH',
      403,
      'delete-by-filter target mismatches job',
    );
  }
  // Vectorize delete-by-filter isn't always available; approximate by
  // listing chunk ids from D1 and deleting by id. For Phase 3+5 this
  // is adequate (writes happen exclusively through these endpoints).
  const ids = await listEmbeddedChunkIdsForFilter(c.env.db, {
    document_id: body.document_id,
    version_id: body.version_id,
    embedding_profile: body.embedding_profile,
    chunking_profile: body.chunking_profile,
  });
  if (ids.length === 0) return c.json({ ok: true, deleted: 0 }, 200);
  // V3 Phase 1 — load the version_index to learn the backend choice.
  const vidx = await getVersionIndexById(c.env.db, job.version_index_id);
  if (!vidx) {
    throw new TextralError('INTERNAL', 500, 'version_index vanished mid-delete');
  }
  const binding = await resolveVectorBinding(c.env, job.tenant_id, {
    backend: vidx.vector_backend,
    index_name: vidx.vector_index_name,
    embedding_dimensions: vidx.embedding_dimensions,
    namespace: vidx.vector_namespace,
  });
  const store = c.env.vectors.forBinding(binding);
  await store.deleteByIds(ids);
  await deleteChunksByIds(c.env.db, ids);
  return c.json({ ok: true, deleted: ids.length, mutation_id: null }, 200);
});
