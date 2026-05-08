// POST /v1/query — end-to-end query path.
//
// Pipeline:
//   1. Insert-early query_events row (received).
//   2. Resolve namespace + version_ids + provider key.
//   3. Profile compatibility gate (embedding + chunking).
//   4. Embed query (Phase 2 provider).
//   5. Hybrid retrieval (Promise.allSettled).
//   6. Context assembly (hydrate, re-sort by fused rank, token budget).
//   7. Synthesis with mandatory developer suffix.
//   8. Citation validation (text mode) / Ajv (structured).
//   9. Update query_events with audit + R2 mirror best-effort.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  TextralError,
  QueryRequest as QueryRequestSchema,
  QueryResponse as QueryResponseSchema,
  type RerankerAudit,
} from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { Responses } from '../openapi/registry.js';
import { z } from '../openapi/z.js';
import { getNamespaceBySlug } from '../db/namespaces.js';
import { gateVersion } from '../retrieval/profile-gate.js';
import { runHybridRetrieval } from '../retrieval/hybrid.js';
import { resolveVectorBinding } from '../auth/infra-key-resolver.js';
import { assembleContext } from '../retrieval/context-assembly.js';
import { resolveCorpusProfile } from '../retrieval/profile-resolver.js';
import { maybeRerank } from '../retrieval/rerank.js';
import { hydrateChunksByIds } from '../db/chunks.js';
import { buildMessages } from '../synthesis/prompt-builder.js';
import { validateCitations, filterStructuredCitations } from '../synthesis/citation-validator.js';
import { computeDegradation } from '../synthesis/degradation.js';
import { validateAgainstSchema, tryParseJson } from '../synthesis/structured-output.js';
import { resolve as resolveProvider } from '../providers/registry.js';
import { insertQueryEvent, updateQueryEvent, mirrorAnswer } from '../audit/query-events.js';
import { makeEmbeddingProfile } from '../ingestion/dispatch.js';
import { extractProfileOverrides } from '../query/overrides.js';
import { recordQueryUsage } from '../observability/usage.js';
import { writeMetric } from '../observability/metrics.js';
import { runStreamingQuery, type StreamingQueryBody } from './query-stream.js';
import {
  resolveVersionIds,
  resolveProviderKeyForQuery,
  resolveRerankProviderKey,
} from '../query/helpers.js';
import {
  finalizeAudit,
  finalizeFailure,
  emptyResponse as emptyResponseShape,
} from '../query/audit-shape.js';

export const queryRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const QueryRequestComponent = QueryRequestSchema.openapi('QueryRequest');
const QueryResponseComponent = QueryResponseSchema.openapi('QueryResponse');
void z;

