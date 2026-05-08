#!/usr/bin/env node
// Stdio MCP server entrypoint.
//
// Two modes, picked by filesystem fact:
//   1. Production (published install): import compiled JS from dist/.
//   2. Dev (repo contributors): fall back to tsx's tsImport API on
//      src/transport-stdio.ts. Only triggered when src/ exists, which
//      is never true in a published install (`files` whitelist excludes
//      src/), so the fallback never runs in production.
//
// MCP clients (Claude Code, Cursor) spawn this process from their own
// cwd, so all paths are resolved relative to *this file's location*.
//
// Profile resolution lives downstream in src/profiles.ts; the shim
// only locates and dispatches to startStdio().

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, '..', 'dist', 'transport-stdio.js');
const srcPath = resolve(here, '..', 'src', 'transport-stdio.ts');

let startStdio;
if (existsSync(distPath)) {
  ({ startStdio } = await import(pathToFileURL(distPath).href));
} else if (existsSync(srcPath)) {
  // Dev mode — repo contributor running from source. Requires tsx as
  // a devDependency. Never reached in a published install (src/ isn't
  // shipped to npm).
  let tsImport;
  try {
    ({ tsImport } = await import('tsx/esm/api'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      '@textral/mcp: dev mode requires tsx. Run `pnpm install` from the workspace root.\n' +
        '  underlying error: ' +
        msg,
    );
    process.exit(2);
  }
  ({ startStdio } = await tsImport(pathToFileURL(srcPath).href, import.meta.url));
} else {
  console.error(
    '@textral/mcp: neither dist/transport-stdio.js nor src/transport-stdio.ts found. ' +
      'The install is corrupt — try reinstalling the package.',
  );
  process.exit(2);
}

// startStdio() reads its config from one of (in resolution order):
//   1. TEXTRAL_PROFILE env var pointing at a profile in
//      ~/.textral/profiles.toml
//   2. `default` field in ~/.textral/profiles.toml
//   3. Lexicographically first profile in the file
//   4. A synthesized `_env` profile from TEXTRAL_BASE_URL +
//      TEXTRAL_API_KEY env vars (legacy single-tenant path)
//   5. Hard fail with a help message
//
// The shim doesn't pre-resolve any of these — it just hands off and
// lets profiles.ts produce a clear error if nothing is configured.
try {
  await startStdio();
} catch (e) {
  // The resolver throws Error subclasses with full help-message text
  // for the no-config case (no file, no env vars). Print the message
  // verbatim and exit 2.
  console.error('@textral/mcp failed to start:', e instanceof Error ? e.message : e);
  process.exit(2);
}
