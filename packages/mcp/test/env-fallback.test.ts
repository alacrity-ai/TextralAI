// Backwards-compat tests (Phase B.5). The pre-V2 install pattern
// (TEXTRAL_BASE_URL + TEXTRAL_API_KEY env vars, no profile file)
// continues to work — the resolver synthesizes a `_env` profile and
// the server boots normally.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveActiveProfile } from '../src/profiles.js';
import {
  getProfile_handler,
  setProfile_handler,
  type ServerState,
} from '../src/tools/profile-tools.js';

let tmpDir: string;

function makeStateFromEnv(): ServerState {
  // Mirrors what buildInitialState would build for the synth case.
  // We don't actually probe /v1/me here — we stub the materialized
  // binding directly.
  const cache = new Map<string, ServerState['cache'] extends Map<string, infer V> ? V : never>();
  cache.set('_env', {
    profile: {
      name: '_env',
      base_url: process.env.TEXTRAL_BASE_URL!,
      api_key: process.env.TEXTRAL_API_KEY!,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: {} as any,
    audit: { record: vi.fn(async () => undefined) },
    runtime: 'cf',
  });
  return {
    active: '_env',
    available: ['_env'],
    cache,
    materialize: vi.fn(async () => {
      throw new Error('should not be called in _env-only mode');
    }),
  };
}

beforeEach(async () => {
  // Point at a directory with no profiles.toml so loadProfileFile
  // returns null and the resolver falls through to env-var synth.
  tmpDir = await mkdtemp(join(tmpdir(), 'textral-mcp-env-fallback-'));
  vi.stubEnv('TEXTRAL_CONFIG_DIR', tmpDir);
  vi.stubEnv('TEXTRAL_PROFILE', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('_env synth backwards compat', () => {
  it('resolveActiveProfile returns _env profile from env vars', async () => {
    vi.stubEnv('TEXTRAL_BASE_URL', 'http://localhost:8787');
    vi.stubEnv('TEXTRAL_API_KEY', 'tx_live_test');
    const r = await resolveActiveProfile();
    expect(r.source).toBe('env-vars-synth');
    expect(r.active.name).toBe('_env');
    expect(r.available).toEqual(['_env']);
  });

  it('textral_get_profile in _env mode returns active=_env, available=[_env]', () => {
    vi.stubEnv('TEXTRAL_BASE_URL', 'http://localhost:8787');
    vi.stubEnv('TEXTRAL_API_KEY', 'tx_live_test');
    const state = makeStateFromEnv();
    const r = getProfile_handler(state);
    expect(r.active_profile).toBe('_env');
    expect(r.available).toEqual(['_env']);
    expect(r.base_url).toBe('http://localhost:8787');
  });

  it('textral_set_profile to _env in _env mode is idempotent', async () => {
    vi.stubEnv('TEXTRAL_BASE_URL', 'http://localhost:8787');
    vi.stubEnv('TEXTRAL_API_KEY', 'tx_live_test');
    const state = makeStateFromEnv();
    const r = await setProfile_handler(state, '_env');
    expect(r.active_profile).toBe('_env');
    expect(r.source).toBe('cache');
    expect(state.active).toBe('_env');
  });

  it('textral_set_profile to non-_env in _env mode returns standard PROFILE_NOT_FOUND-style error', async () => {
    vi.stubEnv('TEXTRAL_BASE_URL', 'http://localhost:8787');
    vi.stubEnv('TEXTRAL_API_KEY', 'tx_live_test');
    const state = makeStateFromEnv();
    await expect(setProfile_handler(state, 'hosted-prod')).rejects.toThrow(
      /Profile "hosted-prod" not found.*Available: _env/,
    );
    // _env remains active.
    expect(state.active).toBe('_env');
  });
});
