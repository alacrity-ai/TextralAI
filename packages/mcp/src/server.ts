// MCP Server assembly. Same code serves both stdio and embedded HTTP
// transports — the bootstrap (in transport-stdio.ts /
// transport-http.ts) chooses how requests get to the Server's
// request handlers.
//
// V2 (Phase B) introduces multi-profile addressing. The stdio path
// builds a `MultiProfileServerOptions` with a `state` container and
// dispatches each tool call against the active profile's cached
// `(client, audit, runtime)` binding. The HTTP path stays
// stateless: it passes a single `ServerContext` and gets the
// pre-V2 dispatch behavior (with the profile-control tools omitted,
// since switching profiles mid-HTTP-request is meaningless).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { TextralClient } from '@textral/sdk';
import { allTools } from './tools/index.js';
import { allPrompts } from './prompts/index.js';
import { allResources } from './resources/index.js';
import { wrapWithAudit, type AuditWriter } from './audit.js';
import type { ToolDef } from './tools/types.js';
import {
  buildProfileControlTools,
  type ServerState,
  type ProfileBinding,
} from './tools/profile-tools.js';
import type { Profile, ResolvedActiveProfile } from './profiles.js';

export interface ServerContext {
  client: TextralClient;
  audit: AuditWriter;
  transport: 'stdio' | 'http';
}

export type { ServerState, ProfileBinding };

export interface MultiProfileServerOptions {
  state: ServerState;
}

/** Single-binding overload — used by the HTTP transport (stateless,
 *  one (client, audit) per request) and by older callers that pass
 *  through a fixed context. */
export function createServer(ctx: ServerContext): Server;
/** Multi-profile overload — used by the stdio transport. The server
 *  reads the active profile from `opts.state` on every tool call. */
export function createServer(opts: MultiProfileServerOptions): Server;
export function createServer(arg: ServerContext | MultiProfileServerOptions): Server {
  // Discriminate by the presence of the `state` field. Both shapes
  // have `client`/`audit` at the top level OR nested inside state.
  const isMulti = 'state' in arg;
  const state: ServerState | null = isMulti ? arg.state : null;
  const fixedCtx: ServerContext | null = isMulti ? null : arg;

  // Pull the current request's binding. For multi-profile, this
  // reads `state.active` and looks up the cached binding. For
  // single-binding, it returns the fixed ctx as a binding-shaped
  // adapter.
  const currentCtx = (): ServerContext => {
    if (state) {
      const binding = state.cache.get(state.active);
      if (!binding) {
        // Should be impossible — `state.active` is always one we've
        // materialized into the cache. Pin a clear error so a future
        // refactor doesn't silently misroute.
        throw new Error(
          `internal: active profile "${state.active}" not in cache`,
        );
      }
      return {
        client: binding.client,
        audit: binding.audit,
        transport: 'stdio',
      };
    }
    return fixedCtx!;
  };

  const server = new Server(
    { name: 'textral', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    },
  );

  // Build the tool list. Multi-profile mode prepends the two
  // profile-control tools so the LLM sees them first in the listing.
  const toolList: ToolDef[] = state
    ? [...buildProfileControlTools(state), ...allTools]
    : allTools;

  // ── tools ────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolList.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = toolList.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    const progressToken = req.params._meta?.progressToken;
    return await wrapWithAudit(currentCtx(), tool, req.params.arguments ?? {}, {
      ...(progressToken !== undefined ? { progressToken } : {}),
      sendProgress: extra.sendNotification,
      signal: extra.signal,
    });
  });

  // ── prompts ──────────────────────────────────────────────────────
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: allPrompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = allPrompts.find((p) => p.name === req.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${req.params.name}`);
    return prompt.render(req.params.arguments ?? {});
  });

  // ── resources ────────────────────────────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: allResources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const resource = allResources.find((r) => r.uri === req.params.uri);
    if (!resource) throw new Error(`Unknown resource: ${req.params.uri}`);
    const ctx = currentCtx();
    return await resource.read({ client: ctx.client });
  });

  return server;
}

// ── Helpers exported for the stdio transport ─────────────────────

/** Materializes a profile into a `(client, audit, runtime)` binding.
 *  Runs a `/v1/me` probe to determine the runtime; throws on failure
 *  (the caller is responsible for translating that into a
 *  user-visible error / rollback). */
export async function materializeProfile(
  profile: Profile,
  TextralClientCtor: new (opts: { baseUrl: string; apiKey: string }) => TextralClient,
  ApiAuditWriterCtor: new (client: TextralClient) => AuditWriter,
): Promise<ProfileBinding> {
  const client = new TextralClientCtor({
    baseUrl: profile.base_url,
    apiKey: profile.api_key,
  });
  const me = await client.me();
  const audit = new ApiAuditWriterCtor(client);
  return { profile, client, audit, runtime: me.runtime };
}

/** Builds the initial `ServerState` from a resolved active profile.
 *  Runs the active profile's `/v1/me` probe. Other profiles in the
 *  available list are not materialized until first switch. */
export async function buildInitialState(
  resolved: ResolvedActiveProfile,
  TextralClientCtor: new (opts: { baseUrl: string; apiKey: string }) => TextralClient,
  ApiAuditWriterCtor: new (client: TextralClient) => AuditWriter,
): Promise<ServerState> {
  const cache = new Map<string, ProfileBinding>();
  const active = await materializeProfile(
    resolved.active,
    TextralClientCtor,
    ApiAuditWriterCtor,
  );
  cache.set(active.profile.name, active);
  return {
    active: active.profile.name,
    available: resolved.available,
    cache,
    materialize: (p: Profile) =>
      materializeProfile(p, TextralClientCtor, ApiAuditWriterCtor),
  };
}
