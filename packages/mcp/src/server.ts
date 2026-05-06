// MCP Server assembly. Same code serves both stdio and embedded HTTP
// transports — the bootstrap (in transport-stdio.ts /
// transport-http.ts) chooses how requests get to the Server's
// request handlers.

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

export interface ServerContext {
  client: TextralClient;
  audit: AuditWriter;
  transport: 'stdio' | 'http';
}

export function createServer(ctx: ServerContext): Server {
  const server = new Server(
    { name: 'textral', version: '0.0.0' },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    },
  );

  // ── tools ────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = allTools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    const progressToken = req.params._meta?.progressToken;
    return await wrapWithAudit(ctx, tool, req.params.arguments ?? {}, {
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
    return await resource.read({ client: ctx.client });
  });

  return server;
}
