// query_events writer.
//
// Insert-early at request entry; update through stages
// (received → retrieval_started → retrieval_completed → synthesis_started →
//  completed | failed). Failed queries appear in audit too.
//
// `request_config` redaction is determined by tenants.audit_mode:
//   full          — full request body persisted
//   redacted      — system/developer/query replaced with [REDACTED]
//   metadata_only — only structural fields preserved

import { newId } from '@textral/contracts';
import type { Env } from '../types.js';
import type { Db } from '../runtime/shared/interfaces.js';
import { getTenantAuditMode as getTenantAuditModeDb } from '../db/tenants.js';

const REDACTED_TOKEN = '[REDACTED]';

export type AuditMode = 'full' | 'redacted' | 'metadata_only';

export async function getTenantAuditMode(env: Env, tenantId: string): Promise<AuditMode> {
  return await getTenantAuditModeDb(env.db, tenantId);
}

export function redactRequestConfig(
  config: Record<string, unknown>,
  mode: AuditMode,
): Record<string, unknown> {
  if (mode === 'full') return config;
  if (mode === 'metadata_only') {
    const out: Record<string, unknown> = {};
    if ('namespace' in config) out.namespace = config.namespace;
    if ('document_ids' in config) out.document_ids = config.document_ids;
    if ('embedding' in config) out.embedding = pickProviderModel(config.embedding);
    if ('inference' in config) out.inference = pickProviderModel(config.inference);
    if ('retrieval' in config && typeof config.retrieval === 'object' && config.retrieval) {
      out.retrieval = { strategy: (config.retrieval as { strategy?: string }).strategy };
    }
    if ('output' in config && typeof config.output === 'object' && config.output) {
      out.output = { mode: (config.output as { mode?: string }).mode };
    }
    return out;
  }
  // redacted
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(config));
  if ('query' in out) out.query = REDACTED_TOKEN;
  if (out.prompt && typeof out.prompt === 'object') {
    const p = out.prompt as Record<string, unknown>;
    if ('system' in p) p.system = REDACTED_TOKEN;
    if ('developer' in p) p.developer = REDACTED_TOKEN;
  }
  if (out.output && typeof out.output === 'object') {
    const o = out.output as Record<string, unknown>;
    if ('schema' in o) o.schema = REDACTED_TOKEN;
  }
  return out;
}

function pickProviderModel(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as { provider?: string; model?: string };
  const out: Record<string, unknown> = {};
  if (r.provider !== undefined) out.provider = r.provider;
  if (r.model !== undefined) out.model = r.model;
  return out;
}

export async function hashRequestConfig(
  rawConfig: Record<string, unknown>,
  salt: string,
): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(salt + '|' + JSON.stringify(rawConfig));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface CreateEventArgs {
  tenant_id: string;
  namespace_id: string;
  query_text: string;
  request_config: Record<string, unknown>;
}

export async function insertQueryEvent(env: Env, args: CreateEventArgs): Promise<string> {
  const id = newId('qev');
  const mode = await getTenantAuditMode(env, args.tenant_id);
  const persisted = redactRequestConfig(args.request_config, mode);
  const salt = (env.AUDIT_HASH_SALT ?? '') + ':' + args.tenant_id;
  const hash = await hashRequestConfig(args.request_config, salt);
  const db: Db = env.db;
  await db.exec(
    `INSERT INTO query_events
       (id, tenant_id, namespace_id, status, query_text, request_config,
        request_config_hash, created_at)
     VALUES (?, ?, ?, 'received', ?, ?, ?, ?)`,
    [
      id,
      args.tenant_id,
      args.namespace_id,
      mode === 'redacted' || mode === 'metadata_only' ? REDACTED_TOKEN : args.query_text,
      JSON.stringify(persisted),
      hash,
      Date.now(),
    ],
  );
  return id;
}

export interface UpdateEventStatusArgs {
  status:
    | 'retrieval_started'
    | 'retrieval_completed'
    | 'synthesis_started'
    | 'completed'
    | 'failed';
  retrieval_status?: string | null;
  citation_integrity?: string | null;
  synthesis_status?: string | null;
  embedding_profile_used?: string | null;
  chunking_profile_used?: string | null;
  inference_model_used?: string | null;
  inference_provider?: string | null;
  provider_key_id?: string | null;
  retrieval_strategy?: string | null;
  candidates_returned?: number | null;
  dense_candidates_returned?: number | null;
  sparse_candidates_returned?: number | null;
  embedding_missing_count?: number | null;
  citations_returned?: number | null;
  dropped_citations?: number[] | null;
  degradation_level?: string | null;
  latency_ms?: number | null;
  embedding_input_tokens?: number | null;
  synthesis_input_tokens?: number | null;
  synthesis_output_tokens?: number | null;
  context_tokens?: number | null;
  answer_r2_key?: string | null;
  mirror_error?: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

export async function updateQueryEvent(
  env: Env,
  id: string,
  patch: UpdateEventStatusArgs,
): Promise<void> {
  const fields: string[] = ['status = ?'];
  const values: unknown[] = [patch.status];
  const set = (col: string, v: unknown): void => {
    if (v === undefined) return;
    fields.push(`${col} = ?`);
    values.push(v);
  };
  set('retrieval_status', patch.retrieval_status);
  set('citation_integrity', patch.citation_integrity);
  set('synthesis_status', patch.synthesis_status);
  set('embedding_profile_used', patch.embedding_profile_used);
  set('chunking_profile_used', patch.chunking_profile_used);
  set('inference_model_used', patch.inference_model_used);
  set('inference_provider', patch.inference_provider);
  set('provider_key_id', patch.provider_key_id);
  set('retrieval_strategy', patch.retrieval_strategy);
  set('candidates_returned', patch.candidates_returned);
  set('dense_candidates_returned', patch.dense_candidates_returned);
  set('sparse_candidates_returned', patch.sparse_candidates_returned);
  set('embedding_missing_count', patch.embedding_missing_count);
  set('citations_returned', patch.citations_returned);
  set(
    'dropped_citations',
    patch.dropped_citations ? JSON.stringify(patch.dropped_citations) : undefined,
  );
  set('degradation_level', patch.degradation_level);
  set('latency_ms', patch.latency_ms);
  set('embedding_input_tokens', patch.embedding_input_tokens);
  set('synthesis_input_tokens', patch.synthesis_input_tokens);
  set('synthesis_output_tokens', patch.synthesis_output_tokens);
  set('context_tokens', patch.context_tokens);
  set('answer_r2_key', patch.answer_r2_key);
  set('mirror_error', patch.mirror_error);
  set('error_code', patch.error_code);
  set('error_message', patch.error_message);
  if (patch.status === 'completed' || patch.status === 'failed') {
    fields.push('completed_at = ?');
    values.push(Date.now());
  }
  values.push(id);
  await env.db.exec(
    `UPDATE query_events SET ${fields.join(', ')} WHERE id = ?`,
    values,
  );
}

/** R2 mirror — best-effort. Records `answer_r2_key` on success, or
 *  `mirror_error` on failure; never blocks the response. */
export async function mirrorAnswer(
  env: Env,
  args: {
    query_event_id: string;
    tenant_id: string;
    namespace_id: string;
    payload: unknown;
  },
): Promise<{ ok: boolean; key?: string; error?: string }> {
  const key = `${args.tenant_id}/${args.namespace_id}/answers/${args.query_event_id}.json`;
  try {
    await env.blobs.put(key, JSON.stringify(args.payload), {
      contentType: 'application/json',
    });
    return { ok: true, key };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
