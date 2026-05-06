// JSON Schema validation for structured-output responses.
//
// Uses @cfworker/json-schema — purpose-built for the Cloudflare Workers
// runtime. Ajv 8 doesn't transform cleanly under vitest-pool-workers.

import { Validator } from '@cfworker/json-schema';

const cache = new Map<string, Validator>();

export interface StructuredValidation {
  ok: boolean;
  parsed: unknown;
  errors?: string[];
}

export function validateAgainstSchema(schema: object, candidate: unknown): StructuredValidation {
  const key = JSON.stringify(schema);
  let validator = cache.get(key);
  if (!validator) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validator = new Validator(schema as any, '2020-12');
    cache.set(key, validator);
  }
  const result = validator.validate(candidate);
  if (result.valid) return { ok: true, parsed: candidate };
  return {
    ok: false,
    parsed: candidate,
    errors: result.errors.map((e) => `${e.instanceLocation || '/'}: ${e.error}`),
  };
}

export function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
