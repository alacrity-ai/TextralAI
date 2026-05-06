// Phase 7 — eval contract API routes.
//
// /v1/namespaces/:slug/eval-sets       — register a set
// /v1/namespaces/:slug/eval-sets/:id   — fetch set + questions
// .../runs                              — start a run (sync) + list runs
// .../runs/:run_id                      — fetch run detail

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError, newId } from '@textral/contracts';
import {
  RegisterEvalSetRequest,
  StartEvalRunRequest,
  EvalSet as EvalSetSchema,
  EvalSetWithQuestions as EvalSetWithQuestionsSchema,
  EvalRun as EvalRunSchema,
  EvalRunDetail as EvalRunDetailSchema,
} from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { Responses } from '../openapi/registry.js';
import { z } from '../openapi/z.js';
import { getNamespaceBySlug } from '../db/namespaces.js';
import {
  insertEvalSet,
  insertEvalQuestion,
  getEvalSet,
  listEvalSetsByNamespace,
  listEvalQuestions,
  insertEvalRun,
  getEvalRun,
  listEvalRuns,
  listEvalResultsForRun,
  updateEvalRunStatus,
} from '../db/eval.js';
import { resolveProviderKey } from '../auth/provider-key-resolver.js';
import { executeEvalRun } from '../eval/runner.js';

export const evalRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const SlugParam = z.object({ slug: z.string().min(1).max(80) });
const SlugIdParam = SlugParam.extend({ id: z.string().min(1).max(60) });
const SlugIdRunIdParam = SlugIdParam.extend({ run_id: z.string().min(1).max(60) });

// ── POST /v1/namespaces/:slug/eval-sets ──────────────────────────────

