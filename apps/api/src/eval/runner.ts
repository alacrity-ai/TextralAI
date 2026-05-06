// Phase 7 — eval runner.
//
// Runs an eval set against a namespace. For each question:
//   1. Issue a sync /v1/query equivalent (call the same retrieval +
//      synthesis pipeline via internal hooks).
//   2. Invoke the three built-in judges (parallel, max-concurrency 5).
//   3. Aggregate scores → pass/fail by `pass_threshold`.
//
// MVP simplification: the runner runs SYNCHRONOUSLY inside the
// request handler. Sets up to ~30 questions complete within a few
// seconds when judges run on a fast model. Larger sets should be
// paginated by the tenant; queue-driven async runs are a post-MVP
// extension.

import type { Env } from '../types.js';
import { newId, TextralError } from '@textral/contracts';
import { ALL_JUDGES, runJudge, type JudgeId } from './judges.js';
import { resolveProviderKey } from '../auth/provider-key-resolver.js';
import {
  getEvalSet,
  listEvalQuestions,
  insertEvalResult,
  updateEvalRunStatus,
} from '../db/eval.js';
import { resolveCorpusProfile } from '../retrieval/profile-resolver.js';
import { getNamespaceBySlug, getNamespaceByIdAny } from '../db/namespaces.js';
import { resolveVersionIds } from '../query/helpers.js';
import { runHybridRetrieval } from '../retrieval/hybrid.js';
import { hydrateChunksByIds } from '../db/chunks.js';
import { assembleContext } from '../retrieval/context-assembly.js';
import { buildMessages } from '../synthesis/prompt-builder.js';
import { resolve as resolveProvider } from '../providers/registry.js';
import { validateCitations } from '../synthesis/citation-validator.js';
import { insertQueryEvent, updateQueryEvent } from '../audit/query-events.js';
import { makeEmbeddingProfile } from '../ingestion/dispatch.js';

const MAX_PARALLEL_JUDGES = 5;

export interface EvalRunArgs {
  env: Env;
  run_id: string;
  eval_set_id: string;
  tenant_id: string;
  inference: {
    provider: string;
    model: string;
    provider_key_id?: string | undefined;
    provider_key_ref?: string | undefined;
  };
  embedding: {
    provider: string;
    model: string;
    dimensions?: number | undefined;
    provider_key_id?: string | undefined;
    provider_key_ref?: string | undefined;
  };
  pass_threshold: number;
}

