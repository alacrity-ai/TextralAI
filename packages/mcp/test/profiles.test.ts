// Profile loader + resolver tests (Phase B.1 + B.2). Each test
// builds a fresh temp dir, points TEXTRAL_CONFIG_DIR at it, and
// stubs process.env via vi.stubEnv so we don't pollute the runner's
// real environment.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configPath, loadProfileFile, resolveActiveProfile } from '../src/profiles.js';

let tmpDir: string;

async function writeProfilesToml(content: string, mode = 0o600): Promise<void> {
  const path = join(tmpDir, 'profiles.toml');
  await writeFile(path, content, 'utf8');
  await chmod(path, mode);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'textral-mcp-profiles-'));
  vi.stubEnv('TEXTRAL_CONFIG_DIR', tmpDir);
  // Clear env vars that the resolver checks.
  vi.stubEnv('TEXTRAL_PROFILE', '');
  vi.stubEnv('TEXTRAL_BASE_URL', '');
  vi.stubEnv('TEXTRAL_API_KEY', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('configPath', () => {
  it('respects TEXTRAL_CONFIG_DIR override', () => {
    expect(configPath()).toBe(join(tmpDir, 'profiles.toml'));
  });
});

describe('loadProfileFile', () => {
  it('returns null when the file is absent', async () => {
    expect(await loadProfileFile()).toBeNull();
  });

  it('parses a valid two-profile file', async () => {
    await writeProfilesToml(`
default = "local"

[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_local"

[profiles.hosted-prod]
base_url = "https://example.com"
api_key  = "tx_live_hosted"
`);
    const file = await loadProfileFile();
    expect(file).not.toBeNull();
    expect(file!.default).toBe('local');
    expect(file!.profiles.size).toBe(2);
    expect(file!.profiles.get('local')!.base_url).toBe('http://localhost:8787');
    expect(file!.profiles.get('hosted-prod')!.api_key).toBe('tx_live_hosted');
  });

  it('omits default when not set in the file', async () => {
    await writeProfilesToml(`
[profiles.solo]
base_url = "http://localhost:8787"
api_key  = "tx_live"
`);
    const file = await loadProfileFile();
    expect(file).not.toBeNull();
    expect(file!.default).toBeUndefined();
  });

  it('throws on malformed TOML', async () => {
    await writeProfilesToml('this is not = valid TOML "');
    await expect(loadProfileFile()).rejects.toThrow(/failed to parse TOML/);
  });

  it('throws when [profiles.*] table is missing', async () => {
    await writeProfilesToml('default = "x"\n');
    await expect(loadProfileFile()).rejects.toThrow(/missing \[profiles\.\*\] table/);
  });

  it('throws when a profile is missing base_url', async () => {
    await writeProfilesToml(`
[profiles.bad]
api_key = "tx_live"
`);
    await expect(loadProfileFile()).rejects.toThrow(/missing required `base_url`/);
  });

  it('throws when a profile is missing api_key', async () => {
    await writeProfilesToml(`
[profiles.bad]
base_url = "http://x"
`);
    await expect(loadProfileFile()).rejects.toThrow(/missing required `api_key`/);
  });

  it('throws when default is non-string', async () => {
    await writeProfilesToml(`
default = 42

[profiles.x]
base_url = "http://x"
api_key  = "tx_live"
`);
    await expect(loadProfileFile()).rejects.toThrow(/`default` must be a string/);
  });

  it('emits a non-fatal warning for world-readable files', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeProfilesToml(
      `
[profiles.x]
base_url = "http://x"
api_key  = "tx_live"
`,
      0o644,
    );
    const file = await loadProfileFile();
    expect(file).not.toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/recommend `chmod 600`/));
    errSpy.mockRestore();
  });
});