const queryEndpoint = createRoute({
  method: 'post',
  path: '/',
  tags: ['Query'],
  summary: 'Run a query',
  description:
    'End-to-end retrieval + synthesis against a namespace. Returns a citation-grounded answer plus a full `audit` object (retrieval status, candidate counts, embedding/synthesis tokens, latency).\n\n' +
    '**Streaming.** Append `?stream=sse` to receive Server-Sent Events. Two event types: `token` (per-delta) and `done` (single final event with the same audit + citations + degradation_level the sync response carries).\n\n' +
    '**Structured output.** Set `output.mode="structured"` with a JSON schema to receive a parsed object that matches the schema. Citations come back as a separate array keyed by `chunk_id`.\n\n' +
    '**Reranking.** When the corpus profile (or request body) sets `retrieval.rerank.enabled=true`, the candidate set is re-scored via Voyage or Cohere. The `audit.reranker` field exposes `{enabled, executed, fallback_reason}` so consumers can distinguish "not requested" from "requested but fell back to RRF top-K" (e.g., reranker provider unavailable).\n\n' +
    '**Reranker overrides.** `retrieval.rerank` accepts a partial override (`enabled`, `provider`, `model`, `top_n`, `provider_key_ref`, `provider_key_id`). Omitted fields inherit from the corpus profile\'s rerank config. To force-disable rerank for a single query, pass `retrieval.rerank.enabled=false`; to flip rerank on for a profile that has it off, you must also supply `provider` and `model` or the request fails with 400.\n\n' +
    '**Audit.** Every query produces a `query_events` row regardless of success/failure. Use `GET /v1/query-events/{id}` to retrieve the audit post-hoc.\n\n' +
    'Failure modes surface via `degradation_level`: `full` (everything OK), `partial` (some integrity issues but answer returned), `no_citations` (answer but model didn\'t cite), `cannot_answer` (provider/quota/empty-corpus failure).',
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: QueryRequestComponent } } },
  },
  responses: {
    200: {
      description: 'Query response.',
      content: { 'application/json': { schema: QueryResponseComponent } },
    },
    400: Responses.badRequest,
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

// Phase 6.5 — intercept `?stream=sse` BEFORE the OpenAPI route so the
// SSE branch returns a streaming Response directly. The OpenAPI route
// only documents the sync JSON shape; the streaming variant is
// described in `1-DESIGN.md` §12.4.
queryRoute.use('/', async (c, next) => {
  if (c.req.method === 'POST' && c.req.query('stream') === 'sse') {
    const body = (await c.req.json()) as StreamingQueryBody;
    return runStreamingQuery(c, body);
  }
  await next();
});

queryRoute.openapi(queryEndpoint, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const body = c.req.valid('json');
  const start = Date.now();

  // 1. Resolve namespace + corpus profile (Phase 5). Request body
  // overrides on retrieval/prompt are merged into the profile here;
  // the rest of the handler reads from the merged shape.
  const profileResolved = await resolveCorpusProfile({
    env: c.env,
    tenant_id: tenantId,
    namespace_slug: body.namespace,
    request_overrides: extractProfileOverrides(body),
  });
  const profile = profileResolved.profile;
  const ns = await getNamespaceBySlug(c.env.db, tenantId, body.namespace);
  if (!ns) {
    throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${body.namespace}`);
  }

  // 2. Insert-early query_events row.
  const qevId = await insertQueryEvent(c.env, {
    tenant_id: tenantId,
    namespace_id: ns.id,
    query_text: body.query,
    request_config: body as unknown as Record<string, unknown>,
  });

  try {
    // 3. Determine candidate versions.
    const versionIds = await resolveVersionIds(c.env, tenantId, ns.id, body.document_ids);
    if (versionIds.length === 0) {
      const audit = await finalizeFailure(
        c.env,
        qevId,
        'cannot_answer',
        'empty',
        'no candidate versions',
      );
      return c.json(emptyResponseShape(qevId, audit, 'No documents available to query.'), 200);
    }

    // 4. Profile gate — for each version_id, find the matching version_index.
    //
    // The namespace's `embedding_dimensions` is locked at create time
    // (matching what the chunks were embedded against). The query
    // embedding MUST match that locked dim — otherwise dense retrieval
    // throws `VECTOR_QUERY_ERROR (40006)` from Vectorize. The sandbox
    // UI already enforces this lock; the API/MCP didn't until now.
    //
    // Behavior:
    //   - If the request body OMITS `embedding.dimensions`, we use the
    //     namespace's locked dim and forward it to the provider.
    //   - If the request body includes a NON-matching dim, we reject
    //     fast with a clear 400. Better than silent reformatting.
    //   - If the body includes a MATCHING dim, we accept and forward.
    const lockedDim = ns.embedding_dimensions;
    if (
      body.embedding.dimensions !== undefined &&
      body.embedding.dimensions !== lockedDim
    ) {
      throw new TextralError(
        'BAD_REQUEST',
        400,
        `embedding.dimensions=${body.embedding.dimensions} does not match the namespace's locked embedding_dimensions=${lockedDim}. ` +
          'The namespace was created with this dim and all chunks were embedded at it. ' +
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

    // 5. Embed the query via Phase 2 providers.
    const queryEmbedKey = await resolveProviderKeyForQuery(
      c.env,
      tenantId,
      body.embedding.provider,
      body.embedding.provider_key_id,
      body.embedding.provider_key_ref,
    );
    const embeddingProvider = resolveProvider(c.env, {
      provider: body.embedding.provider,
      ...(queryEmbedKey ? { api_key: queryEmbedKey.raw_key } : {}),
      request_metadata: {
        tenant_id: tenantId,
        query_event_id: qevId,
        ...(queryEmbedKey ? { provider_key_id: queryEmbedKey.id } : {}),
      },
    });
    if (!embeddingProvider.embedding) {
      throw new TextralError(
        'PROVIDER_UNSUPPORTED_MODEL',
        400,
        `No embedding provider for ${body.embedding.provider}`,
      );
    }
    const embRes = await embeddingProvider.embedding.embed(
      {
        model: body.embedding.model,
        input: [body.query],
        // Always forward the namespace-locked dim. Without this,
        // OpenAI's `text-embedding-3-large` returns its native 3072d
        // and Vectorize (configured for 1536d) rejects the query.
        dimensions: effectiveDim,
      },
      embeddingProvider.options,
    );
    if (embRes.outcome === 'fatal_error' || embRes.outcome === 'retryable_error') {
      const audit = await finalizeFailure(
        c.env,
        qevId,
        'cannot_answer',
        'empty',
        embRes.error.safe_upstream_message ?? embRes.error.type,
      );
      return c.json(emptyResponseShape(qevId, audit, 'Query embedding failed.'), 200);
    }
    const queryVec = embRes.value.vectors[0]!;
    const embeddingInputTokens = embRes.value.usage.input_tokens;

    await updateQueryEvent(c.env, qevId, {
      status: 'retrieval_started',
      embedding_profile_used: embeddingProfile,
      chunking_profile_used: chunkingProfile,
    });

    // 6. Hybrid retrieval. Use the merged profile's
    // retrieval_defaults.artifact_types (Phase 5) — the request body
    // can override and that override is already merged into `profile`.
    // For Pinecone, resolve the tenant's infra key here.
    const retrievalBinding = await resolveVectorBinding(c.env, tenantId, {
      backend: ns.vector_backend,
      index_name: ns.vector_index_name,
      embedding_dimensions: body.embedding.dimensions ?? 1536,
      namespace: ns.vector_namespace,
    });
    const retrieval = await runHybridRetrieval(c.env, {
      query_vector: queryVec,
      query_text: body.query,
      tenant_id: tenantId,
      namespace_id: ns.id,
      version_ids: versionIds,
      artifact_types: profile.retrieval_defaults.artifact_types,
      top_k_dense: body.retrieval.top_k_dense,
      top_k_sparse: body.retrieval.top_k_sparse,
      rrf_k: body.retrieval.rrf_k,
      // V3 Phase 1 — picks the namespace's vector backend.
      binding: retrievalBinding,
    });

    await updateQueryEvent(c.env, qevId, {
      status: 'retrieval_completed',
      retrieval_status: retrieval.retrieval_status,
      retrieval_strategy: body.retrieval.strategy,
      candidates_returned: retrieval.candidates.length,
      dense_candidates_returned: retrieval.dense_count,
      sparse_candidates_returned: retrieval.sparse_count,
      embedding_missing_count: retrieval.embedding_missing_count,
    });

    if (retrieval.retrieval_status === 'empty' || retrieval.candidates.length === 0) {
      const audit = await finalizeFailure(
        c.env,
        qevId,
        'cannot_answer',
        retrieval.retrieval_status,
        'no candidates from either retrieval arm',
      );
      return c.json(emptyResponseShape(qevId, audit, 'No relevant context found.'), 200);
    }

    // 6b. Rerank (Phase 5). Hydrate the candidate texts only when
    // rerank is enabled — otherwise we save the D1 round trip.
    const rerankCfg = profile.retrieval_defaults.rerank;
    // Validate the merged rerank config. The corpus-profile schema's
    // own superRefine only fires at YAML-load time; once a request
    // override is merged in, we re-check the invariants here.
    if (rerankCfg.enabled && (!rerankCfg.provider || !rerankCfg.model)) {
      throw new TextralError(
        'BAD_REQUEST',
        400,
        'rerank.provider and rerank.model are required when rerank.enabled is true',
      );
    }
    const requestRerankKeyId = body.retrieval.rerank?.provider_key_id;
    let candidatesAfterRerank = retrieval.candidates;
    let rerankAudit: RerankerAudit;
    if (rerankCfg.enabled && rerankCfg.provider && rerankCfg.model) {
      const candidateIds = retrieval.candidates.map((c) => c.chunk_id);
      const rows = await hydrateChunksByIds(c.env.db, tenantId, candidateIds);
      const byId = new Map(rows.map((r) => [r.id, r.text]));
      const inputs = retrieval.candidates
        .map((c) => ({ chunk_id: c.chunk_id, text: byId.get(c.chunk_id) ?? '' }))
        .filter((c) => c.text);
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
      // Replace candidate order with the reranker's view.
      const reorderedSet = new Set(outcome.reordered);
      const reorderedCandidates: typeof retrieval.candidates = [];
      const reorderedRank = new Map(outcome.reordered.map((id, i) => [id, i]));
      for (const f of retrieval.candidates) {
        if (reorderedSet.has(f.chunk_id)) reorderedCandidates.push(f);
      }
      reorderedCandidates.sort(
        (a, b) =>
          (reorderedRank.get(a.chunk_id) ?? 0) - (reorderedRank.get(b.chunk_id) ?? 0),
      );
      candidatesAfterRerank = reorderedCandidates.length > 0
        ? reorderedCandidates
        : retrieval.candidates;
    } else {
      rerankAudit = {
        enabled: false,
        executed: false,
        provider: null,
        model: null,
        top_n: null,
      };
    }

    // 7. Context assembly with per-layer budgets from the merged
    // profile. Request-level `context.layer_budgets` is already
    // applied via mergeProfile (extractProfileOverrides routes them).
    const ctx = await assembleContext(c.env, {
      fused: candidatesAfterRerank,
      tenant_id: tenantId,
      max_context_tokens: body.context.max_context_tokens,
      layer_budgets: profile.retrieval_defaults.layer_budgets,
      layer_order: profile.retrieval_defaults.layer_order,
    });

    // 8. Resolve synthesis provider + call.
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
    if (!synthProvider.llm) {
      throw new TextralError(
        'PROVIDER_UNSUPPORTED_MODEL',
        400,
        `No LLM provider for ${body.inference.provider}`,
      );
    }
    const messages = buildMessages({
      system: body.prompt.system ?? null,
      developer: body.prompt.developer ?? null,
      user_query: body.query,
      context_block: ctx.context_block,
    });

    await updateQueryEvent(c.env, qevId, { status: 'synthesis_started' });

    const isStructured = body.output.mode === 'structured';
    const chatRes = await synthProvider.llm.chat(
      {
        model: body.inference.model,
        messages,
        ...(body.inference.max_output_tokens
          ? { max_tokens: body.inference.max_output_tokens }
          : {}),
        ...(body.inference.temperature !== undefined
          ? { temperature: body.inference.temperature }
          : {}),
        ...(isStructured && body.output.mode === 'structured'
          ? {
              response_format: {
                type: 'json_schema' as const,
                schema: body.output.schema,
                strict: true,
              },
            }
          : {}),
      },
      synthProvider.options,
    );

    if (chatRes.outcome === 'fatal_error' || chatRes.outcome === 'retryable_error') {
      const audit = await finalizeFailure(
        c.env,
        qevId,
        'cannot_answer',
        retrieval.retrieval_status,
        chatRes.error.safe_upstream_message ?? chatRes.error.type,
        'failed',
      );
      return c.json(emptyResponseShape(qevId, audit, 'Synthesis failed.'), 200);
    }

    const chat = chatRes.value;
    const answerText = chat.content;
    const synthInputTokens = chat.usage.input_tokens;
    const synthOutputTokens = chat.usage.output_tokens;
    const synthesisStatus = chat.finish_reason === 'length' ? 'truncated' : 'success';

    // 9. Citation validation.
    let answer:
      | { mode: 'text'; text: string }
      | { mode: 'structured'; object: unknown; raw?: string };
    let citations;
    let droppedCitations: number[] = [];
    let citationIntegrity: 'valid' | 'invalid_removed' | 'missing' = 'missing';

    if (isStructured && body.output.mode === 'structured') {
      const parsedRaw = chat.parsed ?? tryParseJson(answerText);
      const validation = validateAgainstSchema(body.output.schema, parsedRaw);
      if (!validation.ok) {
        const degAudit = await finalizeAudit(c.env, qevId, {
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
          synthesisStatus: 'failed',
          citationIntegrity: 'missing',
          droppedCitations: [],
          citationsReturned: 0,
          degradation: 'partial',
          startTs: start,
          rerankerAudit: rerankAudit,
        });
        const out = {
          query_event_id: qevId,
          answer: { mode: 'structured' as const, object: parsedRaw, raw: answerText },
          citations: [],
          degradation_level: 'partial' as const,
          audit: degAudit,
        };
        await mirrorAnswer(c.env, {
          query_event_id: qevId,
          tenant_id: tenantId,
          namespace_id: ns.id,
          payload: out,
        }).then(async (m) => {
          if (m.ok) {
            await updateQueryEvent(c.env, qevId, {
              status: 'completed',
              answer_r2_key: m.key ?? null,
            });
          } else {
            await updateQueryEvent(c.env, qevId, {
              status: 'completed',
              mirror_error: m.error ?? null,
            });
          }
        });
        return c.json(out, 200);
      }
      // Structured citations filter (if schema declares one).
      const structuredObj = validation.parsed as Record<string, unknown>;
      const rawCitations = (structuredObj?.citations as unknown[]) ?? [];
      const arrayShaped = Array.isArray(rawCitations)
        ? (rawCitations as Array<Record<string, unknown>>)
        : [];
      const filterRes = filterStructuredCitations(arrayShaped, ctx.included);
      // Replace structured citations array with the filtered one.
      if (Array.isArray(rawCitations)) {
        (structuredObj as Record<string, unknown>).citations = filterRes.kept;
      }
      const droppedIds = filterRes.dropped_ids;
      // Convert valid structured citations into the response shape.
      const citationsArr = filterRes.kept.flatMap((entry) => {
        const cid = (entry as { chunk_id?: string }).chunk_id;
        if (!cid) return [];
        const idx = ctx.included.findIndex((c) => c.chunk_id === cid);
        if (idx < 0) return [];
        const c = ctx.included[idx]!;
        const quote = (entry as { quote?: string }).quote;
        return [
          {
            n: c.n,
            chunk_id: c.chunk_id,
            section_path: c.section_path,
            ...(quote ? { quote } : {}),
          },
        ];
      });
      citations = citationsArr;
      // For audit: dropped chunk_ids — convert to numeric Ns where possible.
      droppedCitations = []; // structured drops are by id, not by N
      void droppedIds;
      citationIntegrity =
        rawCitations.length === 0
          ? 'missing'
          : citationsArr.length === 0
            ? 'missing'
            : citationsArr.length < rawCitations.length
              ? 'invalid_removed'
              : 'valid';
      answer = { mode: 'structured', object: structuredObj };
    } else {
      const v = validateCitations(answerText, ctx.included);
      citations = v.valid_citations.map((c) => {
        const ic = ctx.included.find((x) => x.n === c.n);
        return {
          n: c.n,
          chunk_id: c.chunk_id,
          section_path: c.section_path,
          ...(ic ? {} : {}),
        };
      });
      droppedCitations = v.dropped_citations;
      citationIntegrity = v.citation_integrity;
      answer = { mode: 'text', text: answerText };
    }

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
      citationsReturned: citations.length,
      degradation,
      startTs: start,
      rerankerAudit: rerankAudit,
    });

    const response = {
      query_event_id: qevId,
      answer,
      citations,
      degradation_level: degradation,
      audit,
    };

    // R2 mirror — best-effort.
    const mirror = await mirrorAnswer(c.env, {
      query_event_id: qevId,
      tenant_id: tenantId,
      namespace_id: ns.id,
      payload: response,
    });
    if (mirror.ok) {
      await updateQueryEvent(c.env, qevId, {
        status: 'completed',
        answer_r2_key: mirror.key ?? null,
      });
    } else {
      await updateQueryEvent(c.env, qevId, {
        status: 'completed',
        mirror_error: mirror.error ?? null,
      });
    }

    // Cost rollup (Phase 6.7) — only on success. Don't block the
    // response on the write; failure here shouldn't fail the query.
    if (synthesisStatus === 'success') {
      c.env.bg.spawn(
        recordQueryUsage(c.env, tenantId, {
          input_tokens: embeddingInputTokens + synthInputTokens,
          output_tokens: synthOutputTokens,
        }).catch((e: unknown) => {
          console.error('usage_record_query_failed', {
            request_id: c.get('request_id'),
            message: (e as Error).message,
          });
        }),
      );
    }

    // Analytics Engine (Phase 6.3) — one point per query response.
    writeMetric(c.env, 'query_executions', {
      blobs: [ns.id, embeddingProfile, body.retrieval.strategy, degradation, synthesisStatus],
      doubles: [audit.latency_ms, audit.candidates_returned, citations.length],
      indexes: [tenantId],
    });

    return c.json(response, 200);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    await updateQueryEvent(c.env, qevId, {
      status: 'failed',
      error_code: e?.code ?? 'INTERNAL',
      error_message: e?.message ?? 'unknown',
      latency_ms: Date.now() - start,
    });
    throw err;
  }
});

