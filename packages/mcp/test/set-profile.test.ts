// Profile-control tool tests (Phase B.4). Exercises the two
// internal handlers (setProfile_handler / getProfile_handler) with
// fully-mocked profile state — no fs, no network. The
// description-interpolation pinning lives at the bottom.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TextralClient } from '@textral/sdk';
import {
  setProfile_handler,
  getProfile_handler,
  buildProfileControlTools,
  type ServerState,
  type ProfileBinding,
} from '../src/tools/profile-tools.js';
import type { Profile } from '../src/profiles.js';
import type { AuditWriter } from '../src/audit.js';

let tmpDir: string;

function fakeBinding(profile: Profile, runtime: 'cf' | 'node' = 'node'): ProfileBinding {
  const client = new TextralClient({
    baseUrl: profile.base_url,
    apiKey: profile.api_key,
    fetch: vi.fn(async () => new Response('null', { status: 200 })) as unknown as typeof globalThis.fetch,
  });
  const audit: AuditWriter = { record: vi.fn(async () => undefined) };
  return { profile, client, audit, runtime };
}

function makeState(initialProfile: Profile, available: string[]): ServerState {
  const cache = new Map<string, ProfileBinding>();
  const binding = fakeBinding(initialProfile);
  cache.set(initialProfile.name, binding);
  return {
    active: initialProfile.name,
    available,
    cache,
    materialize: vi.fn(async (p: Profile) => fakeBinding(p)),
  };
}

