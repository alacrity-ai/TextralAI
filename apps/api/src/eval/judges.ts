// Phase 7.3 — built-in judges + invocation glue.
//
// Each judge is a single chat completion against the tenant's
// configured inference model. The prompt asks for a 1-5 score plus
// a short reasoning. Built-in prompt strings are constants so we
// don't need filesystem reads at runtime (workers don't have one).
//
// Tenant-supplied judge overrides (per-question) replace the prompt
// body but keep the response shape contract.

import type { Env } from '../types.js';
import { resolve as resolveProvider } from '../providers/registry.js';
import { TextralError } from '@textral/contracts';
import type { ChatMessage } from '../providers/types.js';

export type JudgeId = 'relevance' | 'groundedness' | 'citation_quality';

const RELEVANCE_PROMPT = `You are an evaluation judge. Score how relevant the assistant's answer
is to the user's question on a 1–5 scale:
- 5: completely on-topic, addresses every part of the question.
- 4: on-topic with minor omissions.
- 3: partially relevant; major aspects missing.
- 2: mostly off-topic.
- 1: irrelevant.

Question:
{{question}}

Answer:
{{answer}}

Respond with a single JSON object: {"score": <int 1-5>, "reasoning": "<brief>"}.`;

const GROUNDEDNESS_PROMPT = `You are an evaluation judge. Score how well the assistant's answer is
grounded in the cited context. 1-5 scale:
- 5: every claim is supported by the citations.
- 4: minor unsupported aside; main claims grounded.
- 3: half the claims grounded.
- 2: a few claims grounded, most invented.
- 1: hallucinated; nothing grounded.

Question:
{{question}}

Answer:
{{answer}}

Cited context (truncated):
{{citations}}

Respond with a single JSON object: {"score": <int 1-5>, "reasoning": "<brief>"}.`;

const CITATION_QUALITY_PROMPT = `You are an evaluation judge. Score the quality of the assistant's
citation use. 1-5 scale:
- 5: every claim has a precise [N] citation that supports it.
- 4: citations present, mostly precise; minor mismatches.
- 3: citations present but loosely tied to claims.
- 2: a couple of citations, mostly absent.
- 1: no citations or all bogus.

Question:
{{question}}

Answer (citations are formatted [1], [2], etc.):
{{answer}}

Available citation IDs: {{citation_ids}}

Respond with a single JSON object: {"score": <int 1-5>, "reasoning": "<brief>"}.`;

const BUILTIN_PROMPTS: Record<JudgeId, string> = {
  relevance: RELEVANCE_PROMPT,
  groundedness: GROUNDEDNESS_PROMPT,
  citation_quality: CITATION_QUALITY_PROMPT,
};

export interface JudgeContext {
  question: string;
  answer: string;
  citations: Array<{ n: number; text: string }>;
}

export interface JudgeOutcome {
  score: number;
  reasoning: string;
}

function fillTemplate(prompt: string, ctx: JudgeContext): string {
  const citationsBlock = ctx.citations
    .map((c) => `[${c.n}] ${c.text.slice(0, 400)}`)
    .join('\n\n');
  const citationIds = ctx.citations.map((c) => `[${c.n}]`).join(', ');
  return prompt
    .replace('{{question}}', ctx.question)
    .replace('{{answer}}', ctx.answer)
    .replace('{{citations}}', citationsBlock)
    .replace('{{citation_ids}}', citationIds || '(none)');
}

export async function runJudge(
  env: Env,
  judge: JudgeId,
  ctx: JudgeContext,
  inference: { provider: string; model: string; api_key?: string; provider_key_id?: string; tenant_id: string },
  override?: string,
): Promise<JudgeOutcome> {
  const prompt = override ?? BUILTIN_PROMPTS[judge];
  const filled = fillTemplate(prompt, ctx);
  const provider = resolveProvider(env, {
    provider: inference.provider,
    ...(inference.api_key ? { api_key: inference.api_key } : {}),
    request_metadata: {
      tenant_id: inference.tenant_id,
      ...(inference.provider_key_id ? { provider_key_id: inference.provider_key_id } : {}),
    },
  });
  if (!provider.llm) {
    throw new TextralError(
      'PROVIDER_UNSUPPORTED_MODEL',
      400,
      `Judge requires LLM provider; ${inference.provider} has none`,
    );
  }
  const messages: ChatMessage[] = [{ role: 'user', content: filled }];
  const res = await provider.llm.chat(
    {
      model: inference.model,
      messages,
      max_tokens: 200,
      temperature: 0,
      response_format: { type: 'json_object' },
    },
    provider.options,
  );
  if (res.outcome === 'fatal_error' || res.outcome === 'retryable_error') {
    throw new TextralError(
      'EVAL_JUDGE_FAILED',
      500,
      res.error.safe_upstream_message ?? `Judge ${judge} failed (${res.error.type})`,
    );
  }
  const content = res.value.content.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TextralError('EVAL_JUDGE_FAILED', 500, `Judge ${judge} returned non-JSON: ${content.slice(0, 100)}`);
  }
  const obj = parsed as { score?: unknown; reasoning?: unknown };
  const score = typeof obj.score === 'number' ? Math.round(obj.score) : NaN;
  if (!(score >= 1 && score <= 5)) {
    throw new TextralError('EVAL_JUDGE_FAILED', 500, `Judge ${judge} score out of range: ${String(obj.score)}`);
  }
  return {
    score,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
  };
}

export const ALL_JUDGES: JudgeId[] = ['relevance', 'groundedness', 'citation_quality'];
