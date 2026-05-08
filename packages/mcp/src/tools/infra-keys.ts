// Infra-key tools — sister to provider-keys.ts. Tenant-scoped
// credentials for vector-store backends (Pinecone today; Qdrant Cloud /
// managed-Postgres later). At-most-one active per (tenant, provider) —
// rotation requires `revoke_infra_key` before re-registering.
//
// The raw key is write-only; the response strips it. `test_infra_key`
// issues a minimal upstream call to confirm the registered key is alive.

import { z } from 'zod';
import { InfraKeyCreate } from '@textral/contracts';
import { defineTool } from './types.js';

export const registerInfraKey = defineTool({
  name: 'register_infra_key',
  description:
    'Register a tenant-scoped vector-store credential (Pinecone today). At most one active key per (tenant, provider) — re-registering requires revoking the existing key first via revoke_infra_key. Raw key is stored encrypted server-side and never re-emitted.',
  inputSchemaZod: InfraKeyCreate,
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.infraKeys.create(args);
  },
});

export const listInfraKeys = defineTool({
  name: 'list_infra_keys',
  description: 'List active infra keys for the calling tenant (metadata only — never the raw key).',
  inputSchemaZod: z.object({}),
  handler: async ({ client, recordRestCall }) => {
    recordRestCall();
    return await client.infraKeys.list();
  },
});

export const testInfraKey = defineTool({
  name: 'test_infra_key',
  description:
    'Validate a registered infra key against its upstream provider (Pinecone: GET /indexes against api.pinecone.io). Updates last_validated_at + last_error_code on the stored row. Returns { ok: true } on success.',
  inputSchemaZod: z.object({ id: z.string().min(1) }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.infraKeys.test(args.id);
  },
});

export const revokeInfraKey = defineTool({
  name: 'revoke_infra_key',
  description:
    'Revoke an active infra key. Required before re-registering a new key for the same provider (at-most-one constraint). Existing namespaces using this provider will fail until a replacement is registered.',
  inputSchemaZod: z.object({ id: z.string().min(1) }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.infraKeys.revoke(args.id);
  },
});