async function writeProfilesToml(content: string): Promise<void> {
  const path = join(tmpDir, 'profiles.toml');
  await writeFile(path, content, 'utf8');
  await chmod(path, 0o600);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'textral-mcp-set-profile-'));
  vi.stubEnv('TEXTRAL_CONFIG_DIR', tmpDir);
  vi.stubEnv('TEXTRAL_PROFILE', '');
  vi.stubEnv('TEXTRAL_BASE_URL', '');
  vi.stubEnv('TEXTRAL_API_KEY', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('setProfile_handler', () => {
  it('switching to the active profile is idempotent (cache hit)', async () => {
    const state = makeState(
      { name: 'a', base_url: 'http://a', api_key: 'tx_a' },
      ['a', 'b'],
    );
    await writeProfilesToml(`
[profiles.a]
base_url = "http://a"
api_key  = "tx_a"

[profiles.b]
base_url = "http://b"
api_key  = "tx_b"
`);
    const r = await setProfile_handler(state, 'a');
    expect(r.active_profile).toBe('a');
    expect(r.source).toBe('cache');
    // materialize was not called.
    expect((state.materialize as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('happy switch: state.active flips, binding cached', async () => {
    const state = makeState(
      { name: 'a', base_url: 'http://a', api_key: 'tx_a' },
      ['a', 'b'],
    );
    await writeProfilesToml(`
[profiles.a]
base_url = "http://a"
api_key  = "tx_a"

[profiles.b]
base_url = "http://b"
api_key  = "tx_b"
`);
    const r = await setProfile_handler(state, 'b');
    expect(r.active_profile).toBe('b');
    expect(r.source).toBe('fresh');
    expect(state.active).toBe('b');
    expect(state.cache.has('b')).toBe(true);
    expect((state.materialize as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('switching back uses the cache (no second materialize)', async () => {
    const state = makeState(
      { name: 'a', base_url: 'http://a', api_key: 'tx_a' },
      ['a', 'b'],
    );
    await writeProfilesToml(`
[profiles.a]
base_url = "http://a"
api_key  = "tx_a"

[profiles.b]
base_url = "http://b"
api_key  = "tx_b"
`);
    await setProfile_handler(state, 'b'); // materialize 'b'
    const r = await setProfile_handler(state, 'a'); // back to cached
    expect(r.active_profile).toBe('a');
    expect(r.source).toBe('cache');
    expect((state.materialize as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('throws on unknown profile, listing available; state unchanged', async () => {
    const state = makeState(
      { name: 'a', base_url: 'http://a', api_key: 'tx_a' },
      ['a', 'b'],
    );
    await writeProfilesToml(`
[profiles.a]
base_url = "http://a"
api_key  = "tx_a"

[profiles.b]
base_url = "http://b"
api_key  = "tx_b"
`);
    await expect(setProfile_handler(state, 'ghost')).rejects.toThrow(
      /Profile "ghost" not found.*Available: a, b/,
    );
    expect(state.active).toBe('a');
  });

  it('probe-failure rolls back: state.active preserved', async () => {
    const state = makeState(
      { name: 'a', base_url: 'http://a', api_key: 'tx_a' },
      ['a', 'broken'],
    );
    await writeProfilesToml(`
[profiles.a]
base_url = "http://a"
api_key  = "tx_a"

[profiles.broken]
base_url = "http://broken"
api_key  = "tx_broken"
`);
    state.materialize = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await expect(setProfile_handler(state, 'broken')).rejects.toThrow(
      /Failed to switch to profile "broken".*ECONNREFUSED.*Active profile remains "a"/,
    );
    expect(state.active).toBe('a');
    expect(state.cache.has('broken')).toBe(false);
  });

  it('refreshes available list on every switch (picks up file edits)', async () => {
    const state = makeState(
      { name: 'a', base_url: 'http://a', api_key: 'tx_a' },
      ['a'],
    );
    // File now has TWO profiles — the user added 'b' since startup.
    await writeProfilesToml(`
[profiles.a]
base_url = "http://a"
api_key  = "tx_a"

[profiles.b]
base_url = "http://b"
api_key  = "tx_b"
`);
    await setProfile_handler(state, 'b');
    expect(state.available.sort()).toEqual(['a', 'b']);
  });
});

describe('getProfile_handler', () => {
  it('returns the active binding + available list', () => {
    const state = makeState(
      { name: 'hosted-prod', base_url: 'https://example.com', api_key: 'tx' },
      ['hosted-prod', 'local'],
    );
    const r = getProfile_handler(state);
    expect(r.active_profile).toBe('hosted-prod');
    expect(r.base_url).toBe('https://example.com');
    expect(r.runtime).toBe('node');
    expect(r.available.sort()).toEqual(['hosted-prod', 'local']);
  });

  it('reflects the runtime of the cached binding', () => {
    const state = makeState(
      { name: 'a', base_url: 'http://a', api_key: 'tx' },
      ['a'],
    );
    // Replace with a CF-runtime binding to verify pass-through.
    state.cache.set('a', fakeBinding({ name: 'a', base_url: 'http://a', api_key: 'tx' }, 'cf'));
    const r = getProfile_handler(state);
    expect(r.runtime).toBe('cf');
  });
});

describe('buildProfileControlTools', () => {
  it('emits two tools with the expected names', () => {
    const state = makeState(
      { name: 'a', base_url: 'http://a', api_key: 'tx' },
      ['a', 'b'],
    );
    const tools = buildProfileControlTools(state);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['textral_get_profile', 'textral_set_profile']);
  });

  it('interpolates the available list into set_profile description', () => {
    const state = makeState(
      { name: 'a', base_url: 'http://a', api_key: 'tx' },
      ['hosted-prod', 'local-stage', 'local-prod'],
    );
    const tools = buildProfileControlTools(state);
    const setProfile = tools.find((t) => t.name === 'textral_set_profile')!;
    expect(setProfile.description).toContain('hosted-prod');
    expect(setProfile.description).toContain('local-stage');
    expect(setProfile.description).toContain('local-prod');
  });

  it('caps the available list at 5 in the description', () => {
    const many = Array.from({ length: 15 }, (_, i) => `profile-${String(i).padStart(2, '0')}`);
    const state = makeState(
      { name: 'profile-00', base_url: 'http://x', api_key: 'tx' },
      many,
    );
    const tools = buildProfileControlTools(state);
    const setProfile = tools.find((t) => t.name === 'textral_set_profile')!;
    expect(setProfile.description).toContain('… (15 total)');
    // First 5 are listed; later ones are not.
    expect(setProfile.description).toContain('profile-04');
    expect(setProfile.description).not.toContain('profile-12');
  });

  it('handles empty available list without throwing', () => {
    // Edge case: a synthetic _env-only state with no other profiles.
    const state = makeState(
      { name: '_env', base_url: 'http://x', api_key: 'tx' },
      ['_env'],
    );
    const tools = buildProfileControlTools(state);
    const setProfile = tools.find((t) => t.name === 'textral_set_profile')!;
    expect(setProfile.description).toContain('_env');
  });
});
