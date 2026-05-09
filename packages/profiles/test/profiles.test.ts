// @textral/profiles unit tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadProfileFile,
  resolveActiveProfile,
  resolveProfile,
  configPath,
  TextralProfileNotFound,
} from '../src/index.js';

let tmp: string;
const ENV_KEYS = ['TEXTRAL_CONFIG_DIR', 'TEXTRAL_PROFILE', 'TEXTRAL_BASE_URL', 'TEXTRAL_API_KEY'];
const savedEnv: Record<string, string | undefined> = {};

function writeProfilesToml(content: string) {
  mkdirSync(tmp, { recursive: true });
  const path = join(tmp, 'profiles.toml');
  writeFileSync(path, content, 'utf8');
  // Tight perms so the warning doesn't fire in CI.
  chmodSync(path, 0o600);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'textral-profiles-test-'));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.TEXTRAL_CONFIG_DIR = tmp;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('loadProfileFile', () => {
  it('returns null when the file is absent', async () => {
    expect(await loadProfileFile()).toBeNull();
  });

  it('parses a valid file', async () => {
    writeProfilesToml(`
default = "hosted-prod"

[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_local"

[profiles.hosted-prod]
base_url = "https://api.textral.alacrity.ai"
api_key  = "tx_live_prod"
    `);
    const file = await loadProfileFile();
    expect(file).not.toBeNull();
    expect(file!.default).toBe('hosted-prod');
    expect(file!.profiles.size).toBe(2);
    expect(file!.profiles.get('local')?.base_url).toBe('http://localhost:8787');
    expect(file!.profiles.get('hosted-prod')?.api_key).toBe('tx_live_prod');
  });

  it('throws on malformed TOML', async () => {
    writeProfilesToml('this is not valid TOML [[[');
    await expect(loadProfileFile()).rejects.toThrow(/failed to parse TOML/);
  });

  it('throws when [profiles.*] table is missing', async () => {
    writeProfilesToml('default = "x"\n');
    await expect(loadProfileFile()).rejects.toThrow(/missing \[profiles\.\*\] table/);
  });

  it('throws when a profile is missing base_url', async () => {
    writeProfilesToml(`
[profiles.local]
api_key = "tx_live_x"
    `);
    await expect(loadProfileFile()).rejects.toThrow(/missing required `base_url`/);
  });

  it('throws when a profile is missing api_key', async () => {
    writeProfilesToml(`
[profiles.local]
base_url = "http://localhost:8787"
    `);
    await expect(loadProfileFile()).rejects.toThrow(/missing required `api_key`/);
  });

  it('throws when default is non-string', async () => {
    writeProfilesToml(`
default = 42

[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_local"
    `);
    await expect(loadProfileFile()).rejects.toThrow(/must be a string/);
  });
});

describe('resolveActiveProfile', () => {
  it('resolves TEXTRAL_PROFILE when set and present', async () => {
    writeProfilesToml(`
[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_local"

[profiles.prod]
base_url = "https://prod"
api_key  = "tx_live_prod"
    `);
    process.env.TEXTRAL_PROFILE = 'prod';
    const r = await resolveActiveProfile();
    expect(r.active.name).toBe('prod');
    expect(r.source).toBe('env-profile');
    expect(r.available.sort()).toEqual(['local', 'prod']);
  });

  it('throws TextralProfileNotFound when TEXTRAL_PROFILE points at unknown name', async () => {
    writeProfilesToml(`
[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_local"
    `);
    process.env.TEXTRAL_PROFILE = 'missing';
    await expect(resolveActiveProfile()).rejects.toBeInstanceOf(TextralProfileNotFound);
  });

  it('falls back to file.default', async () => {
    writeProfilesToml(`
default = "prod"

[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_local"

[profiles.prod]
base_url = "https://prod"
api_key  = "tx_live_prod"
    `);
    const r = await resolveActiveProfile();
    expect(r.active.name).toBe('prod');
    expect(r.source).toBe('file-default');
  });

  it('falls back to lex-first when no default', async () => {
    writeProfilesToml(`
[profiles.zeta]
base_url = "z"
api_key  = "k"

[profiles.alpha]
base_url = "a"
api_key  = "k"
    `);
    const r = await resolveActiveProfile();
    expect(r.active.name).toBe('alpha');
    expect(r.source).toBe('lex-first');
  });

  it('synthesizes _env when no file and env vars present', async () => {
    process.env.TEXTRAL_BASE_URL = 'https://env-url';
    process.env.TEXTRAL_API_KEY = 'tx_live_env';
    const r = await resolveActiveProfile();
    expect(r.active.name).toBe('_env');
    expect(r.active.base_url).toBe('https://env-url');
    expect(r.source).toBe('env-vars-synth');
  });

  it('throws TextralProfileNotFound when no file and no env vars', async () => {
    await expect(resolveActiveProfile()).rejects.toBeInstanceOf(TextralProfileNotFound);
  });
});

