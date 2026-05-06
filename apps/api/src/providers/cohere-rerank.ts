// Cohere rerank provider.
//
// Cohere's rerank API:
//   POST https://api.cohere.com/v2/rerank
//   { query, documents, top_n, model }
// Auth: Authorization: Bearer <key>
// Response: { results: [{ index, relevance_score }] }
//
// Same hardened validation contract as Voyage — see voyage-rerank.ts.

import { ProviderHttpClient } from './lib/http-client.js';
import { classifyOpenAIError, parseRetryAfter } from './error-classification.js';
import { redact } from '../middleware/redaction.js';
import type {
  ProviderError,
  ProviderOptions,
  ProviderResult,
  RerankProvider,
  RerankRequest,
  RerankResponse,
} from './types.js';

interface CohereBody {
  results?: Array<{ index?: unknown; relevance_score?: unknown }>;
}

export class CohereRerankProvider extends ProviderHttpClient implements RerankProvider {
  public override readonly name = 'cohere';

  protected directBaseUrl(_model: string): string {
    return 'https://api.cohere.com/v2';
  }

  async rerank(req: RerankRequest, opts: ProviderOptions): Promise<ProviderResult<RerankResponse>> {
    return this.withRetries<RerankResponse>({
      model: req.model,
      timeoutMs: 8_000,
      opts,
      call: () =>
        this.post(
          req.model,
          'rerank',
          {
            query: req.query,
            documents: req.documents,
            model: req.model,
            ...(req.top_n !== undefined ? { top_n: req.top_n } : {}),
          },
          opts,
          8_000,
        ),
      parseSuccess: (res, attempt) => parseCohereRerank(this.name, req, res.body, attempt),
      classifyError: (res, attempt) => {
        const cls = classifyOpenAIError({
          status: res.status,
          body: res.body,
          text: res.text,
        });
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        return {
          type: cls.type,
          provider: this.name,
          model: req.model,
          status: res.status,
          retry_count: attempt,
          ...(cls.upstream_code ? { upstream_code: cls.upstream_code } : {}),
          ...(cls.upstream_message ? { safe_upstream_message: redact(cls.upstream_message) } : {}),
          ...(retryAfter !== undefined ? { retry_after_ms: retryAfter } : {}),
        };
      },
    });
  }
}

function parseCohereRerank(
  providerName: string,
  req: RerankRequest,
  body: unknown,
  attempt: number,
):
  | { ok: true; value: RerankResponse; warning?: ProviderError }
  | { ok: false; error: ProviderError } {
  const data = (body as CohereBody | null)?.results;
  if (!Array.isArray(data)) {
    return {
      ok: false,
      error: {
        type: 'malformed_response',
        provider: providerName,
        model: req.model,
        retry_count: attempt,
        safe_upstream_message: 'rerank response missing `results` array',
      },
    };
  }

  const n = req.documents.length;
  const seen = new Set<number>();
  const results: { index: number; score: number }[] = [];
  for (const r of data) {
    if (!r || typeof r !== 'object') continue;
    const idx = (r as { index?: unknown }).index;
    const score = (r as { relevance_score?: unknown }).relevance_score;
    if (!Number.isInteger(idx) || (idx as number) < 0 || (idx as number) >= n) {
      return {
        ok: false,
        error: {
          type: 'malformed_response',
          provider: providerName,
          model: req.model,
          retry_count: attempt,
          safe_upstream_message: `rerank index out of range: ${String(idx)} (input size ${n})`,
        },
      };
    }
    if (typeof score !== 'number' || Number.isNaN(score)) {
      return {
        ok: false,
        error: {
          type: 'malformed_response',
          provider: providerName,
          model: req.model,
          retry_count: attempt,
          safe_upstream_message: `rerank relevance_score is not a number: ${String(score)}`,
        },
      };
    }
    if (seen.has(idx as number)) continue;
    seen.add(idx as number);
    results.push({ index: idx as number, score });
  }

  if (results.length === 0) {
    return {
      ok: false,
      error: {
        type: 'malformed_response',
        provider: providerName,
        model: req.model,
        retry_count: attempt,
        safe_upstream_message: 'rerank produced 0 valid results',
      },
    };
  }

  results.sort((a, b) => b.score - a.score);
  const value: RerankResponse = { results, model: req.model };

  const topN = req.top_n;
  if (topN !== undefined && results.length < topN) {
    return {
      ok: true,
      value,
      warning: {
        type: 'partial_batch',
        provider: providerName,
        model: req.model,
        retry_count: attempt,
        safe_upstream_message: `requested top_n=${topN}, got ${results.length}`,
      },
    };
  }
  return { ok: true, value };
}

export const cohereRerank = new CohereRerankProvider();
