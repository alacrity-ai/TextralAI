// Infra-key contracts. Sister to provider-key.ts; same shape, distinct
// table + resolution semantics.
//
// Provider keys are BYOK credentials for embedding/inference/rerank
// providers (OpenAI, Anthropic, Cohere, Voyage, Workers AI), picked
// at request time via `provider_key_ref`.
//
// Infra keys are credentials for vector-store backends (Pinecone today;
// Qdrant Cloud / managed Postgres in future). Picked implicitly by the
// namespace's `vector_backend` — at most one active per (tenant,
// provider). Operators rotate by revoke + re-register.

import { z } from 'zod';

/** Backends whose API credentials are tenant-scoped via this table.
 *  Vectorize is intentionally absent — it's bound at the Worker
 *  account level, no per-tenant key applies. */
export const InfraProviderName = z.enum(['pinecone']);
export type InfraProviderName = z.infer<typeof InfraProviderName>;

export const InfraKeyLabel = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'label must be lowercase alphanumerics, _ or -');

export const InfraKeyCreate = z.object({
  provider: InfraProviderName,
  label: InfraKeyLabel,
  /** The raw key. Stored encrypted at rest in Cloudflare Secrets Store
   *  (KV-backed shim today) and never returned by any other endpoint. */
  key: z.string().min(8).max(512),
});
export type InfraKeyCreate = z.infer<typeof InfraKeyCreate>;

export const InfraKey = z.object({
  id: z.string(),
  provider: InfraProviderName,
  label: InfraKeyLabel,
  prefix: z.string(),
  last_validated_at: z.number().nullable(),
  last_error_code: z.string().nullable(),
  created_at: z.number(),
});
export type InfraKey = z.infer<typeof InfraKey>;

export const InfraKeyTestResponse = z.object({
  ok: z.boolean(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
});
export type InfraKeyTestResponse = z.infer<typeof InfraKeyTestResponse>;