describe('resolveActiveProfile', () => {
  it('TEXTRAL_PROFILE wins over file default', async () => {
    await writeProfilesToml(`
default = "a"

[profiles.a]
base_url = "http://a"
api_key  = "tx_live_a"

[profiles.b]
base_url = "http://b"
api_key  = "tx_live_b"
`);
    vi.stubEnv('TEXTRAL_PROFILE', 'b');
    const r = await resolveActiveProfile();
    expect(r.source).toBe('env-profile');
    expect(r.active.name).toBe('b');
    expect(r.available.sort()).toEqual(['a', 'b']);
  });

  it('throws when TEXTRAL_PROFILE names an unknown profile', async () => {
    await writeProfilesToml(`
[profiles.a]
base_url = "http://a"
api_key  = "tx_live_a"
`);
    vi.stubEnv('TEXTRAL_PROFILE', 'nonexistent');
    await expect(resolveActiveProfile()).rejects.toThrow(
      /TEXTRAL_PROFILE="nonexistent" not in .*Available: a/,
    );
  });

  it('falls through to file default when no env override', async () => {
    await writeProfilesToml(`
default = "production"

[profiles.production]
base_url = "http://prod"
api_key  = "tx_live_prod"

[profiles.staging]
base_url = "http://stage"
api_key  = "tx_live_stage"
`);
    const r = await resolveActiveProfile();
    expect(r.source).toBe('file-default');
    expect(r.active.name).toBe('production');
  });

  it('throws when default points at a missing profile', async () => {
    await writeProfilesToml(`
default = "ghost"

[profiles.real]
base_url = "http://real"
api_key  = "tx_live_real"
`);
    await expect(resolveActiveProfile()).rejects.toThrow(/default = "ghost"/);
  });

  it('falls through to lexicographically first profile when no default', async () => {
    await writeProfilesToml(`
[profiles.zeta]
base_url = "http://zeta"
api_key  = "tx_live_zeta"

[profiles.alpha]
base_url = "http://alpha"
api_key  = "tx_live_alpha"

[profiles.middle]
base_url = "http://middle"
api_key  = "tx_live_middle"
`);
    const r = await resolveActiveProfile();
    expect(r.source).toBe('lex-first');
    expect(r.active.name).toBe('alpha');
  });

  it('synthesizes _env profile when no file but env vars set', async () => {
    vi.stubEnv('TEXTRAL_BASE_URL', 'http://localhost:8787');
    vi.stubEnv('TEXTRAL_API_KEY', 'tx_live_env');
    const r = await resolveActiveProfile();
    expect(r.source).toBe('env-vars-synth');
    expect(r.active.name).toBe('_env');
    expect(r.active.base_url).toBe('http://localhost:8787');
    expect(r.active.api_key).toBe('tx_live_env');
    expect(r.available).toEqual(['_env']);
  });

  it('throws when no file and no env vars', async () => {
    await expect(resolveActiveProfile()).rejects.toThrow(/No Textral profile configured/);
  });

  it('keeps directory absent → null path stable', async () => {
    // Point at a directory that doesn't exist so loadProfileFile()
    // hits the ENOENT branch even though TEXTRAL_CONFIG_DIR is set.
    const ghost = join(tmpDir, 'does-not-exist');
    vi.stubEnv('TEXTRAL_CONFIG_DIR', ghost);
    vi.stubEnv('TEXTRAL_BASE_URL', 'http://x');
    vi.stubEnv('TEXTRAL_API_KEY', 'tx_live_x');
    const r = await resolveActiveProfile();
    expect(r.source).toBe('env-vars-synth');
  });

  it('non-ENOENT fs errors bubble (not swallowed)', async () => {
    // Make the parent dir unreadable so readFile fails with EACCES.
    // Skip on platforms where chmod doesn't enforce (Windows).
    if (process.platform === 'win32') return;
    const lockedDir = join(tmpDir, 'locked');
    await mkdir(lockedDir);
    const path = join(lockedDir, 'profiles.toml');
    await writeFile(path, '[profiles.x]\nbase_url="http://x"\napi_key="tx"\n');
    await chmod(lockedDir, 0o000);
    vi.stubEnv('TEXTRAL_CONFIG_DIR', lockedDir);
    try {
      await expect(resolveActiveProfile()).rejects.toThrow();
    } finally {
      await chmod(lockedDir, 0o755);
    }
  });
});
