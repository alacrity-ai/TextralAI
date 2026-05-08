// Profile-control tools — Phase B.4 of MCP V2.
//
// Two tools, both surfaced only by the stdio transport (the embedded
// HTTP transport doesn't have a notion of "active profile" — every
// request comes with its own auth):
//
//   * textral_set_profile({ name }) — flip the active profile. Lazy-
//     materializes the new binding on first switch. Probe-fails
//     atomically: on any error, the prior profile remains active.
//   * textral_get_profile()         — read back the current active
//     profile + the available list. Useful for "which env am I in?"
//     before destructive operations.

import { z } from 'zod';
import type { TextralClient } from '@textral/sdk';
import type { AuditWriter } from '../audit.js';
import type { Profile } from '../profiles.js';
import { loadProfileFile } from '../profiles.js';
import { defineTool, type ToolDef } from './types.js';

export interface ProfileBinding {
  profile: Profile;
  client: TextralClient;
  audit: AuditWriter;
  runtime: 'cf' | 'node';
}

export interface ServerState {
  /** Name of the currently-active profile. Mutates on
   *  textral_set_profile success. */
  active: string;
  /** Profile names the server knows about, snapshotted at startup.
   *  Updated by textral_set_profile when a freshly-loaded profile
   *  file revealed a new name. */
  available: string[];
  /** Materialized profiles. First-touch: only the initial profile
   *  is in here at startup. */
  cache: Map<string, ProfileBinding>;
  /** Probes a profile's `/v1/me` endpoint and constructs a fresh
   *  binding. Throws on any error (auth failure, network error,
   *  unreachable host). The caller wraps this with rollback on
   *  failure. */
  materialize: (profile: Profile) => Promise<ProfileBinding>;
}

const SetProfileInput = z.object({
  name: z
    .string()
    .min(1)
    .describe('Profile name as it appears in `~/.textral/profiles.toml`.'),
});

const GetProfileInput = z.object({});

interface SetProfileResult {
  active_profile: string;
  base_url: string;
  runtime: 'cf' | 'node';
  source: 'cache' | 'fresh';
}

interface GetProfileResult {
  active_profile: string;
  base_url: string;
  runtime: 'cf' | 'node';
  available: string[];
}

/** Builds the two profile-control tools. Description text
 *  interpolates the available-profiles list at server-create time so
 *  the LLM sees the actual menu without an extra listing call. */
export function buildProfileControlTools(state: ServerState): ToolDef[] {
  // Cap at 5 in the description — the full list always remains
  // available via textral_get_profile. The cap keeps the
  // tool-description budget under the 200-char ceiling enforced by
  // defineTool() even for users with many profiles.
  const profilesList =
    state.available.length > 5
      ? `${state.available.slice(0, 5).join(', ')}, … (${state.available.length} total)`
      : state.available.join(', ') || '(none)';

  const setProfile: ToolDef<unknown, unknown, { name: string }, SetProfileResult> =
    defineTool<unknown, { name: string }, SetProfileResult>({
      name: 'textral_set_profile',
      description:
        `Switch the active Textral profile. Subsequent tool calls use this until switched again. ` +
        `Available: ${profilesList}.`,
      inputSchemaZod: SetProfileInput,
      handler: async ({ args }): Promise<SetProfileResult> => {
        return await setProfile_handler(state, args.name);
      },
    }) as unknown as ToolDef<unknown, unknown, { name: string }, SetProfileResult>;

  const getProfile: ToolDef<unknown, unknown, Record<string, never>, GetProfileResult> =
    defineTool<unknown, Record<string, never>, GetProfileResult>({
      name: 'textral_get_profile',
      description:
        'Returns the active Textral profile + available list. ' +
        'Use to confirm which environment subsequent calls target.',
      inputSchemaZod: GetProfileInput,
      handler: async (): Promise<GetProfileResult> => getProfile_handler(state),
    }) as unknown as ToolDef<unknown, unknown, Record<string, never>, GetProfileResult>;

  return [setProfile as unknown as ToolDef, getProfile as unknown as ToolDef];
}

/** Internal — exposed for tests. Switches the active profile,
 *  lazily materializing on first touch. Probe failure rolls back
 *  cleanly: state.active is never mutated until materialize() has
 *  resolved. */
export async function setProfile_handler(
  state: ServerState,
  name: string,
): Promise<SetProfileResult> {
  // Idempotent: switching to the active profile is a no-op probe.
  if (name === state.active) {
    const cached = state.cache.get(state.active);
    if (!cached) {
      throw new Error(`internal: active profile "${state.active}" not in cache`);
    }
    return {
      active_profile: cached.profile.name,
      base_url: cached.profile.base_url,
      runtime: cached.runtime,
      source: 'cache',
    };
  }

  // Re-load the file to pick up edits since startup. This is the only
  // path that touches disk during a session; switching is a rare
  // user-explicit event so the IO cost is acceptable.
  const file = await loadProfileFile();
  const candidate = file?.profiles.get(name);
  if (!candidate) {
    const available = file ? [...file.profiles.keys()] : state.available;
    throw new Error(
      `Profile "${name}" not found in ~/.textral/profiles.toml. ` +
        `Available: ${available.join(', ') || '(none)'}.`,
    );
  }

  // Refresh the available list — the user may have added/removed
  // profiles since startup.
  state.available = file ? [...file.profiles.keys()] : state.available;

  // Lazy materialize. On any failure, do NOT mutate state.active —
  // the prior profile remains the active one.
  let next: ProfileBinding;
  const cached = state.cache.get(name);
  if (cached) {
    next = cached;
  } else {
    try {
      next = await state.materialize(candidate);
    } catch (e) {
      const msg = (e as Error).message;
      throw new Error(
        `Failed to switch to profile "${name}": ${msg}. ` +
          `Active profile remains "${state.active}".`,
      );
    }
    state.cache.set(name, next);
  }
  state.active = name;
  return {
    active_profile: next.profile.name,
    base_url: next.profile.base_url,
    runtime: next.runtime,
    source: cached ? 'cache' : 'fresh',
  };
}

/** Internal — exposed for tests. Returns a snapshot of the current
 *  state suitable for reading back to the LLM. */
export function getProfile_handler(state: ServerState): GetProfileResult {
  const cached = state.cache.get(state.active);
  if (!cached) {
    throw new Error(`internal: active profile "${state.active}" not in cache`);
  }
  return {
    active_profile: cached.profile.name,
    base_url: cached.profile.base_url,
    runtime: cached.runtime,
    available: state.available,
  };
}
