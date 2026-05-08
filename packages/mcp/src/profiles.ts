// Profile loader + resolution for the MCP V2 multi-profile design.
//
// Profiles live in `~/.textral/profiles.toml` (overridable via
// `TEXTRAL_CONFIG_DIR`). Each profile is a `(base_url, api_key)`
// pair with a name; resolution picks the active profile per the
// precedence chain documented in MCP_V2_PLAN.md §Part B.
//
// The loader is intentionally side-effect-free apart from a
// `console.error` warning when the profile file's permissions are
// loose (recommended `chmod 600`). The warning is non-fatal — the
// loader still returns the parsed file.
//
// Note on the `_env` synthesized profile: when no profile file
// exists but `TEXTRAL_BASE_URL` + `TEXTRAL_API_KEY` env vars are
// present, the resolver synthesizes a one-shot profile named
// `_env`. This is the backwards-compat path for the pre-V2
// single-tenant install pattern; existing single-tenant users see
// no behavior change after upgrading.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

export interface Profile {
  name: string;
  base_url: string;
  api_key: string;
}

export interface ProfileFile {
  default?: string;
  profiles: Map<string, Profile>;
}

const FILE_NAME = 'profiles.toml';

/** Returns the resolved Textral config directory.
 *  - `TEXTRAL_CONFIG_DIR` env var takes precedence (useful for CI /
 *    sandboxed test envs).
 *  - Otherwise `${homedir()}/.textral`. */
export function configDir(): string {
  return process.env.TEXTRAL_CONFIG_DIR ?? join(homedir(), '.textral');
}

export function configPath(): string {
  return join(configDir(), FILE_NAME);
}

/** Loads the profile file from disk. Returns `null` when the file
 *  is absent (the caller falls back to the `_env` synth profile or
 *  fails). Throws on parse error or schema-level invalidity (missing
 *  `base_url` / `api_key` on a profile). */
export async function loadProfileFile(): Promise<ProfileFile | null> {
  const path = configPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }

  // Permissions check — non-fatal warning. The bit math is:
  //   mode & 0o077 → any group/world-readable bits set.
  // We don't refuse the load; some setups (shared dotfiles, NFS
  // mounts) legitimately have looser modes and the user should be
  // informed, not blocked.
  try {
    const st = await stat(path);
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      console.error(
        `[textral-mcp] warning: ${path} is mode 0${mode.toString(8)}; ` +
          'recommend `chmod 600` (it contains bearer credentials)',
      );
    }
  } catch {
    /* permission stat failed — non-fatal, proceed */
  }

  let toml: { default?: unknown; profiles?: Record<string, unknown> };
  try {
    toml = parse(raw) as { default?: unknown; profiles?: Record<string, unknown> };
  } catch (e) {
    throw new Error(
      `${path}: failed to parse TOML — ${(e as Error).message}`,
    );
  }
  if (!toml.profiles || typeof toml.profiles !== 'object') {
    throw new Error(
      `${path}: missing [profiles.*] table. ` +
        'See docs/mcp/QUICKSTART.md §"Profiles" for the expected shape.',
    );
  }
  const profiles = new Map<string, Profile>();
  for (const [name, body] of Object.entries(toml.profiles)) {
    if (!body || typeof body !== 'object') {
      throw new Error(`${path}: profile "${name}" is not a table`);
    }
    const b = body as Record<string, unknown>;
    if (typeof b.base_url !== 'string' || b.base_url.length === 0) {
      throw new Error(`${path}: profile "${name}" missing required \`base_url\``);
    }
    if (typeof b.api_key !== 'string' || b.api_key.length === 0) {
      throw new Error(`${path}: profile "${name}" missing required \`api_key\``);
    }
    profiles.set(name, { name, base_url: b.base_url, api_key: b.api_key });
  }
  const result: ProfileFile = { profiles };
  if (typeof toml.default === 'string') {
    result.default = toml.default;
  } else if (toml.default !== undefined) {
    throw new Error(`${path}: \`default\` must be a string if set`);
  }
  return result;
}

export interface ResolvedActiveProfile {
  active: Profile;
  available: string[];
  source: 'env-profile' | 'file-default' | 'lex-first' | 'env-vars-synth';
}

/** Resolves the active profile per the precedence chain:
 *
 *    1. `TEXTRAL_PROFILE` env var (tightest)
 *    2. `default` field in the profile file
 *    3. Lexicographically first profile in the file
 *    4. Synthesized `_env` profile from `TEXTRAL_BASE_URL` +
 *       `TEXTRAL_API_KEY` (backwards-compat)
 *    5. Hard fail with a help message
 *
 *  The function does NOT probe the resolved profile's `/v1/me`
 *  endpoint — that's the caller's responsibility (the per-profile
 *  cache in server.ts materializes lazily and runs the probe
 *  there). */
export async function resolveActiveProfile(): Promise<ResolvedActiveProfile> {
  const file = await loadProfileFile();
  const envProfile = process.env.TEXTRAL_PROFILE;

  if (file) {
    const available = [...file.profiles.keys()];
    if (envProfile) {
      const p = file.profiles.get(envProfile);
      if (!p) {
        throw new Error(
          `TEXTRAL_PROFILE="${envProfile}" not in ${configPath()}. ` +
            `Available: ${available.join(', ') || '(none)'}`,
        );
      }
      return { active: p, available, source: 'env-profile' };
    }
    if (file.default) {
      const p = file.profiles.get(file.default);
      if (!p) {
        throw new Error(
          `${configPath()}: default = "${file.default}" but no [profiles.${file.default}] table. ` +
            `Available: ${available.join(', ') || '(none)'}`,
        );
      }
      return { active: p, available, source: 'file-default' };
    }
    const lexFirst = available.slice().sort()[0];
    if (!lexFirst) {
      throw new Error(`${configPath()}: no profiles defined`);
    }
    const p = file.profiles.get(lexFirst);
    if (!p) {
      // Shouldn't happen — keys() came from the same map. Pin a clear
      // error anyway so a future refactor doesn't silently misroute.
      throw new Error(`${configPath()}: profile "${lexFirst}" missing from map`);
    }
    return { active: p, available, source: 'lex-first' };
  }

  // No file. Synth from TEXTRAL_BASE_URL + TEXTRAL_API_KEY.
  const baseUrl = process.env.TEXTRAL_BASE_URL;
  const apiKey = process.env.TEXTRAL_API_KEY;
  if (baseUrl && apiKey) {
    return {
      active: { name: '_env', base_url: baseUrl, api_key: apiKey },
      available: ['_env'],
      source: 'env-vars-synth',
    };
  }

  throw new Error(
    'No Textral profile configured. Either:\n' +
      `  1. Create ${configPath()} with [profiles.*] tables (see docs/mcp/QUICKSTART.md), or\n` +
      '  2. Set TEXTRAL_BASE_URL + TEXTRAL_API_KEY env vars on the MCP launch command.',
  );
}
