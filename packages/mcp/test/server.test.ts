// MCP server registry assertions. Holds shape — a regression test
// guarding the Phase 1 ship list. Adding/removing tools requires
// adjusting these counts.

import { describe, it, expect } from 'vitest';
import { allTools } from '../src/tools/index.js';
import { allPrompts } from '../src/prompts/index.js';
import { allResources } from '../src/resources/index.js';

describe('@textral/mcp registries', () => {
  it('ships exactly 24 tools', () => {
    expect(allTools).toHaveLength(24);
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
      // Most tools are top-level objects. Discriminated unions
      // (e.g. `ingest_local_paths`) emit a top-level `oneOf` whose
      // branches are each `type: 'object'`. Both shapes are valid
      // JSON Schema 7 — the assertion forks on which form we got.
      const branches =
        (Array.isArray(schema.oneOf) ? schema.oneOf : null) ??
        (Array.isArray(schema.anyOf) ? schema.anyOf : null);
      if (branches) {
        for (const branch of branches as Record<string, unknown>[]) {
          expect(branch.type, t.name).toBe('object');
          if ('additionalProperties' in branch) {
            expect(branch.additionalProperties, t.name).toBe(false);
          }
        }
      } else {
        expect(schema.type, t.name).toBe('object');
        if ('additionalProperties' in schema) {
          expect(schema.additionalProperties, t.name).toBe(false);
        }
      }
    }
  });

  it('every tool name matches the expected ship list', () => {
    const names = allTools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'cancel_bulk_ingest_job',
        'create_namespace',
        'get_bulk_ingest_job',
        'get_chunk',
        'get_document',
        'get_namespace',
        'get_query_event',
        'get_query_response',
        'ingest_file',
        'ingest_local_paths',
        'list_chunks',
        'list_documents',
        'list_failing_jobs',
        'list_infra_keys',
        'list_models',
        'list_namespaces',
        'list_provider_keys',
        'list_query_events',
        'query',
        'register_infra_key',
        'register_provider_key',
        'retry_failing_job',
        'revoke_infra_key',
        'test_infra_key',
      ].sort(),
    );
  });
});
