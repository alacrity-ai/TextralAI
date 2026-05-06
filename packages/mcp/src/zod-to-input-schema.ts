// Convert a Zod schema into the JSON Schema 7 shape MCP clients
// expect on `tools/list`. Wraps `zod-to-json-schema` with our
// conventions:
//   * .strict() — extra fields are rejected (Open Question 2 lock)
//   * $refStrategy: 'none' — inline definitions; flat schemas read
//     better in tool-list responses
//   * strip $schema — some MCP clients tolerate it, some reject it

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export function toInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const strict = schema instanceof z.ZodObject ? schema.strict() : schema;
  const json = zodToJsonSchema(strict, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  });
  const obj = json as Record<string, unknown>;
  delete obj.$schema;
  return obj;
}
