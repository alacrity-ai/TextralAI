// Namespace tools — Step 5 of the implementation plan. Three thin
// wrappers over the namespaces REST surface; input schemas derive
// from `@textral/contracts`.

import { z } from 'zod';
import { NamespaceCreate, NamespaceSlug } from '@textral/contracts';
import { defineTool } from './types.js';

export const createNamespace = defineTool({
  name: 'create_namespace',
  description:
    'Create a new namespace. Provisions the upstream vector backend (Qdrant collection or Pinecone reachability check).',
  inputSchemaZod: NamespaceCreate,
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.namespaces.create(args);
  },
});

export const listNamespaces = defineTool({
  name: 'list_namespaces',
  description: 'List every namespace the calling tenant owns.',
  inputSchemaZod: z.object({}),
  handler: async ({ client, recordRestCall }) => {
    recordRestCall();
    return await client.namespaces.list();
  },
});

export const getNamespace = defineTool({
  name: 'get_namespace',
  description: 'Fetch one namespace by slug. 404 if not found.',
  inputSchemaZod: z.object({ slug: NamespaceSlug }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.namespaces.get(args.slug);
  },
});
