// Map a historical /v1/query body (stored on a query_events row's
// request_config) into a Partial<QueryFormState> the QueryForm can
// hydrate from. Defensive about missing/malformed fields — every
// branch falls back to the form's static defaults.

import type { ProviderName } from '../api/types.js';
import type { QueryFormState } from './QueryForm.js';

type Json = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
function asProvider(v: unknown): ProviderName | undefined {
  if (typeof v !== 'string') return undefined;
  if (v === 'openai' || v === 'anthropic' || v === 'cohere' || v === 'voyage' || v === 'workers_ai') {
    return v;
  }
  return undefined;
}

function obj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

/** Convert a stored request_config blob into a Partial<QueryFormState>.
 *  Only sets keys it can confidently extract; the form merges this on
 *  top of DEFAULTS, so missing keys fall back cleanly. */
export function requestConfigToFormState(
  requestConfig: unknown,
  fallbackQuery: string,
): Partial<QueryFormState> {
  const out: Partial<QueryFormState> = {};
  const cfg = obj(requestConfig);
  if (!cfg) return { query: fallbackQuery };

  // query
  out.query = asString(cfg.query) ?? fallbackQuery;

  // document_ids: stored as string[] on the request body; the form
  // shows a comma-separated input.
  if (Array.isArray(cfg.document_ids)) {
    out.document_ids = cfg.document_ids.filter((x) => typeof x === 'string').join(', ');
  }

  const emb = obj(cfg.embedding);
  if (emb) {
    const provider = asProvider(emb.provider);
    if (provider) out.embedding_provider = provider;
    const model = asString(emb.model);
    if (model) out.embedding_model = model;
    const dims = asNumber(emb.dimensions);
    if (dims) out.embedding_dimensions = dims;
    const ref = asString(emb.provider_key_ref);
    if (ref) out.embedding_provider_key_ref = ref;
  }

  const inf = obj(cfg.inference);
  if (inf) {
    const provider = asProvider(inf.provider);
    if (provider) out.inference_provider = provider;
    const model = asString(inf.model);
    if (model) out.inference_model = model;
    const ref = asString(inf.provider_key_ref);
    if (ref) out.inference_provider_key_ref = ref;
    const maxTok = asNumber(inf.max_output_tokens);
    if (maxTok) out.inference_max_output_tokens = maxTok;
    const temp = asNumber(inf.temperature);
    if (temp !== undefined) out.inference_temperature = temp;
  }

  const ret = obj(cfg.retrieval);
  if (ret) {
    if (asString(ret.strategy) === 'hybrid_rrf') out.retrieval_strategy = 'hybrid_rrf';
    const td = asNumber(ret.top_k_dense);
    if (td) out.retrieval_top_k_dense = td;
    const ts = asNumber(ret.top_k_sparse);
    if (ts) out.retrieval_top_k_sparse = ts;
    const rk = asNumber(ret.rrf_k);
    if (rk) out.retrieval_rrf_k = rk;
    if (Array.isArray(ret.artifact_types)) {
      out.retrieval_artifact_types = ret.artifact_types
        .filter((x) => typeof x === 'string')
        .join(', ');
    }
    const req = asBool(ret.require_citations);
    if (req !== undefined) out.retrieval_require_citations = req;
  }

  const ctx = obj(cfg.context);
  if (ctx) {
    const m = asNumber(ctx.max_context_tokens);
    if (m) out.context_max_tokens = m;
  }

  const prm = obj(cfg.prompt);
  if (prm) {
    const sys = asString(prm.system);
    if (sys !== undefined) out.prompt_system = sys;
    const dev = asString(prm.developer);
    if (dev !== undefined) out.prompt_developer = dev;
  }

  const outCfg = obj(cfg.output);
  if (outCfg) {
    if (outCfg.mode === 'structured') {
      out.output_mode = 'structured';
      const schema = obj(outCfg.schema);
      if (schema) out.output_schema = JSON.stringify(schema, null, 2);
    } else if (outCfg.mode === 'text') {
      out.output_mode = 'text';
    }
  }

  return out;
}