export async function executeEvalRun(args: EvalRunArgs): Promise<void> {
  const { env, run_id, eval_set_id, tenant_id, pass_threshold } = args;
  const set = await getEvalSet(env.db, tenant_id, eval_set_id);
  if (!set) throw new TextralError('EVAL_SET_NOT_FOUND', 404, 'Eval set not found');
  const ns = await getNamespaceByIdAny(env.db, set.namespace_id);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, 'Namespace gone');
  const questions = await listEvalQuestions(env.db, eval_set_id);

  await updateEvalRunStatus(env.db, run_id, { status: 'running', started_at: Date.now() });

  let numPassed = 0;
  let numFailed = 0;

  // Resolve keys once (eval-wide).
  const inferKey = await resolveProviderKey(
    env,
    tenant_id,
    {
      kind: 'either',
      provider: args.inference.provider,
      ...(args.inference.provider_key_id ? { id: args.inference.provider_key_id } : {}),
      ...(args.inference.provider_key_ref ? { ref: args.inference.provider_key_ref } : {}),
    },
    { include_raw: true },
  );
  const embedKey = await resolveProviderKey(
    env,
    tenant_id,
    {
      kind: 'either',
      provider: args.embedding.provider,
      ...(args.embedding.provider_key_id ? { id: args.embedding.provider_key_id } : {}),
      ...(args.embedding.provider_key_ref ? { ref: args.embedding.provider_key_ref } : {}),
    },
    { include_raw: true },
  );

  for (const q of questions) {
    try {
      // Skip if a judge override forces a non-builtin judge.
      const judgeOverrides = q.judge_overrides
        ? (JSON.parse(q.judge_overrides) as Partial<Record<JudgeId, string>>)
        : {};

      // Run a query against the namespace.
      const queryResult = await runQueryForEval({
        env,
        tenant_id,
        namespace_slug: ns.slug,
        query: q.question,
        inference: { ...args.inference, ...(inferKey ? { raw_key: inferKey.raw_key, key_id: inferKey.id } : {}) },
        embedding: { ...args.embedding, ...(embedKey ? { raw_key: embedKey.raw_key, key_id: embedKey.id } : {}) },
      });

      // Run all three judges in parallel.
      const judgeRuns: Array<Promise<{ id: JudgeId; score: number }>> = [];
      const limited = throttle(MAX_PARALLEL_JUDGES);
      for (const j of ALL_JUDGES) {
        judgeRuns.push(
          limited(async () => {
            const out = await runJudge(
              env,
              j,
              {
                question: q.question,
                answer: queryResult.answer,
                citations: queryResult.citations.map((c, i) => ({
                  n: i + 1,
                  text: c.text,
                })),
              },
              {
                provider: args.inference.provider,
                model: args.inference.model,
                tenant_id,
                ...(inferKey?.raw_key ? { api_key: inferKey.raw_key } : {}),
                ...(inferKey?.id ? { provider_key_id: inferKey.id } : {}),
              },
              judgeOverrides[j],
            );
            return { id: j, score: out.score };
          }),
        );
      }
      const judged = await Promise.all(judgeRuns);
      const scores: Record<string, number> = {};
      for (const j of judged) scores[j.id] = j.score;
      const minScore = Math.min(...judged.map((x) => x.score));
      const passed = minScore >= pass_threshold;
      if (passed) numPassed++;
      else numFailed++;
      await insertEvalResult(env.db, {
        id: newId('evres'),
        eval_run_id: run_id,
        question_id: q.id,
        passed,
        scores,
        query_event_id: queryResult.query_event_id,
      });
    } catch (err) {
      const msg = (err as Error).message;
      numFailed++;
      await insertEvalResult(env.db, {
        id: newId('evres'),
        eval_run_id: run_id,
        question_id: q.id,
        passed: false,
        scores: {},
        error_message: msg,
      });
    }
  }

  await updateEvalRunStatus(env.db, run_id, {
    status: 'completed',
    completed_at: Date.now(),
    num_passed: numPassed,
    num_failed: numFailed,
  });
}

interface QueryForEvalResult {
  answer: string;
  citations: Array<{ chunk_id: string; text: string; n: number }>;
  query_event_id: string;
}

