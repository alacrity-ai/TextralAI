// Audit-per-profile regression guard (Phase B.6).
//
// Each materialized profile owns its own ApiAuditWriter instance,
// constructed against that profile's TextralClient. After
// textral_set_profile flips the active profile, tool calls dispatched
// through wrapWithAudit must read their `audit` from the active
// binding — not from a stale closure-captured one.
//
// We exercise the end-to-end: switch profile A → run tool, assert
// only A's writer captured the row. Switch to B → run tool, assert
// only B's writer captured the row. No cross-pollination.

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { TextralClient } from '@textral/sdk';
import { wrapWithAudit, type AuditEvent, type AuditWriter } from '../src/audit.js';
import { defineTool } from '../src/tools/types.js';
import {
  setProfile_handler,
  type ServerState,
  type ProfileBinding,
} from '../src/tools/profile-tools.js';
import type { Profile } from '../src/profiles.js';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach } from 'vitest';

let tmpDir: string;

function bindingFor(profile: Profile, runtime: 'cf' | 'node' = 'node'): {
  binding: ProfileBinding;
  events: AuditEvent[];
} {
  const events: AuditEvent[] = [];
  const audit: AuditWriter = {
    record: async (e: AuditEvent) => {
      events.push(e);
    },
  };
  const client = new TextralClient({
    baseUrl: profile.base_url,
    apiKey: profile.api_key,
    fetch: vi.fn(async () => new Response('null', { status: 200 })) as unknown as typeof globalThis.fetch,
  });
  return { binding: { profile, client, audit, runtime }, events };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'textral-mcp-audit-perprofile-'));
  vi.stubEnv('TEXTRAL_CONFIG_DIR', tmpDir);
  vi.stubEnv('TEXTRAL_PROFILE', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('audit per profile', () => {
  it('a tool call dispatches to the active profile\'s writer', async () => {
    // Two pre-cached profiles.
    const a = bindingFor({ name: 'a', base_url: 'http://a', api_key: 'tx_a' });
    const b = bindingFor({ name: 'b', base_url: 'http://b', api_key: 'tx_b' });
    const state: ServerState = {
      active: 'a',
      available: ['a', 'b'],
      cache: new Map([
        ['a', a.binding],
        ['b', b.binding],
      ]),
      materialize: vi.fn(async () => {
        throw new Error('should not be called — both profiles pre-cached');
      }),
    };

    const tool = defineTool({
      name: 'noop',
      description: 'noop',
      inputSchemaZod: z.object({}),
      handler: async () => ({ ok: true }),
    });

    const ctrl = new AbortController();

    // Active = a. First tool call should land in a.events only.
    let active = state.cache.get(state.active)!;
    await wrapWithAudit(
      { client: active.client, audit: active.audit, transport: 'stdio' },
      tool,
      {},
      { signal: ctrl.signal },
    );
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(0);

    // Write profiles file for the set_profile path; both already cached
    // so materialize() is not called.
    await writeFile(
      join(tmpDir, 'profiles.toml'),
      `
[profiles.a]
base_url = "http://a"
api_key  = "tx_a"

[profiles.b]
base_url = "http://b"
api_key  = "tx_b"
`,
      'utf8',
    );
    await chmod(join(tmpDir, 'profiles.toml'), 0o600);

    // Switch to b.
    await setProfile_handler(state, 'b');
    expect(state.active).toBe('b');

    // Second tool call should land in b.events only.
    active = state.cache.get(state.active)!;
    await wrapWithAudit(
      { client: active.client, audit: active.audit, transport: 'stdio' },
      tool,
      {},
      { signal: ctrl.signal },
    );
    expect(a.events).toHaveLength(1); // unchanged
    expect(b.events).toHaveLength(1);
  });

  it('switching profile mid-stream does NOT redirect an in-flight call', async () => {
    // The tool handler captures the binding reference at entry. A
    // mid-call profile switch (which JavaScript's single-threaded
    // event loop only "sees" between awaits anyway) cannot redirect
    // an audit row to a different profile's writer.
    const a = bindingFor({ name: 'a', base_url: 'http://a', api_key: 'tx_a' });
    const b = bindingFor({ name: 'b', base_url: 'http://b', api_key: 'tx_b' });
    const state: ServerState = {
      active: 'a',
      available: ['a', 'b'],
      cache: new Map([
        ['a', a.binding],
        ['b', b.binding],
      ]),
      materialize: vi.fn(async () => {
        throw new Error('should not be called — both profiles pre-cached');
      }),
    };

    let resolveTool!: (v: unknown) => void;
    const slowTool = defineTool({
      name: 'slow',
      description: 'slow',
      inputSchemaZod: z.object({}),
      handler: () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveTool = resolve as (v: unknown) => void;
        }),
    });

    const ctrl = new AbortController();
    // Snapshot the active binding at entry; this is what server.ts's
    // currentCtx() does in production.
    const entryBinding = state.cache.get(state.active)!;
    const inFlight = wrapWithAudit(
      { client: entryBinding.client, audit: entryBinding.audit, transport: 'stdio' },
      slowTool,
      {},
      { signal: ctrl.signal },
    );

    // While the tool is pending, switch to profile b.
    await writeFile(
      join(tmpDir, 'profiles.toml'),
      `
[profiles.a]
base_url = "http://a"
api_key  = "tx_a"

[profiles.b]
base_url = "http://b"
api_key  = "tx_b"
`,
      'utf8',
    );
    await chmod(join(tmpDir, 'profiles.toml'), 0o600);
    await setProfile_handler(state, 'b');
    expect(state.active).toBe('b');

    // Now finish the tool. Audit row should land in profile a's writer
    // (the one we snapshotted at entry), not b's.
    resolveTool({ ok: true });
    await inFlight;
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(0);
  });
});
