// Provider-key tools — Step 8. BYOK registration + listing. The raw
// key is write-only; ProviderKey response shape strips it.

import { z } from 'zod';
import { ProviderKeyCreate } from '@textral/contracts';
import { defineTool } from './types.js';

export const registerProviderKey = defineTool({
  name: 'register_provider_key',
  description:
    'Register a BYOK provider key. The raw key is stored encrypted server-side and never re-emitted. Use list_provider_keys to read metadata.',
  inputSchemaZod: ProviderKeyCreate,
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.providerKeys.create(args);
  },
});

export const listProviderKeys = defineTool({
  name: 'list_provider_keys',
  description: 'List BYOK provider keys for the calling tenant (metadata only — never the raw key).',
  inputSchemaZod: z.object({}),
  handler: async ({ client, recordRestCall }) => {
    recordRestCall();
    return await client.providerKeys.list();
  },
});
