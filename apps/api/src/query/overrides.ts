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
  if (r.prompt?.system !== undefined || r.prompt?.developer !== undefined) {
    out.prompt_defaults = {
      ...(r.prompt.system !== undefined ? { system: r.prompt.system } : {}),
      ...(r.prompt.developer !== undefined ? { developer: r.prompt.developer } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