async function runQueryForEval(opts: {
  env: Env;
  tenant_id: string;
  namespace_slug: string;
  query: string;
  inference: {
    provider: string;
    model: string;
    raw_key?: string | undefined;
    key_id?: string | undefined;
  };
  embedding: {
    provider: string;
    model: string;
    dimensions?: number | undefined;
    raw_key?: string | undefined;
    key_id?: string | undefined;
  };
}): Promise<QueryForEvalResult> {
  const { env, tenant_id } = opts;
  const profileResolved = await resolveCorpusProfile({
    env,
    tenant_id,
    namespace_slug: opts.namespace_slug,
    request_overrides: undefined,
  });
  const profile = profileResolved.profile;
  const ns = await getNamespaceBySlug(env.db, tenant_id, opts.namespace_slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, 'Namespace gone');

  const versionIds = await resolveVersionIds(env, tenant_id, ns.id, undefined);
  if (versionIds.length === 0) {
    throw new TextralError('NOT_FOUND', 404, 'No documents in namespace');
  }

  // Validate the embedding profile is constructible (catches a bad
  // model name early). The eval runner doesn't pin chunks to a profile
  // — that's the version_index's job — but we surface the same shape
  // so future plumbing has a hook.
  void makeEmbeddingProfile(
    opts.embedding.provider,
    opts.embedding.model,
    opts.embedding.dimensions ?? 1536,
  );

  const qevId = await insertQueryEvent(env, {
    tenant_id,
    namespace_id: ns.id,
    query_text: opts.query,
    request_config: { source: 'eval' } as Record<string, unknown>,
  });

  // Embed.
  const embedProvider = resolveProvider(env, {
    provider: opts.embedding.provider,
    ...(opts.embedding.raw_key ? { api_key: opts.embedding.raw_key } : {}),
    request_metadata: {
      tenant_id,
      query_event_id: qevId,
      ...(opts.embedding.key_id ? { provider_key_id: opts.embedding.key_id } : {}),
    },
  });
  if (!embedProvider.embedding) {
    throw new TextralError('PROVIDER_UNSUPPORTED_MODEL', 400, `No embedding for ${opts.embedding.provider}`);
  }
  const embRes = await embedProvider.embedding.embed(
    {
      model: opts.embedding.model,
      input: [opts.query],
      ...(opts.embedding.dimensions ? { dimensions: opts.embedding.dimensions } : {}),
    },
    embedProvider.options,
  );
  if (embRes.outcome !== 'success' && embRes.outcome !== 'degraded_success') {
    throw new TextralError('PROVIDER_UNAVAILABLE', 503, `Eval embedding failed: ${embRes.error.type}`);
  }
  const queryVec = embRes.value.vectors[0]!;

  const retrieval = await runHybridRetrieval(env, {
    query_vector: queryVec,
    query_text: opts.query,
    tenant_id,
    namespace_id: ns.id,
    version_ids: versionIds,
    artifact_types: profile.retrieval_defaults.artifact_types,
    top_k_dense: 5,
    top_k_sparse: 5,
    rrf_k: 60,
    binding: {
      backend: ns.vector_backend,
      index_name: ns.vector_index_name,
      embedding_dimensions: opts.embedding.dimensions ?? 1536,
      namespace: ns.vector_namespace,
    },
  });
  if (retrieval.candidates.length === 0) {
    return { answer: '', citations: [], query_event_id: qevId };
  }

  const ctx = await assembleContext(env, {
    fused: retrieval.candidates,
    tenant_id,
    max_context_tokens: 4000,
    layer_budgets: profile.retrieval_defaults.layer_budgets,
    layer_order: profile.retrieval_defaults.layer_order,
  });

  const synthProvider = resolveProvider(env, {
    provider: opts.inference.provider,
    ...(opts.inference.raw_key ? { api_key: opts.inference.raw_key } : {}),
    request_metadata: {
      tenant_id,
      query_event_id: qevId,
      ...(opts.inference.key_id ? { provider_key_id: opts.inference.key_id } : {}),
    },
  });
  if (!synthProvider.llm) {
    throw new TextralError('PROVIDER_UNSUPPORTED_MODEL', 400, `No LLM for ${opts.inference.provider}`);
  }
  const messages = buildMessages({
    system: profile.prompt_defaults?.system ?? null,
    developer: null,
    user_query: opts.query,
    context_block: ctx.context_block,
  });
  const chat = await synthProvider.llm.chat(
    {
      model: opts.inference.model,
      messages,
      max_tokens: 800,
      temperature: 0,
    },
    synthProvider.options,
  );
  if (chat.outcome !== 'success' && chat.outcome !== 'degraded_success') {
    throw new TextralError('PROVIDER_UNAVAILABLE', 503, `Eval synthesis failed: ${chat.error.type}`);
  }
  const answer = chat.value.content;
  const cite = validateCitations(answer, ctx.included);
  // Hydrate citation texts for the judge prompt.
  const hydrated = await hydrateChunksByIds(
    env.db,
    tenant_id,
    cite.valid_citations.map((c) => c.chunk_id),
  );
  const byId = new Map(hydrated.map((r) => [r.id, r.text]));
  const citations = cite.valid_citations.map((c) => ({
    chunk_id: c.chunk_id,
    text: byId.get(c.chunk_id) ?? '',
    n: c.n,
  }));

  await updateQueryEvent(env, qevId, { status: 'completed' });

  return { answer, citations, query_event_id: qevId };
}

// Tiny throttle: cap concurrent in-flight tasks to N. Returns a wrapper
// `limited(fn)` that queues if N tasks are already running.
function throttle(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}
