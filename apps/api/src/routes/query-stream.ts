// POST /v1/query?stream=sse — Server-Sent Events streaming variant of
// the synchronous /v1/query path (Phase 6.5).
//
// Pipeline mirrors the sync handler up through context assembly. At
// synthesis: open a stream from the provider, encode each token delta
// as an SSE `token` frame, and emit a single `done` frame with the
// audit + citations once the stream completes (or on mid-stream
// failure, with degradation_level='cannot_answer').
//
// Citation validation runs once at end-of-stream — we don't try to
// validate citations as the model writes them; the LLM produces the
// answer-with-inline-citations, and we sanitize the full set at done.

import type { Context } from 'hono';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { getNamespaceBySlug } from '../db/namespaces.js';
import { gateVersion } from '../retrieval/profile-gate.js';
import { runHybridRetrieval } from '../retrieval/hybrid.js';
import { resolveVectorBinding } from '../auth/infra-key-resolver.js';
import { assembleContext } from '../retrieval/context-assembly.js';
import { resolveCorpusProfile } from '../retrieval/profile-resolver.js';
import { maybeRerank } from '../retrieval/rerank.js';
import { hydrateChunksByIds } from '../db/chunks.js';
import { buildMessages } from '../synthesis/prompt-builder.js';
import { validateCitations } from '../synthesis/citation-validator.js';
import { computeDegradation } from '../synthesis/degradation.js';
import { resolve as resolveProvider } from '../providers/registry.js';
import { insertQueryEvent, updateQueryEvent, mirrorAnswer } from '../audit/query-events.js';
import { makeEmbeddingProfile } from '../ingestion/dispatch.js';
import { extractProfileOverrides } from '../query/overrides.js';
import { recordQueryUsage } from '../observability/usage.js';
import { writeMetric } from '../observability/metrics.js';
import {
  resolveVersionIds,
  resolveProviderKeyForQuery,
  resolveRerankProviderKey,
} from '../query/helpers.js';
import { finalizeAudit, finalizeFailure } from '../query/audit-shape.js';
import { encodeSseFrame, SSE_HEADERS } from '../synthesis/streaming.js';

// Body shape (a subset of QueryRequest sufficient for streaming).
export interface StreamingQueryBody {
  namespace: string;
  query: string;
  embedding: {
    provider: string;
    model: string;
    dimensions?: number;
    provider_key_ref?: string;
    provider_key_id?: string;
  };
  inference: {
    provider: string;
    model: string;
    max_output_tokens?: number;
    temperature?: number;
    provider_key_ref?: string;
    provider_key_id?: string;
  };
  chunking: { profile: string };
  retrieval: {
    strategy: string;
    top_k_dense?: number;
    top_k_sparse?: number;
    rerank?: {
      enabled?: boolean;
      provider?: 'voyage' | 'cohere';
      model?: string;
      top_n?: number;
      provider_key_ref?: string;
      provider_key_id?: string;
    };
  };
  prompt?: { system?: string | null; developer?: string | null };
  document_ids?: string[];
}

/** Dispatch the streaming branch when `?stream=sse` is detected by the
 *  sync handler. Returns a Response carrying an SSE body. */
