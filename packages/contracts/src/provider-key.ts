// BYOK provider-key contracts.
//
// Note the asymmetry: ProviderKeyCreate carries the raw key (it's the
// register-once payload, transmitted only over TLS into Secrets Store);
// ProviderKey is the metadata view returned by every other endpoint
// and never includes the raw key.

import { z } from 'zod';

export const ProviderName = z.enum(['openai', 'anthropic', 'cohere', 'voyage', 'workers_ai']);
export type ProviderName = z.infer<typeof ProviderName>;

export const ProviderKeyLabel = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'label must be lowercase alphanumerics, _ or -');

export const ProviderKeyCreate = z.object({
  provider: ProviderName,
  label: ProviderKeyLabel,
  /** The raw key. Stored encrypted at rest in Cloudflare Secrets Store
   *  and never returned by any other endpoint. */
  key: z.string().min(8).max(512),
});
export type ProviderKeyCreate = z.infer<typeof ProviderKeyCreate>;

export const ProviderKey = z.object({
  id: z.string(),
  provider: ProviderName,
  label: ProviderKeyLabel,
  prefix: z.string(),
  last_validated_at: z.number().nullable(),
  last_error_code: z.string().nullable(),
  created_at: z.number(),
});
export type ProviderKey = z.infer<typeof ProviderKey>;
