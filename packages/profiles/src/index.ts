// `~/.textral/profiles.toml` resolver. Shared between @textral/sdk
// (programmatic Node clients) and @textral/mcp (the stdio MCP
// server). Keeping this in one place is the only correct posture —
// every consumer reads the same file format with the same
// precedence chain, and a bug-fix in the resolver lands in every
// caller through `pnpm install`.
//
// File format (see docs/mcp/QUICKSTART.md §"Profiles"):
//
//     default = "hosted-prod"
//
//     [profiles.local]
//     base_url = "http://localhost:8787"
//     api_key  = "tx_live_..."
//
//     [profiles.hosted-prod]
//     base_url = "https://api.textral.alacrity.ai"
//     api_key  = "tx_live_..."
//
// Two public surfaces:
//
//   * `resolveActiveProfile()` — the original MCP-flavored helper
//     that returns the resolved profile plus diagnostic info
//     (`available` + `source`). Used by the MCP server.
//
//   * `resolveProfile({ name?, baseUrl?, apiKey? })` — the
//     SDK-friendly variant. Constructor args win; falls back to
//     env vars; falls back to `resolveActiveProfile()`.
//
// Both share the underlying `loadProfileFile()` reader.

// `node:fs/promises` and `node:os` are imported lazily inside the
// functions that touch the filesystem. Top-level imports break the
// Workers runtime even when no caller ever hits the file path
// (e.g. the API Worker boots @textral/sdk transitively, but never
// reads ~/.textral/profiles.toml). Workers tolerates `node:path` via
// nodejs_compat, so that one stays at top level.
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
 *  - Otherwise `${HOME}/.textral` (Unix) or `${USERPROFILE}/.textral`
 *    (Windows). We avoid `node:os` so the package's module-load
 *    succeeds in Cloudflare Workers (where the SDK is imported
 *    transitively but never reads the filesystem). */
export function configDir(): string {
  if (process.env.TEXTRAL_CONFIG_DIR) {
    return process.env.TEXTRAL_CONFIG_DIR;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error(
      'Cannot resolve Textral config dir: neither TEXTRAL_CONFIG_DIR ' +
        'nor HOME/USERPROFILE is set. In Cloudflare Workers / browser ' +
        'environments, set TEXTRAL_CONFIG_DIR or pass {baseUrl, apiKey} ' +
        'directly to the SDK constructor.',
    );
  }
  return join(home, '.textral');
}

export function configPath(): string {
  return join(configDir(), FILE_NAME);
}

/** Loads the profile file from disk. Returns `null` when the file
 *  is absent (the caller falls back to the `_env` synth profile or
 *  fails). Throws on parse error or schema-level invalidity (missing
 *  `base_url` / `api_key` on a profile). */
export async function loadProfileFile(): Promise<ProfileFile | null> {
  // Lazy import — keeps the Worker bundle bootable for callers
  // that never hit the filesystem path (the API Worker boots
  // @textral/sdk transitively but never resolves a profile).
  const { readFile, stat } = await import('node:fs/promises');
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
        `[textral-profiles] warning: ${path} is mode 0${mode.toString(8)}; ` +
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
 *  Used by the MCP server which wants the additional diagnostic
 *  context (available profile names + the chain rung that resolved).
 *  SDK callers usually want the simpler `resolveProfile(...)` below. */
export async function resolveActiveProfile(): Promise<ResolvedActiveProfile> {
  const file = await loadProfileFile();
  const envProfile = process.env.TEXTRAL_PROFILE;

  if (file) {
    const available = [...file.profiles.keys()];
    if (envProfile) {
      const p = file.profiles.get(envProfile);
      if (!p) {
        throw new TextralProfileNotFound(
          envProfile,
          `TEXTRAL_PROFILE="${envProfile}" not in ${configPath()}. ` +
            `Available: ${available.join(', ') || '(none)'}`,
        );
      }
      return { active: p, available, source: 'env-profile' };
    }
    if (file.default) {
      const p = file.profiles.get(file.default);
      if (!p) {
        throw new TextralProfileNotFound(
          file.default,
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

  throw new TextralProfileNotFound(
    envProfile ?? '<unspecified>',
    'No Textral profile configured. Either:\n' +
      `  1. Create ${configPath()} with [profiles.*] tables (see docs/mcp/QUICKSTART.md), or\n` +
      '  2. Set TEXTRAL_BASE_URL + TEXTRAL_API_KEY env vars.',
  );
}

/** Thrown when an explicitly-named profile doesn't exist, or when
 *  no profile resolution path produces credentials. The `.profileName`
 *  field is the name that was requested (or `<unspecified>` when no
 *  rung of the precedence chain produced a name to look up). */
export class TextralProfileNotFound extends Error {
  override readonly name = 'TextralProfileNotFound';
  constructor(
    public readonly profileName: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolveProfileInput {
  /** Pick a specific profile by name. When set, fails fast if the
   *  profile doesn't exist. When unset, falls through to env-var /
   *  file-default / lex-first resolution. */
  name?: string;
  /** Explicit override. When both `baseUrl` and `apiKey` are set,
   *  no file lookup happens — the constructor-supplied pair wins. */
  baseUrl?: string;
  apiKey?: string;
}

/** SDK-friendly profile resolver. Precedence:
 *
 *    1. Constructor-supplied `{ baseUrl, apiKey }` (both must be set)
 *    2. `name` argument → looked up in `~/.textral/profiles.toml`
 *    3. `TEXTRAL_PROFILE` env → looked up in the file
 *    4. File's `default` field
 *    5. Lex-first profile in the file
 *    6. Synthesized `_env` profile from `TEXTRAL_BASE_URL` +
 *       `TEXTRAL_API_KEY`
 *    7. Throws `TextralProfileNotFound`
 *
 *  Returns the resolved `Profile` (just `{name, base_url, api_key}`).
 *  When the constructor-supplied pair wins, the synthesized profile
 *  is named `_explicit`. */
export async function resolveProfile(
  input: ResolveProfileInput = {},
): Promise<Profile> {
  if (input.baseUrl && input.apiKey) {
    return {
      name: '_explicit',
      base_url: input.baseUrl,
      api_key: input.apiKey,
    };
  }

  if (input.name) {
    const file = await loadProfileFile();
    if (!file) {
      // Named profile requested, but no file. Fall through to env
      // vars only if the name happens to be `_env` (an explicit
      // ask for the synthesized backwards-compat profile); otherwise
      // hard-fail with a clear message rather than silently picking
      // the env-var synth.
      if (input.name === '_env') {
        const baseUrl = process.env.TEXTRAL_BASE_URL;
        const apiKey = process.env.TEXTRAL_API_KEY;
        if (baseUrl && apiKey) {
          return { name: '_env', base_url: baseUrl, api_key: apiKey };
        }
      }
      throw new TextralProfileNotFound(
        input.name,
        `Profile "${input.name}" requested but ${configPath()} doesn't exist. ` +
          'Create it (see docs/mcp/QUICKSTART.md), or pass {baseUrl, apiKey} explicitly.',
      );
    }
    const p = file.profiles.get(input.name);
    if (!p) {
      const available = [...file.profiles.keys()];
      throw new TextralProfileNotFound(
        input.name,
        `Profile "${input.name}" not in ${configPath()}. ` +
          `Available: ${available.join(', ') || '(none)'}`,
      );
    }
    return p;
  }

  // No explicit name → defer to the MCP-flavored chain. This
  // handles TEXTRAL_PROFILE / file.default / lex-first / env-vars
  // synth in that order.
  const resolved = await resolveActiveProfile();
  return resolved.active;
}
