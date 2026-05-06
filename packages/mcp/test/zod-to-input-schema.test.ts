// `toInputSchema` enforces the locked-in Zod-to-JSON-Schema
// conventions: strict() rejection of extra fields and stripped
// $schema field. Per Open Question 2.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toInputSchema } from '../src/zod-to-input-schema.js';

describe('toInputSchema', () => {
  it('produces JSON Schema 7 with additionalProperties: false', () => {
    const schema = toInputSchema(z.object({ x: z.number() })) as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    const properties = schema.properties as Record<string, { type: string }>;
    expect(properties.x?.type).toBe('number');
    expect(schema.required).toEqual(['x']);
  });

  it('strips the $schema field', () => {
    const schema = toInputSchema(z.object({})) as Record<string, unknown>;
    expect('$schema' in schema).toBe(false);
  });

  it('rejects extra fields on parse (locked .strict())', () => {
    const zodSchema = z.object({ x: z.number() }).strict();
    expect(() => zodSchema.parse({ x: 1, y: 'extra' })).toThrowError();
  });
});
