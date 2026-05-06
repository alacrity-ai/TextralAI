// Phase 7 — eval contract.
//
// Tenant-facing API: register a golden set, run it, fetch results.
// The judge prompts and run mechanics are implementation-side
// (apps/api/src/eval/); this module owns the wire shapes.

import { z } from 'zod';

export const JudgeId = z.enum(['relevance', 'groundedness', 'citation_quality']);
export type JudgeId = z.infer<typeof JudgeId>;

export const EvalQuestionInput = z.object({
  question: z.string().min(1).max(2000),
  expected_answer: z.string().max(8000).optional(),
  must_cite_chunk_ids: z.array(z.string()).optional(),
  /** Optional per-question judge overrides — `{ judge_id: prompt_text }`.
   *  When supplied, replaces the built-in prompt for THIS question only. */
  judge_overrides: z.record(JudgeId, z.string().min(1).max(8000)).optional(),
});
export type EvalQuestionInput = z.infer<typeof EvalQuestionInput>;

export const EvalQuestion = EvalQuestionInput.extend({
  id: z.string(),
  created_at: z.number(),
});
export type EvalQuestion = z.infer<typeof EvalQuestion>;

export const EvalSet = z.object({
  id: z.string(),
  tenant_id: z.string(),
  namespace_id: z.string(),
  name: z.string().min(1).max(120),
  created_at: z.number(),
});
export type EvalSet = z.infer<typeof EvalSet>;

export const EvalSetWithQuestions = EvalSet.extend({
  questions: z.array(EvalQuestion),
});
export type EvalSetWithQuestions = z.infer<typeof EvalSetWithQuestions>;

export const RegisterEvalSetRequest = z.object({
  name: z.string().min(1).max(120),
  questions: z.array(EvalQuestionInput).min(1).max(500),
});
export type RegisterEvalSetRequest = z.infer<typeof RegisterEvalSetRequest>;

export const StartEvalRunRequest = z.object({
  /** Provider used to drive the JUDGES (each judge call is a chat completion). */
  inference: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    provider_key_ref: z.string().optional(),
    provider_key_id: z.string().optional(),
  }),
  /** Embedding provider used to drive the underlying queries. Same shape
   *  as `/v1/query`'s embedding block. */
  embedding: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    dimensions: z.number().int().positive().optional(),
    provider_key_ref: z.string().optional(),
    provider_key_id: z.string().optional(),
  }),
  /** Pass-rule: minimum score across all judges to count as passed. Default 4. */
  pass_threshold: z.number().int().min(1).max(5).default(4),
});
export type StartEvalRunRequest = z.infer<typeof StartEvalRunRequest>;

export const EvalRunStatus = z.enum(['pending', 'running', 'completed', 'failed']);
export type EvalRunStatus = z.infer<typeof EvalRunStatus>;

export const EvalRun = z.object({
  id: z.string(),
  eval_set_id: z.string(),
  status: EvalRunStatus,
  num_questions: z.number().int(),
  num_passed: z.number().int(),
  num_failed: z.number().int(),
  started_at: z.number().nullable(),
  completed_at: z.number().nullable(),
  error_message: z.string().nullable(),
  created_at: z.number(),
});
export type EvalRun = z.infer<typeof EvalRun>;

export const EvalResult = z.object({
  question_id: z.string(),
  passed: z.boolean(),
  scores: z.record(JudgeId, z.number().int().min(1).max(5)),
  query_event_id: z.string().nullable(),
  error_message: z.string().nullable(),
});
export type EvalResult = z.infer<typeof EvalResult>;

export const EvalRunDetail = EvalRun.extend({
  results: z.array(EvalResult),
});
export type EvalRunDetail = z.infer<typeof EvalRunDetail>;
