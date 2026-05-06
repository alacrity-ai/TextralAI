#!/usr/bin/env node
// Stdio MCP server entrypoint.
//
// In dev mode this shim uses tsx's programmatic `tsImport` API to
// load the TypeScript transport-stdio module directly. For published
// builds, ship a compiled dist/transport-stdio.js and update the
// import to point at it.
//
// MCP clients (Claude Code, Cursor) spawn this process from their
// own cwd, so all paths are resolved relative to *this file's
// location*, not process.cwd().

import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';

const baseUrl = process.env.TEXTRAL_BASE_URL;
const apiKey = process.env.TEXTRAL_API_KEY;
if (!baseUrl || !apiKey) {
  console.error(
    '@textral/mcp: TEXTRAL_BASE_URL and TEXTRAL_API_KEY must be set.\n' +
      '  example:\n' +
      '    TEXTRAL_BASE_URL=http://localhost:8787 \\\n' +
      '    TEXTRAL_API_KEY=tx_live_… \\\n' +
      '      node /path/to/packages/mcp/bin/textral-mcp.mjs',
  );
  process.exit(2);
}

const shimDir = dirname(fileURLToPath(import.meta.url));
const transportUrl = pathToFileURL(
  resolve(shimDir, '..', 'src', 'transport-stdio.ts'),
).href;

// Resolve tsx's `tsImport` from this package's node_modules so the
// shim works regardless of cwd. The require lookup is rooted at this
// shim's location.
const requireFromShim = createRequire(import.meta.url);
let tsImport;
try {
  const tsxApiPath = requireFromShim.resolve('tsx/esm/api');
  ({ tsImport } = await import(pathToFileURL(tsxApiPath).href));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(
    '@textral/mcp: failed to load tsx loader: ' + msg + '\n' +
      "Run `pnpm install` from the workspace root to install @textral/mcp's devDependencies.",
  );
  process.exit(2);
}

try {
  const { startStdio } = await tsImport(transportUrl, import.meta.url);
  await startStdio({ baseUrl, apiKey });
} catch (e) {
  console.error('@textral/mcp failed to start:', e);
  process.exit(2);
}
