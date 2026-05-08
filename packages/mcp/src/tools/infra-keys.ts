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
    'Register a tenant-scoped vector-store credential (Pinecone). At most one active per provider — revoke before rotating. Raw key never re-emitted.',
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
    'Validate a registered infra key against its upstream provider (e.g. Pinecone GET /indexes). Updates last_validated_at and last_error_code on the row.',
  inputSchemaZod: z.object({ id: z.string().min(1) }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.infraKeys.test(args.id);
  },
});

export const revokeInfraKey = defineTool({
  name: 'revoke_infra_key',
  description:
    'Revoke an active infra key. Required before re-registering for the same provider. Namespaces using this backend will fail until a replacement is registered.',
  inputSchemaZod: z.object({ id: z.string().min(1) }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.infraKeys.revoke(args.id);
  },
});
