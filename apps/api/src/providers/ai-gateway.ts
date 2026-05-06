// AI Gateway URL builder + per-request metadata header.
//
// V3 Phase 2: the gateway base URL is pre-built by the runtime
// (CF: `runtime/cf/bindings.ts`, Node: `runtime/node/bindings.ts`)
// and travels through `bindings.aiGateway`. This module just
// concatenates the provider segment.
//
// Each provider's "path" is its native endpoint, e.g. 'chat/completions'
// for OpenAI or 'v1/messages' for Anthropic.
//
// Per-tenant routing tags ride in the metadata header — `cf-aig-metadata`
// for Cloudflare AI Gateway, `x-aig-metadata` for non-CF proxies. The
// header name is `${cfg.metadata_header_prefix}metadata`; values coerce
// to strings via `String(v)` so callers can pass primitives, but only
// allowlisted keys are forwarded.

import type { AigMetadataValue, GatewayConfig } from './types.js';

export type { GatewayConfig };

export function gatewayBaseUrl(cfg: GatewayConfig): string {
  return `${cfg.base_url}/${cfg.provider}`;
}

/** Header name for AI Gateway per-request metadata. CF: `cf-aig-metadata`,
 *  Node: `x-aig-metadata`. */
export function gatewayMetadataHeader(cfg: GatewayConfig): string {
  return `${cfg.metadata_header_prefix}metadata`;
}

const AIG_METADATA_ALLOWLIST = new Set([
  'tenant_id',
  'namespace_id',
  'document_id',
  'version_id',
  'query_event_id',
  'job_id',
  'request_id',
  'provider_key_id',
]);

export function buildAigMetadata(parts: Record<string, AigMetadataValue>): string {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(parts)) {
    if (!AIG_METADATA_ALLOWLIST.has(k)) continue;
    if (v === null || v === undefined) continue;
    filtered[k] = String(v);
  }
  return JSON.stringify(filtered);
}