const registerSet = createRoute({
  method: 'post',
  path: '/{slug}/eval-sets',
  tags: ['Eval'],
  summary: 'Register an eval set',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: SlugParam,
    body: { content: { 'application/json': { schema: RegisterEvalSetRequest } }, required: true },
  },
  responses: {
    200: {
      description: 'Set created.',
      content: { 'application/json': { schema: EvalSetWithQuestionsSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
    409: Responses.conflict,
  },
});

evalRoute.openapi(registerSet, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { slug } = c.req.valid('param');
  const body = c.req.valid('json');
  const ns = await getNamespaceBySlug(c.env.db, tenantId, slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);

  const setId = newId('evset');
  try {
    await insertEvalSet(c.env.db, {
      id: setId,
      tenant_id: tenantId,
      namespace_id: ns.id,
      name: body.name,
    });
  } catch (e) {
    // SQLite UNIQUE violation surfaces as a generic error; map it.
    if ((e as Error).message.includes('UNIQUE')) {
      throw new TextralError('NAMESPACE_ALREADY_EXISTS', 409, `Eval set name already exists: ${body.name}`);
    }
    throw e;
  }

  const out = [];
  for (const q of body.questions) {
    const qid = newId('evq');
    await insertEvalQuestion(c.env.db, {
      id: qid,
      eval_set_id: setId,
      question: q.question,
      ...(q.expected_answer ? { expected_answer: q.expected_answer } : {}),
      ...(q.must_cite_chunk_ids ? { must_cite_chunk_ids: q.must_cite_chunk_ids } : {}),
      ...(q.judge_overrides ? { judge_overrides: q.judge_overrides } : {}),
    });
    out.push({
      id: qid,
      question: q.question,
      expected_answer: q.expected_answer,
      must_cite_chunk_ids: q.must_cite_chunk_ids,
      judge_overrides: q.judge_overrides,
      created_at: Date.now(),
    });
  }
  return c.json(
    {
      id: setId,
      tenant_id: tenantId,
      namespace_id: ns.id,
      name: body.name,
      created_at: Date.now(),
      questions: out,
    },
    200,
  );
});

// ── GET /v1/namespaces/:slug/eval-sets ──────────────────────────────

const EvalSetList = z.object({ data: z.array(EvalSetSchema) });

const listSets = createRoute({
  method: 'get',
  path: '/{slug}/eval-sets',
  tags: ['Eval'],
  summary: 'List eval sets in a namespace',
  security: [{ ApiKeyAuth: [] }],
  request: { params: SlugParam },
  responses: {
    200: {
      description: 'Sets.',
      content: { 'application/json': { schema: EvalSetList } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

evalRoute.openapi(listSets, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { slug } = c.req.valid('param');
  const ns = await getNamespaceBySlug(c.env.db, tenantId, slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);
  const sets = await listEvalSetsByNamespace(c.env.db, tenantId, ns.id);
  return c.json({ data: sets }, 200);
});

// ── GET /v1/namespaces/:slug/eval-sets/:id ──────────────────────────

const getSet = createRoute({
  method: 'get',
  path: '/{slug}/eval-sets/{id}',
  tags: ['Eval'],
  summary: 'Fetch an eval set + its questions',
  security: [{ ApiKeyAuth: [] }],
  request: { params: SlugIdParam },
  responses: {
    200: {
      description: 'Set + questions.',
      content: { 'application/json': { schema: EvalSetWithQuestionsSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

evalRoute.openapi(getSet, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { slug, id } = c.req.valid('param');
  const ns = await getNamespaceBySlug(c.env.db, tenantId, slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);
  const set = await getEvalSet(c.env.db, tenantId, id);
  if (!set || set.namespace_id !== ns.id) {
    throw new TextralError('EVAL_SET_NOT_FOUND', 404, 'Eval set not found');
  }
  const questions = await listEvalQuestions(c.env.db, id);
  return c.json(
    {
      ...set,
      questions: questions.map((q) => ({
        id: q.id,
        question: q.question,
        expected_answer: q.expected_answer ?? undefined,
        must_cite_chunk_ids: q.must_cite_chunk_ids ? (JSON.parse(q.must_cite_chunk_ids) as string[]) : undefined,
        judge_overrides: q.judge_overrides
          ? (JSON.parse(q.judge_overrides) as Record<string, string>)
          : undefined,
        created_at: q.created_at,
      })),
    },
    200,
  );
});

// ── POST /v1/namespaces/:slug/eval-sets/:id/runs ────────────────────

const startRun = createRoute({
  method: 'post',
  path: '/{slug}/eval-sets/{id}/runs',
  tags: ['Eval'],
  summary: 'Run an eval set',
  description:
    'Synchronously runs the set against the namespace. Returns the run record once all questions complete. For sets with N>30 questions, expect multi-second latency.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: SlugIdParam,
    body: { content: { 'application/json': { schema: StartEvalRunRequest } }, required: true },
  },
  responses: {
    200: {
      description: 'Run completed.',
      content: { 'application/json': { schema: EvalRunSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

evalRoute.openapi(startRun, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { slug, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const ns = await getNamespaceBySlug(c.env.db, tenantId, slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);
  const set = await getEvalSet(c.env.db, tenantId, id);
  if (!set || set.namespace_id !== ns.id) {
    throw new TextralError('EVAL_SET_NOT_FOUND', 404, 'Eval set not found');
  }
  const questions = await listEvalQuestions(c.env.db, id);
  if (questions.length === 0) {
    throw new TextralError('BAD_REQUEST', 400, 'Eval set has no questions');
  }

  // Resolve the inference provider key now (so we fail fast on bad config).
  const inferKey = await resolveProviderKey(
    c.env,
    tenantId,
    {
      kind: 'either',
      provider: body.inference.provider,
      ...(body.inference.provider_key_id ? { id: body.inference.provider_key_id } : {}),
      ...(body.inference.provider_key_ref ? { ref: body.inference.provider_key_ref } : {}),
    },
    { include_raw: false },
  );

  const runId = newId('evrun');
  await insertEvalRun(c.env.db, {
    id: runId,
    eval_set_id: id,
    tenant_id: tenantId,
    num_questions: questions.length,
    inference_provider: body.inference.provider,
    inference_model: body.inference.model,
    provider_key_id: inferKey?.id ?? null,
    config_json: JSON.stringify({
      pass_threshold: body.pass_threshold,
    }),
  });

  try {
    await executeEvalRun({
      env: c.env,
      run_id: runId,
      eval_set_id: id,
      tenant_id: tenantId,
      inference: body.inference,
      embedding: body.embedding,
      pass_threshold: body.pass_threshold,
    });
  } catch (e) {
    await updateEvalRunStatus(c.env.db, runId, {
      status: 'failed',
      completed_at: Date.now(),
      error_message: (e as Error).message,
    });
    throw new TextralError('EVAL_RUN_FAILED', 500, (e as Error).message);
  }

  const run = await getEvalRun(c.env.db, tenantId, runId);
  if (!run) throw new TextralError('EVAL_RUN_NOT_FOUND', 404, 'Run vanished');
  return c.json(
    {
      id: run.id,
      eval_set_id: run.eval_set_id,
      status: run.status,
      num_questions: run.num_questions,
      num_passed: run.num_passed,
      num_failed: run.num_failed,
      started_at: run.started_at,
      completed_at: run.completed_at,
      error_message: run.error_message,
      created_at: run.created_at,
    },
    200,
  );
});

// ── GET /v1/namespaces/:slug/eval-sets/:id/runs ─────────────────────

const RunList = z.object({ data: z.array(EvalRunSchema) });

const listRuns = createRoute({
  method: 'get',
  path: '/{slug}/eval-sets/{id}/runs',
  tags: ['Eval'],
  summary: 'List runs of an eval set',
  security: [{ ApiKeyAuth: [] }],
  request: { params: SlugIdParam },
  responses: {
    200: { description: 'Runs.', content: { 'application/json': { schema: RunList } } },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

evalRoute.openapi(listRuns, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { slug, id } = c.req.valid('param');
  const ns = await getNamespaceBySlug(c.env.db, tenantId, slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);
  const set = await getEvalSet(c.env.db, tenantId, id);
  if (!set || set.namespace_id !== ns.id) {
    throw new TextralError('EVAL_SET_NOT_FOUND', 404, 'Eval set not found');
  }
  const runs = await listEvalRuns(c.env.db, tenantId, id);
  return c.json(
    {
      data: runs.map((r) => ({
        id: r.id,
        eval_set_id: r.eval_set_id,
        status: r.status,
        num_questions: r.num_questions,
        num_passed: r.num_passed,
        num_failed: r.num_failed,
        started_at: r.started_at,
        completed_at: r.completed_at,
        error_message: r.error_message,
        created_at: r.created_at,
      })),
    },
    200,
  );
});

// ── GET /v1/namespaces/:slug/eval-sets/:id/runs/:run_id ─────────────

const getRun = createRoute({
  method: 'get',
  path: '/{slug}/eval-sets/{id}/runs/{run_id}',
  tags: ['Eval'],
  summary: 'Fetch run detail (per-question results)',
  security: [{ ApiKeyAuth: [] }],
  request: { params: SlugIdRunIdParam },
  responses: {
    200: {
      description: 'Run detail.',
      content: { 'application/json': { schema: EvalRunDetailSchema } },
    },
    401: Responses.unauthorized,
    404: Responses.notFound,
  },
});

evalRoute.openapi(getRun, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const { slug, id, run_id } = c.req.valid('param');
  const ns = await getNamespaceBySlug(c.env.db, tenantId, slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, `Namespace not found: ${slug}`);
  const set = await getEvalSet(c.env.db, tenantId, id);
  if (!set || set.namespace_id !== ns.id) {
    throw new TextralError('EVAL_SET_NOT_FOUND', 404, 'Eval set not found');
  }
  const run = await getEvalRun(c.env.db, tenantId, run_id);
  if (!run || run.eval_set_id !== id) {
    throw new TextralError('EVAL_RUN_NOT_FOUND', 404, 'Eval run not found');
  }
  const results = await listEvalResultsForRun(c.env.db, run_id);
  return c.json(
    {
      id: run.id,
      eval_set_id: run.eval_set_id,
      status: run.status,
      num_questions: run.num_questions,
      num_passed: run.num_passed,
      num_failed: run.num_failed,
      started_at: run.started_at,
      completed_at: run.completed_at,
      error_message: run.error_message,
      created_at: run.created_at,
      results: results.map((r) => ({
        question_id: r.question_id,
        passed: Boolean(r.passed),
        scores: JSON.parse(r.scores_json) as Record<string, number>,
        query_event_id: r.query_event_id,
        error_message: r.error_message,
      })),
    },
    200,
  );
});
