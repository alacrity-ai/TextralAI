import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TextralClient } from '@textral/sdk';
import { createServer } from './server.js';
import { ApiAuditWriter } from './audit.js';

export interface StdioOptions {
  baseUrl: string;
  apiKey: string;
}

export async function startStdio(opts: StdioOptions): Promise<void> {
  const client = new TextralClient({ baseUrl: opts.baseUrl, apiKey: opts.apiKey });
  const audit = new ApiAuditWriter(client);
  const server = createServer({ client, audit, transport: 'stdio' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
