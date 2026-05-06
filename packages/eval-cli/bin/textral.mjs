#!/usr/bin/env node
// Tiny shim. The CLI itself is in src/index.ts and is run via tsx in
// dev. For published builds, ship a compiled dist/index.js and update
// this shim's import to point at it.
import('../src/index.ts').catch((e) => {
  console.error('eval-cli failed:', e);
  process.exit(2);
});
