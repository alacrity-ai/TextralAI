// Stdio transport entry point.
//
// Boots the MCP server with profile-aware state. Resolution chain
// lives in `profiles.ts` (`resolveActiveProfile()`). The active
// profile's binding is materialized at startup (one `/v1/me` probe);
// other profiles are materialized lazily on first switch.
//
// Backwards-compat: when called with `{ baseUrl, apiKey }`, behaves
// like the pre-V2 single-binding boot. The bin shim still calls this
// form during the transition; once Phase B.3 ships fully, the shim
// can call `startStdio()` no-args and let the resolver pick.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TextralClient } from '@textral/sdk';
import { createServer, buildInitialState } from './server.js';
import { ApiAuditWriter } from './audit.js';
import { resolveActiveProfile } from './profiles.js';

export interface StdioOptions {
  /** Single-binding override. When provided, the server boots with a
   *  one-shot `_env` profile and skips the file-resolution chain.
   *  Used by the bin shim's pre-V2 env-var path. */
  baseUrl?: string;
  apiKey?: string;
}

export async function startStdio(opts: StdioOptions = {}): Promise<void> {
  // If the shim pre-resolved env vars, skip the file chain and synth
  // a one-shot resolved profile. This preserves the bin shim's
  // "Phase 1" behavior while we transition.
  let resolved;
  if (opts.baseUrl && opts.apiKey) {
    resolved = {
      active: { name: '_env', base_url: opts.baseUrl, api_key: opts.apiKey },
      available: ['_env'],
      source: 'env-vars-synth' as const,
    };
  } else {
    resolved = await resolveActiveProfile();
  }

  // One-line stderr trace so operators can confirm the active profile
  // without having to run textral_get_profile.
  console.error(
    `[textral-mcp] active profile: ${resolved.active.name} (${resolved.active.base_url})`,
  );

  const state = await buildInitialState(resolved, TextralClient, ApiAuditWriter);

  const server = createServer({ state });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
