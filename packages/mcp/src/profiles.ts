// MCP-side wrapper around the shared `@textral/profiles` package.
//
// The actual loader + resolver lives in `@textral/profiles` and is
// shared across the MCP server, the SDK, and any future Node tool
// that addresses Textral by profile name. This file used to carry
// the implementation; it now just re-exports for callers that
// imported from this path historically.
//
// MCP-only mutation helpers (write to the file from the
// `textral_set_profile` MCP tool) live alongside their callers in
// `tools/profile-tools.ts` — they aren't general-purpose Node
// concerns so they don't belong in the shared package.

export {
  type Profile,
  type ProfileFile,
  type ResolvedActiveProfile,
  type ResolveProfileInput,
  configDir,
  configPath,
  loadProfileFile,
  resolveActiveProfile,
  resolveProfile,
  TextralProfileNotFound,
} from '@textral/profiles';
