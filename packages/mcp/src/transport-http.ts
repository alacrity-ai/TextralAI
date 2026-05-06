// Embedded /mcp transport. Builds a fresh Server + WebStandard
// transport per request — stateless mode — and hands the request /
// response back to the caller (the Hono route in apps/api).
//
// Stateless because:
//   * Phase 1 ships only on the Node runtime; multiple workers may
//     handle the same MCP session in a horizontally-scaled deploy.
//   * Per-request boot is cheap (the Server is just a router).
//   * Operators can graduate to stateful + an EventStore in Phase 2
//     without changing the route shape.

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ServerContext } from './server.js';
import { createServer } from './server.js';

export async function handleHttpMcp(
  req: Request,
  ctx: ServerContext,
): Promise<Response> {
  const server = createServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session ID; each request is independent.
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Best-effort cleanup. The transport closes its streams on its
    // own when the response settles, but explicit close lets the
    // server detach handlers promptly.
    void server.close().catch(() => undefined);
  }
}
