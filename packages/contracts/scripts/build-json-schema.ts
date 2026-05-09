// Build-time tool: walk every Zod schema exported from src/index.ts
// and emit a JSON Schema file per schema into dist/schemas/.
//
// The Python SDK's codegen pipeline reads from those files
// (`datamodel-code-generator` → Pydantic v2 models). Hooked into
// `prepublishOnly` via the `build` script so npm tarballs ship the
// schemas alongside the .d.ts files.
//
// Discriminated unions: `zod-to-json-schema` emits
// `oneOf` / `anyOf` shape, which `datamodel-code-generator` reads as
// `Union[A, B, ...]` (with `Annotated[..., Discriminator(...)]` when
// possible). See the Phase 2 design for the day-1 verification step.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as Contracts from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'dist', 'schemas');

mkdirSync(OUT, { recursive: true });

let emitted = 0;
const skipped: string[] = [];

for (const [name, value] of Object.entries(Contracts)) {
  if (!isZodSchema(value)) {
    skipped.push(name);
    continue;
  }
  // Skip the `ErrorCode` enum-of-strings — it's huge (60+ entries),
  // doesn't have a useful Pydantic representation beyond
  // `Literal[...]`, and Python callers don't construct it directly
  // (it appears only as a string field on `ErrorEnvelope`).
  // We keep `ErrorEnvelope` itself, which is what Python actually
  // needs.
  if (name === 'ErrorCode') {
    skipped.push(name);
    continue;
  }
  const schema = zodToJsonSchema(value, {
    name,
    target: 'jsonSchema7',
    // datamodel-code-generator handles definitions cleanly — keep
    // them so cross-references work.
    $refStrategy: 'root',
  });
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(schema, null, 2) + '\n');
  emitted++;
}

console.log(`build:schemas — emitted ${emitted} schemas to ${OUT}`);
if (skipped.length > 0) {
  console.log(`build:schemas — skipped non-Zod or excluded exports: ${skipped.length}`);
}

function isZodSchema(value: unknown): value is ZodType {
  if (!value || typeof value !== 'object') return false;
  // Zod marks schemas with a `_def` property that has a typeName.
  const v = value as { _def?: { typeName?: string } };
  return typeof v._def?.typeName === 'string';
}

// `z` re-exported just to silence the unused-import rule when running
// in the same module-graph as the contracts package.
void z;
