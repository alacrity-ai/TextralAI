// MCP cookbook validator — sister to apps/api/scripts/validate-cookbook.ts.
//
// Drives the @textral/mcp server through canonical agent flows over
// either transport. Used by CI (embedded transport) and the local
// `make mcp-validate` target. Exit code is non-zero on any phase
// failure.
//
// Usage:
//   tsx tools/mcp-cookbook-validator.ts --transport=http
//   tsx tools/mcp-cookbook-validator.ts --transport=stdio
//
// Required env:
//   TEXTRAL_BASE_URL    e.g. http://localhost:8787
//   TEXTRAL_API_KEY     a tenant-scoped key with `*` scope
// Optional:
//   COOKBOOK_NAMESPACE  default: cookbook-mcp
//
// The cookbook fixture (a small markdown file ingested into
// $COOKBOOK_NAMESPACE) is provisioned by make selfhost-seed-cookbook
// before this script runs.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const baseUrl = (process.env.TEXTRAL_BASE_URL ?? '').replace(/\/$/, '');
const apiKey = process.env.TEXTRAL_API_KEY ?? '';
const namespace = process.env.COOKBOOK_NAMESPACE ?? 'cookbook-mcp';

if (!baseUrl || !apiKey) {
  console.error('TEXTRAL_BASE_URL and TEXTRAL_API_KEY must be set.');
  process.exit(2);
}

const transportArg = (() => {
  const i = process.argv.indexOf('--transport');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  const eq = process.argv.find((a) => a.startsWith('--transport='));
  if (eq) return eq.split('=')[1]!;
  return 'http';
})() as 'http' | 'stdio';

console.log(`MCP cookbook validator: transport=${transportArg} namespace=${namespace}`);

// SDK transport types use non-exact-optional sessionId; widen at the
// boundary so call sites stay clean under exactOptionalPropertyTypes.
type ClientTransportArg = Parameters<Client['connect']>[0];

async function buildTransport(): Promise<ClientTransportArg> {
  if (transportArg === 'stdio') {
    const here = dirname(fileURLToPath(import.meta.url));
    const cliPath = resolve(here, '..', '..', 'packages', 'mcp', 'bin', 'textral-mcp.mjs');
    return new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      env: {
        ...process.env,
        TEXTRAL_BASE_URL: baseUrl,
        TEXTRAL_API_KEY: apiKey,
      } as Record<string, string>,
    }) as unknown as ClientTransportArg;
  }
  const url = new URL(`${baseUrl}/v1/mcp`);
  return new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { 'X-Textral-Api-Key': apiKey },
    },
  }) as unknown as ClientTransportArg;
}

interface ToolText {
  text: string;
  parsed: unknown;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolText> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) {
    const text =
      Array.isArray(res.content) && res.content[0] && 'text' in res.content[0]
        ? String(res.content[0].text)
        : 'unknown tool error';
    throw new Error(`${name} failed: ${text}`);
  }
  const block =
    Array.isArray(res.content) && res.content[0] && 'text' in res.content[0]
      ? String(res.content[0].text)
      : '';
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(block);
  } catch {
    parsed = block;
  }
  return { text: block, parsed };
}

interface Phase {
  name: string;
  run: (client: Client) => Promise<void>;
}

const PHASES: Phase[] = [
  {
    name: 'phase 1 — namespaces visible',
    run: async (client) => {
      const r = await callTool(client, 'list_namespaces', {});
      const data = (r.parsed as { data?: Array<{ slug: string }> }).data ?? [];
      const found = data.some((n) => n.slug === namespace);
      if (!found) {
        throw new Error(
          `namespace "${namespace}" not found in tenant. Run \`make selfhost-seed-cookbook\` first.`,
        );
      }
    },
  },
  {
    name: 'phase 2 — query yields a citation-grounded answer',
    run: async (client) => {
      const r = await callTool(client, 'query', {
        namespace,
        query: 'What does the cookbook fixture cover?',
        embedding: {
          provider: 'openai',
          model: 'text-embedding-3-large',
          dimensions: 1536,
          provider_key_ref: 'default',
        },
        inference: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          provider_key_ref: 'default',
        },
        retrieval: { strategy: 'hybrid_rrf', top_k_dense: 5, top_k_sparse: 5 },
      });
      const resp = r.parsed as {
        degradation_level?: string;
        citations?: unknown[];
        query_event_id?: string;
      };
      if (resp.degradation_level === 'cannot_answer') {
        throw new Error('query degraded to cannot_answer');
      }
      if (!resp.query_event_id) {
        throw new Error('query did not return a query_event_id');
      }
    },
  },
  {
    name: 'phase 3 — recent query event listable',
    run: async (client) => {
      const r = await callTool(client, 'list_query_events', { limit: 5, namespace_slug: namespace });
      const data = (r.parsed as { data?: unknown[] }).data ?? [];
      if (data.length === 0) {
        throw new Error('list_query_events returned 0 events for the cookbook namespace');
      }
    },
  },
  {
    name: 'phase 4 — last query response replays',
    run: async (client) => {
      const list = await callTool(client, 'list_query_events', { limit: 1, namespace_slug: namespace });
      const first = ((list.parsed as { data?: Array<{ id: string }> }).data ?? [])[0];
      if (!first) throw new Error('no query event to replay');
      const replay = await callTool(client, 'get_query_response', { id: first.id });
      const resp = replay.parsed as { answer?: { mode?: string }; degradation_level?: string };
      if (!resp.answer || !resp.degradation_level) {
        throw new Error('get_query_response did not return mirrored answer');
      }
    },
  },
  {
    name: 'phase 5 — namespace documents listable',
    run: async (client) => {
      const r = await callTool(client, 'list_documents', { namespace, limit: 5 });
      const data = (r.parsed as { data?: unknown[] }).data ?? [];
      if (data.length === 0) {
        throw new Error('list_documents returned empty set for cookbook namespace');
      }
    },
  },
  {
    name: 'phase 6 — first document chunks listable + first chunk fetchable',
    run: async (client) => {
      const docs = await callTool(client, 'list_documents', { namespace, limit: 1 });
      const first = ((docs.parsed as { data?: Array<{ id: string }> }).data ?? [])[0];
      if (!first) throw new Error('no document to enumerate');
      const chunks = await callTool(client, 'list_chunks', { document_id: first.id, limit: 5 });
      const chunkData = ((chunks.parsed as { data?: Array<{ id: string }> }).data ?? []);
      if (chunkData.length === 0) {
        throw new Error('list_chunks returned empty page');
      }
      const chunk = await callTool(client, 'get_chunk', { id: chunkData[0]!.id });
      if (!('parsed' in chunk) || chunk.parsed === null) {
        throw new Error('get_chunk returned empty body');
      }
    },
  },
];

async function main(): Promise<void> {
  const transport = await buildTransport();
  const client = new Client(
    { name: 'textral-cookbook-validator', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  let failures = 0;
  for (const phase of PHASES) {
    process.stdout.write(`  ${phase.name} ... `);
    try {
      await phase.run(client);
      console.log('ok');
    } catch (e) {
      failures += 1;
      console.log(`FAIL — ${(e as Error).message}`);
    }
  }
  await client.close();

  if (failures > 0) {
    console.error(`\n${failures} phase(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll phases passed.');
}

void main().catch((e) => {
  console.error('validator crashed:', e);
  process.exit(2);
});