export async function runStreamingQuery(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  body: StreamingQueryBody,
): Promise<Response> {
  const tenantId = c.get('tenant_id')!;
  const start = Date.now();

  // 1. Profile + namespace resolution (same as sync path).
  const profileResolved = await resolveCorpusProfile({
    env: c.env,
    tenant_id: tenantId,
    namespace_slug: body.namespace,
    request_overrides: extractProfileOverrides(body as unknown as Record<string, unknown>),
  });
  const profile = profileResolved.profile;
  const ns = await getNamespaceBySlug(c.env.db, tenantId, body.namespace);
  if (!ns) {
    throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${body.namespace}`);
  }

  const qevId = await insertQueryEvent(c.env, {
    tenant_id: tenantId,
    namespace_id: ns.id,
    query_text: body.query,
    request_config: body as unknown as Record<string, unknown>,
  });

  // 2. Versions + profile gate.
  const versionIds = await resolveVersionIds(c.env, tenantId, ns.id, body.document_ids);
  if (versionIds.length === 0) {
    const audit = await finalizeFailure(
      c.env,
      qevId,
      'cannot_answer',
      'empty',
      'no candidate versions',
    );
    return openErrorStream(qevId, audit, 'No documents available to query.');
  }

  // Honor the namespace-locked embedding dim. See routes/query.ts for
  // the full rationale — short version: chunks were embedded at
  // `ns.embedding_dimensions`, the query embedding must match, and
  // OpenAI's text-embedding-3-large defaults to 3072d when no
  // `dimensions` arg is forwarded.
  const lockedDim = ns.embedding_dimensions;
  if (
    body.embedding.dimensions !== undefined &&
    body.embedding.dimensions !== lockedDim
  ) {
    throw new TextralError(
      'BAD_REQUEST',
      400,
      `embedding.dimensions=${body.embedding.dimensions} does not match the namespace's locked embedding_dimensions=${lockedDim}. ` +
        'Omit `embedding.dimensions` to use the namespace lock automatically.',
    );
  }
  const effectiveDim = lockedDim;
  const embeddingProfile = makeEmbeddingProfile(
    body.embedding.provider,
    body.embedding.model,
    effectiveDim,
  );
  const chunkingProfile = body.chunking.profile;
  for (const vid of versionIds) {
    await gateVersion(c.env, {
      version_id: vid,
      embedding_profile: embeddingProfile,
      chunking_profile: chunkingProfile,
    });
  }

  // 3. Embed query.
  const queryEmbedKey = await resolveProviderKeyForQuery(
    c.env,
    tenantId,
    body.embedding.provider,
    body.embedding.provider_key_id,
    body.embedding.provider_key_ref,
  );
  const embedProvider = resolveProvider(c.env, {
    provider: body.embedding.provider,
    ...(queryEmbedKey ? { api_key: queryEmbedKey.raw_key } : {}),
    request_metadata: {
      tenant_id: tenantId,
      query_event_id: qevId,
      ...(queryEmbedKey ? { provider_key_id: queryEmbedKey.id } : {}),
    },
  });
  if (!embedProvider.embedding) {
    throw new TextralError(
      'PROVIDER_UNSUPPORTED_MODEL',
      400,
      `No embedding provider for ${body.embedding.provider}`,
    );
  }
  const embedRes = await embedProvider.embedding.embed(
    {
      model: body.embedding.model,
      input: [body.query],
      // Always forward the namespace-locked dim — see lockedDim
      // construction above.
      dimensions: effectiveDim,
    },
    embedProvider.options,
  );
  if (embedRes.outcome === 'fatal_error' || embedRes.outcome === 'retryable_error') {
    const audit = await finalizeFailure(
      c.env,
      qevId,
      'cannot_answer',
      'empty',
      embedRes.error.safe_upstream_message ?? embedRes.error.type,
    );
    return openErrorStream(qevId, audit, 'Embedding failed.');
  }
  const queryVector = embedRes.value.vectors[0]!;
  const embeddingInputTokens = embedRes.value.usage.input_tokens;

  // 4. Retrieval. For Pinecone, resolve the tenant's infra key here.
  const retrievalBinding = await resolveVectorBinding(c.env, tenantId, {
    backend: ns.vector_backend,
    index_name: ns.vector_index_name,
    embedding_dimensions: body.embedding.dimensions ?? 1536,
    namespace: ns.vector_namespace,
  });
  const retrieval = await runHybridRetrieval(c.env, {
    query_vector: queryVector,
    query_text: body.query,
    tenant_id: tenantId,
    namespace_id: ns.id,
    version_ids: versionIds,
    artifact_types: profile.retrieval_defaults.artifact_types,
    top_k_dense: body.retrieval.top_k_dense ?? 10,
    top_k_sparse: body.retrieval.top_k_sparse ?? 10,
    rrf_k: 60,
    binding: retrievalBinding,
  });
  if (retrieval.candidates.length === 0) {
    const audit = await finalizeFailure(
      c.env,
      qevId,
      'cannot_answer',
      retrieval.retrieval_status,
      'no candidates returned',
    );
    return openErrorStream(qevId, audit, 'No relevant context found.');
  }

  // 5. Optional rerank (Phase 5).
  const rerankCfg = profile.retrieval_defaults.rerank;
  if (rerankCfg.enabled && (!rerankCfg.provider || !rerankCfg.model)) {
    throw new TextralError(
      'BAD_REQUEST',
      400,
      'rerank.provider and rerank.model are required when rerank.enabled is true',
    );
  }
  const requestRerankKeyId = body.retrieval?.rerank?.provider_key_id;
  let candidatesAfterRerank = retrieval.candidates;
  let rerankAudit: Awaited<ReturnType<typeof maybeRerank>>['audit'];
  if (rerankCfg.enabled && rerankCfg.provider && rerankCfg.model) {
    const candidateIds = retrieval.candidates.map((cc) => cc.chunk_id);
    const rows = await hydrateChunksByIds(c.env.db, tenantId, candidateIds);
    const byId = new Map(rows.map((r) => [r.id, r.text]));
    const inputs = retrieval.candidates
      .map((cc) => ({ chunk_id: cc.chunk_id, text: byId.get(cc.chunk_id) ?? '' }))
      .filter((cc) => cc.text);
    const rerankKey = await resolveRerankProviderKey(
      c.env,
      tenantId,
      rerankCfg.provider,
      rerankCfg.provider_key_ref,
      requestRerankKeyId,
    );
    const rerankProvider = rerankKey
      ? resolveProvider(c.env, {
          provider: rerankCfg.provider,
          api_key: rerankKey.raw_key,
          request_metadata: {
            tenant_id: tenantId,
            query_event_id: qevId,
            provider_key_id: rerankKey.id,
          },
        })
      : null;
    const outcome = await maybeRerank({
      query: body.query,
      candidates: inputs,
      config: {
        enabled: true,
        provider: rerankCfg.provider,
        model: rerankCfg.model,
        top_n: rerankCfg.top_n,
      },
      resolved_provider: rerankProvider,
    });
    rerankAudit = outcome.audit;
    const reorderedSet = new Set(outcome.reordered);
    const reorderedRank = new Map(outcome.reordered.map((id, i) => [id, i]));
    const reordered: typeof retrieval.candidates = [];
    for (const f of retrieval.candidates) {
      if (reorderedSet.has(f.chunk_id)) reordered.push(f);
    }
    reordered.sort(
      (a, b) => (reorderedRank.get(a.chunk_id) ?? 0) - (reorderedRank.get(b.chunk_id) ?? 0),
    );
    candidatesAfterRerank = reordered.length > 0 ? reordered : retrieval.candidates;
  } else {
    rerankAudit = {
      enabled: false,
      executed: false,
      provider: null,
      model: null,
      top_n: null,
    };
  }

  // 6. Context assembly. Same signature as the sync path.
  const ctx = await assembleContext(c.env, {
    fused: candidatesAfterRerank,
    tenant_id: tenantId,
    max_context_tokens: 8000,
    layer_budgets: profile.retrieval_defaults.layer_budgets,
    layer_order: profile.retrieval_defaults.layer_order,
  });

  // 7. Synthesis (streaming).
  const synthKey = await resolveProviderKeyForQuery(
    c.env,
    tenantId,
    body.inference.provider,
    body.inference.provider_key_id,
    body.inference.provider_key_ref,
  );
  const synthProvider = resolveProvider(c.env, {
    provider: body.inference.provider,
    ...(synthKey ? { api_key: synthKey.raw_key } : {}),
    request_metadata: {
      tenant_id: tenantId,
      query_event_id: qevId,
      ...(synthKey ? { provider_key_id: synthKey.id } : {}),
    },
  });
  if (!synthProvider.llm || typeof synthProvider.llm.stream !== 'function') {
    throw new TextralError(
      'PROVIDER_UNSUPPORTED_MODEL',
      400,
      `Provider ${body.inference.provider} does not support streaming`,
    );
  }
  const messages = buildMessages({
    system: body.prompt?.system ?? null,
    developer: body.prompt?.developer ?? null,
    user_query: body.query,
    context_block: ctx.context_block,
  });
  await updateQueryEvent(c.env, qevId, { status: 'synthesis_started' });

  // Open a transform stream + spawn the producer.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const finalizeAndCloseStream = async (): Promise<void> => {
    try {
      const stream = synthProvider.llm!.stream!(
        {
          model: body.inference.model,
          messages,
          ...(body.inference.max_output_tokens
            ? { max_tokens: body.inference.max_output_tokens }
            : {}),
          ...(body.inference.temperature !== undefined
            ? { temperature: body.inference.temperature }
            : {}),
        },
        synthProvider.options,
      );

      let answerText = '';
      let synthInputTokens = 0;
      let synthOutputTokens = 0;
      let streamError: string | null = null;

      for await (const ev of stream) {
        if (ev.type === 'token' && typeof ev.delta === 'string') {
          answerText += ev.delta;
          await writer.write(encodeSseFrame('token', { text: ev.delta }));
        } else if (ev.type === 'usage' && ev.usage) {
          synthInputTokens = ev.usage.input_tokens;
          synthOutputTokens = ev.usage.output_tokens;
        } else if (ev.type === 'error' && ev.error) {
          streamError = ev.error.safe_upstream_message ?? ev.error.type;
          break;
        } else if (ev.type === 'done') {
          break;
        }
      }

      if (streamError) {
        const audit = await finalizeFailure(
          c.env,
          qevId,
          'cannot_answer',
          retrieval.retrieval_status,
          streamError,
          'failed',
        );
        await writer.write(
          encodeSseFrame('done', {
            query_event_id: qevId,
            answer: { mode: 'text', text: 'Synthesis failed.' },
            citations: [],
            degradation_level: 'cannot_answer',
            audit,
          }),
        );
        await writer.close();
        return;
      }

      // 8. Citation validation on the assembled answer.
      const citationResult = validateCitations(answerText, ctx.included);
      const citationIntegrity = citationResult.citation_integrity;
      const droppedCitations = citationResult.dropped_citations;
      const synthesisStatus: 'success' | 'truncated' | 'failed' = 'success';
      const degradation = computeDegradation({
        retrieval_status: retrieval.retrieval_status,
        citation_integrity: citationIntegrity,
        synthesis_status: synthesisStatus,
      });
      const audit = await finalizeAudit(c.env, qevId, {
        retrieval,
        ctx,
        embeddingProfile,
        chunkingProfile,
        provider: body.inference.provider,
        model: body.inference.model,
        providerKeyId: synthKey?.id ?? null,
        retrievalStrategy: body.retrieval.strategy,
        embeddingInputTokens,
        synthInputTokens,
        synthOutputTokens,
        contextTokens: ctx.total_tokens,
        synthesisStatus,
        citationIntegrity,
        droppedCitations,
        citationsReturned: citationResult.valid_citations.length,
        degradation,
        startTs: start,
        rerankerAudit: rerankAudit as RerankerAuditShape,
      });

      // 9. Mirror answer to R2 best-effort.
      const responseShape = {
        query_event_id: qevId,
        answer: { mode: 'text' as const, text: answerText },
        citations: citationResult.valid_citations,
        degradation_level: degradation,
        audit,
      };
      const mirror = await mirrorAnswer(c.env, {
        query_event_id: qevId,
        tenant_id: tenantId,
        namespace_id: ns.id,
        payload: responseShape,
      });
      await updateQueryEvent(c.env, qevId, {
        status: 'completed',
        ...(mirror.ok ? { answer_r2_key: mirror.key ?? null } : { mirror_error: mirror.error ?? null }),
      });

      // Cost rollup + AE — same conditions as sync path.
      if (synthesisStatus === 'success') {
        c.env.bg.spawn(
          recordQueryUsage(c.env, tenantId, {
            input_tokens: embeddingInputTokens + synthInputTokens,
            output_tokens: synthOutputTokens,
          }).catch((e: unknown) => {
            console.error('usage_record_query_stream_failed', { message: (e as Error).message });
          }),
        );
      }
      writeMetric(c.env, 'query_executions', {
        blobs: [ns.id, embeddingProfile, body.retrieval.strategy, degradation, synthesisStatus, 'stream'],
        doubles: [audit.latency_ms, audit.candidates_returned, citationResult.valid_citations.length],
        indexes: [tenantId],
      });

      await writer.write(encodeSseFrame('done', responseShape));
      await writer.close();
    } catch (err) {
      const e = err as Error;
      console.error('query_stream_unhandled_error', {
        request_id: c.get('request_id'),
        message: e.message,
      });
      try {
        const audit = await finalizeFailure(
          c.env,
          qevId,
          'cannot_answer',
          retrieval.retrieval_status,
          e.message,
          'failed',
        );
        await writer.write(
          encodeSseFrame('done', {
            query_event_id: qevId,
            answer: { mode: 'text', text: 'Synthesis failed.' },
            citations: [],
            degradation_level: 'cannot_answer',
            audit,
          }),
        );
      } catch {
        // Already-closed writer or failed audit write — best effort.
      }
      try {
        await writer.close();
      } catch {
        /* already closed */
      }
    }
  };

  // Kick off the producer (fire-and-forget). The producer closes the
  // writer when done, which in turn closes the readable. We don't
  // await — that would block returning the Response object until the
  // entire stream is drained. The Worker runtime keeps the request
  // alive for ReadableStream consumers.
  void finalizeAndCloseStream();

  return new Response(readable, { headers: SSE_HEADERS });
}

// Helper: open a stream with just the failure done-frame (used for
// pre-synthesis failures where there are no tokens to emit).
function openErrorStream(
  qevId: string,
  audit: unknown,
  message: string,
): Response {
  const body = encodeSseFrame('done', {
    query_event_id: qevId,
    answer: { mode: 'text', text: message },
    citations: [],
    degradation_level: 'cannot_answer',
    audit,
  });
  return new Response(body, { headers: SSE_HEADERS });
}

// We import RerankerAudit here as a "shape" tag to keep the cast
// explicit at the audit boundary. The retrieval/rerank module returns a
// structurally-equivalent shape.
type RerankerAuditShape = Parameters<typeof finalizeAudit>[2]['rerankerAudit'];
