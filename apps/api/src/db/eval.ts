// D1 helpers for the Phase 7 eval contract.
//
// Tenant-scoped wherever the caller is authenticated; the
// queue-driven runner uses the *_Any variants since it's already
// running with verified ownership.

import type { Db } from '../runtime/shared/interfaces.js';

export interface EvalSetRow {
  id: string;
  tenant_id: string;
  namespace_id: string;
  name: string;
  created_at: number;
}

export interface EvalQuestionRow {
  id: string;
  eval_set_id: string;
  question: string;
  expected_answer: string | null;
  must_cite_chunk_ids: string | null; // JSON
  judge_overrides: string | null; // JSON
  created_at: number;
}

export interface EvalRunRow {
  id: string;
  eval_set_id: string;
  tenant_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  started_at: number | null;
  completed_at: number | null;
  num_questions: number;
  num_passed: number;
  num_failed: number;
  error_message: string | null;
  created_at: number;
  inference_provider: string | null;
  inference_model: string | null;
  provider_key_id: string | null;
  config_json: string;
}

export interface EvalResultRow {
  id: string;
  eval_run_id: string;
  question_id: string;
  passed: number;
  scores_json: string;
  query_event_id: string | null;
  error_message: string | null;
  created_at: number;
}

export async function insertEvalSet(
  db: Db,
  args: { id: string; tenant_id: string; namespace_id: string; name: string },
): Promise<void> {
  await db.exec(
    `INSERT INTO eval_sets (id, tenant_id, namespace_id, name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    [args.id, args.tenant_id, args.namespace_id, args.name, Date.now()],
  );
}

export async function insertEvalQuestion(
  db: Db,
  args: {
    id: string;
    eval_set_id: string;
    question: string;
    expected_answer?: string;
    must_cite_chunk_ids?: string[];
    judge_overrides?: Record<string, string>;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO eval_questions
         (id, eval_set_id, question, expected_answer,
          must_cite_chunk_ids, judge_overrides, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.eval_set_id,
      args.question,
      args.expected_answer ?? null,
      args.must_cite_chunk_ids ? JSON.stringify(args.must_cite_chunk_ids) : null,
      args.judge_overrides ? JSON.stringify(args.judge_overrides) : null,
      Date.now(),
    ],
  );
}

export async function getEvalSet(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<EvalSetRow | null> {
  return await db.one<EvalSetRow>(
    `SELECT * FROM eval_sets WHERE id = ? AND tenant_id = ?`,
    [id, tenant_id],
  );
}

export async function listEvalSetsByNamespace(
  db: Db,
  tenant_id: string,
  namespace_id: string,
): Promise<EvalSetRow[]> {
  return await db.all<EvalSetRow>(
    `SELECT * FROM eval_sets
        WHERE tenant_id = ? AND namespace_id = ?
        ORDER BY created_at DESC`,
    [tenant_id, namespace_id],
  );
}

export async function listEvalQuestions(
  db: Db,
  eval_set_id: string,
): Promise<EvalQuestionRow[]> {
  return await db.all<EvalQuestionRow>(
    `SELECT * FROM eval_questions WHERE eval_set_id = ? ORDER BY created_at ASC`,
    [eval_set_id],
  );
}

export async function insertEvalRun(
  db: Db,
  args: {
    id: string;
    eval_set_id: string;
    tenant_id: string;
    num_questions: number;
    inference_provider: string;
    inference_model: string;
    provider_key_id: string | null;
    config_json: string;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO eval_runs
         (id, eval_set_id, tenant_id, status, num_questions,
          inference_provider, inference_model, provider_key_id,
          config_json, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.eval_set_id,
      args.tenant_id,
      args.num_questions,
      args.inference_provider,
      args.inference_model,
      args.provider_key_id,
      args.config_json,
      Date.now(),
    ],
  );
}

export async function updateEvalRunStatus(
  db: Db,
  id: string,
  args: {
    status: EvalRunRow['status'];
    started_at?: number;
    completed_at?: number;
    num_passed?: number;
    num_failed?: number;
    error_message?: string | null;
  },
): Promise<void> {
  const sets: string[] = ['status = ?'];
  const binds: (string | number | null)[] = [args.status];
  if (args.started_at !== undefined) {
    sets.push('started_at = ?');
    binds.push(args.started_at);
  }
  if (args.completed_at !== undefined) {
    sets.push('completed_at = ?');
    binds.push(args.completed_at);
  }
  if (args.num_passed !== undefined) {
    sets.push('num_passed = ?');
    binds.push(args.num_passed);
  }
  if (args.num_failed !== undefined) {
    sets.push('num_failed = ?');
    binds.push(args.num_failed);
  }
  if (args.error_message !== undefined) {
    sets.push('error_message = ?');
    binds.push(args.error_message);
  }
  binds.push(id);
  await db.exec(`UPDATE eval_runs SET ${sets.join(', ')} WHERE id = ?`, binds);
}

export async function getEvalRun(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<EvalRunRow | null> {
  return await db.one<EvalRunRow>(
    `SELECT * FROM eval_runs WHERE id = ? AND tenant_id = ?`,
    [id, tenant_id],
  );
}

export async function listEvalRuns(
  db: Db,
  tenant_id: string,
  eval_set_id: string,
): Promise<EvalRunRow[]> {
  return await db.all<EvalRunRow>(
    `SELECT * FROM eval_runs
        WHERE tenant_id = ? AND eval_set_id = ?
        ORDER BY created_at DESC`,
    [tenant_id, eval_set_id],
  );
}

export async function insertEvalResult(
  db: Db,
  args: {
    id: string;
    eval_run_id: string;
    question_id: string;
    passed: boolean;
    scores: Record<string, number>;
    query_event_id?: string | null;
    error_message?: string | null;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO eval_results
         (id, eval_run_id, question_id, passed, scores_json,
          query_event_id, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.eval_run_id,
      args.question_id,
      args.passed ? 1 : 0,
      JSON.stringify(args.scores),
      args.query_event_id ?? null,
      args.error_message ?? null,
      Date.now(),
    ],
  );
}

export async function listEvalResultsForRun(
  db: Db,
  eval_run_id: string,
): Promise<EvalResultRow[]> {
  return await db.all<EvalResultRow>(
    `SELECT * FROM eval_results WHERE eval_run_id = ? ORDER BY created_at ASC`,
    [eval_run_id],
  );
}
