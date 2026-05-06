// MCP server registry assertions. Holds shape — a regression test
// guarding the 16-tool Phase 1 ship list. Adding/removing tools
// requires adjusting these counts.

import { describe, it, expect } from 'vitest';
import { allTools } from '../src/tools/index.js';
import { allPrompts } from '../src/prompts/index.js';
import { allResources } from '../src/resources/index.js';

describe('@textral/mcp registries', () => {
  it('ships exactly 16 tools', () => {
    expect(allTools).toHaveLength(16);
  });

  it('ships 3 workflow prompts', () => {
    expect(allPrompts).toHaveLength(3);
    const names = allPrompts.map((p) => p.name).sort();
    expect(names).toEqual(['compare_retrieval_configs', 'evaluate_namespace', 'ingest_directory']);
  });

  it('ships 3 resources', () => {
    expect(allResources).toHaveLength(3);
    const uris = allResources.map((r) => r.uri).sort();
    expect(uris).toEqual([
      'textral://error-catalog',
      'textral://openapi',
      'textral://profiles',
    ]);
  });

  it('every tool description is ≤200 chars (Open Question 4 lock)', () => {
    for (const t of allTools) {
      expect(t.description.length, t.name).toBeLessThanOrEqual(200);
    }
  });

  it('every tool inputSchema is JSON Schema 7 with additionalProperties: false', () => {
    for (const t of allTools) {
      const schema = t.inputSchema as Record<string, unknown>;
      expect(schema.type, t.name).toBe('object');
      // Some schemas (e.g. those wrapping unions) may set
      // additionalProperties at a nested level only; the top-level
      // ZodObject form should still set it false on the root object.
      if ('additionalProperties' in schema) {
        expect(schema.additionalProperties, t.name).toBe(false);
      }
    }
  });

  it('every tool name matches the expected ship list', () => {
    const names = allTools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'create_namespace',
        'get_chunk',
        'get_document',
        'get_namespace',
        'get_query_event',
        'get_query_response',
        'ingest_file',
        'list_chunks',
        'list_documents',
        'list_failing_jobs',
        'list_namespaces',
        'list_provider_keys',
        'list_query_events',
        'query',
        'register_provider_key',
        'retry_failing_job',
      ].sort(),
    );
  });
});
