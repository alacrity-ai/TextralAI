// Reshape the query request body into the partial-profile shape
// mergeProfile understands. Only the structural-default fields
// (retrieval, prompt, context.layer_budgets) flow into the profile;
// embedding/inference/output/query/document_ids stay as request fields
// the handler reads directly.

import type { CorpusProfileOverride } from '@textral/corpus-profiles';

interface OverridableBody {
  retrieval?: {
    strategy?: 'hybrid_rrf';
    artifact_types?: string[];
    rerank?: {
      enabled?: boolean;
      provider?: 'voyage' | 'cohere';
      model?: string;
      top_n?: number;
      provider_key_ref?: string;
      // provider_key_id is intentionally NOT forwarded — it's a runtime
      // concern (which BYOK row to fetch) and shouldn't bleed into the
      // merged corpus-profile shape. The query handler reads it
      // directly from the request body when resolving the rerank key.
    };
  };
  prompt?: { system?: string; developer?: string };
  context?: { layer_budgets?: Record<string, number>; layer_order?: string[] };
}

export function extractProfileOverrides(
  body: Record<string, unknown>,
): CorpusProfileOverride | undefined {
  const r = body as OverridableBody;
  const out: CorpusProfileOverride = {};
  if (r.retrieval?.artifact_types) {
    out.retrieval_defaults = {
      ...(out.retrieval_defaults ?? {}),
      artifact_types: r.retrieval.artifact_types,
    };
  }
  if (r.context?.layer_budgets) {
    out.retrieval_defaults = {
      ...(out.retrieval_defaults ?? {}),
      layer_budgets: r.context.layer_budgets,
    };
  }
  if (r.context?.layer_order) {
    out.retrieval_defaults = {
      ...(out.retrieval_defaults ?? {}),
      layer_order: r.context.layer_order,
    };
  }
  if (r.retrieval?.rerank) {
    const { enabled, provider, model, top_n, provider_key_ref } = r.retrieval.rerank;
    const rerankOverride: NonNullable<
      NonNullable<CorpusProfileOverride['retrieval_defaults']>['rerank']
    > = {};
    if (enabled !== undefined) rerankOverride.enabled = enabled;
    if (provider !== undefined) rerankOverride.provider = provider;
    if (model !== undefined) rerankOverride.model = model;
    if (top_n !== undefined) rerankOverride.top_n = top_n;
    if (provider_key_ref !== undefined) rerankOverride.provider_key_ref = provider_key_ref;
    if (Object.keys(rerankOverride).length > 0) {
      out.retrieval_defaults = {
        ...(out.retrieval_defaults ?? {}),
        rerank: rerankOverride,
      };
    }
  }
  if (r.prompt?.system !== undefined || r.prompt?.developer !== undefined) {
    out.prompt_defaults = {
      ...(r.prompt.system !== undefined ? { system: r.prompt.system } : {}),
      ...(r.prompt.developer !== undefined ? { developer: r.prompt.developer } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
