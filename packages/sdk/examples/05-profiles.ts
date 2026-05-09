/**
 * 05-profiles.ts — `~/.textral/profiles.toml` resolution recipes.
 *
 * Demonstrates: the three rungs of the precedence chain (constructor
 * args → env vars → file), plus `loadProfileFile` for inspection.
 *
 * Sample profiles.toml (place at ~/.textral/profiles.toml):
 *
 *     default = "hosted-prod"
 *
 *     [profiles.local]
 *     base_url = "http://localhost:8787"
 *     api_key  = "tx_live_local_..."
 *
 *     [profiles.hosted-prod]
 *     base_url = "https://api.textral.alacrity.ai"
 *     api_key  = "tx_live_..."
 *
 * Run:
 *     npx tsx 05-profiles.ts
 *
 * See also:
 *     SDK_COOKBOOK_OUTLINE.md §6
 */

import {
  TextralClient,
  loadProfileFile,
  TextralProfileNotFound,
} from '@textral/sdk';

// Method 1: name a profile explicitly. Lazy-resolved.
const c1 = new TextralClient({ profile: 'hosted-prod' });
try {
  const me1 = await c1.me();
  console.log(`hosted-prod → ${me1.tenant.id}`);
} catch (e) {
  if (e instanceof TextralProfileNotFound) {
    console.error(`hosted-prod profile missing: ${e.message}`);
  } else {
    throw e;
  }
}

// Method 2: rely on the file's `default = "..."` row. Eager
// resolution — errors surface at the await on fromProfile().
try {
  const c2 = await TextralClient.fromProfile();
  const me2 = await c2.me();
  console.log(`(default)   → ${me2.tenant.id}`);
} catch (e) {
  if (e instanceof TextralProfileNotFound) {
    console.error(`no default profile available: ${e.message}`);
  } else {
    throw e;
  }
}

// Method 3: env vars override, when no profile name is given. Set:
//   TEXTRAL_BASE_URL=http://localhost:8787
//   TEXTRAL_API_KEY=tx_live_local
// Then `TextralClient.fromProfile()` synthesizes an `_env` profile
// from those env vars when no file is present.

// Inspect what the file contains (debugging aid).
const file = await loadProfileFile();
if (file) {
  console.log('---');
  console.log('profiles defined:', [...file.profiles.keys()].join(', '));
  console.log('default:', file.default ?? '(none)');
} else {
  console.log('---');
  console.log('no profile file at ~/.textral/profiles.toml');
}