describe('resolveProfile (SDK-friendly)', () => {
  it('explicit baseUrl + apiKey wins over everything', async () => {
    writeProfilesToml(`
default = "prod"

[profiles.prod]
base_url = "https://from-file"
api_key  = "tx_live_file"
    `);
    process.env.TEXTRAL_BASE_URL = 'https://env';
    process.env.TEXTRAL_API_KEY = 'tx_live_env';
    const p = await resolveProfile({ baseUrl: 'https://explicit', apiKey: 'tx_live_explicit' });
    expect(p.name).toBe('_explicit');
    expect(p.base_url).toBe('https://explicit');
    expect(p.api_key).toBe('tx_live_explicit');
  });

  it('named profile resolves from file', async () => {
    writeProfilesToml(`
[profiles.dev]
base_url = "https://dev"
api_key  = "tx_live_dev"
    `);
    const p = await resolveProfile({ name: 'dev' });
    expect(p.name).toBe('dev');
    expect(p.base_url).toBe('https://dev');
  });

  it('named profile throws TextralProfileNotFound when missing', async () => {
    writeProfilesToml(`
[profiles.dev]
base_url = "https://dev"
api_key  = "tx_live_dev"
    `);
    await expect(resolveProfile({ name: 'prod' })).rejects.toBeInstanceOf(
      TextralProfileNotFound,
    );
  });

  it('named profile throws when no file exists', async () => {
    await expect(resolveProfile({ name: 'prod' })).rejects.toBeInstanceOf(
      TextralProfileNotFound,
    );
  });

  it('named profile "_env" without file falls back to env vars', async () => {
    process.env.TEXTRAL_BASE_URL = 'https://env';
    process.env.TEXTRAL_API_KEY = 'tx_live_env';
    const p = await resolveProfile({ name: '_env' });
    expect(p.name).toBe('_env');
    expect(p.base_url).toBe('https://env');
  });

  it('falls through to resolveActiveProfile when name unset', async () => {
    writeProfilesToml(`
default = "prod"

[profiles.prod]
base_url = "https://prod"
api_key  = "tx_live_prod"
    `);
    const p = await resolveProfile();
    expect(p.name).toBe('prod');
  });

  it('only baseUrl set (no apiKey) → does NOT short-circuit', async () => {
    writeProfilesToml(`
default = "prod"

[profiles.prod]
base_url = "https://prod"
api_key  = "tx_live_prod"
    `);
    const p = await resolveProfile({ baseUrl: 'https://explicit' });
    // Falls through to file resolution because apiKey is missing.
    expect(p.name).toBe('prod');
  });
});

describe('configPath', () => {
  it('honors TEXTRAL_CONFIG_DIR override', () => {
    expect(configPath()).toBe(join(tmp, 'profiles.toml'));
  });
});

// ── Cross-language parity ─────────────────────────────────────────
//
// These assertions are mirrored in
//   packages/sdk-python/tests/test_parity.py
// against the same fixture file content. If you change either side,
// keep both in sync — that's the whole point of profiles.toml: one
// file, two SDKs, identical semantics.
describe('parity (cross-language)', () => {
  // Fixture content lives at:
  //   - packages/profiles/test/fixtures/profiles.toml
  //   - packages/sdk-python/tests/fixtures/profiles.toml
  // Both files have the same content; we inline-write here so the
  // test owns the lifecycle (chmod 600 etc.) of its copy.
  const PARITY_FIXTURE = `default = "prod"

[profiles.dev]
base_url = "https://dev.example/api"
api_key = "dev-fixture-key"

[profiles.staging]
base_url = "https://staging.example/api"
api_key = "staging-fixture-key"

[profiles.prod]
base_url = "https://api.example.com"
api_key = "prod-fixture-key"
`;

  beforeEach(() => writeProfilesToml(PARITY_FIXTURE));

  it('resolves to prod via default field', async () => {
    const p = await resolveProfile();
    expect(p.name).toBe('prod');
    expect(p.base_url).toBe('https://api.example.com');
    expect(p.api_key).toBe('prod-fixture-key');
  });

  it('resolves named dev', async () => {
    const p = await resolveProfile({ name: 'dev' });
    expect(p.name).toBe('dev');
    expect(p.base_url).toBe('https://dev.example/api');
    expect(p.api_key).toBe('dev-fixture-key');
  });

  it('TEXTRAL_PROFILE env overrides default', async () => {
    process.env.TEXTRAL_PROFILE = 'staging';
    const p = await resolveProfile();
    expect(p.name).toBe('staging');
    expect(p.base_url).toBe('https://staging.example/api');
  });

  it('explicit baseUrl + apiKey overrides everything', async () => {
    process.env.TEXTRAL_PROFILE = 'staging';
    const p = await resolveProfile({
      baseUrl: 'https://override.example',
      apiKey: 'override-key',
    });
    expect(p.name).toBe('_explicit');
    expect(p.base_url).toBe('https://override.example');
    expect(p.api_key).toBe('override-key');
  });
});
