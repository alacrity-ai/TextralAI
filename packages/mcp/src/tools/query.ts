// Query tools — Step 7. The headline `query` tool wraps the canonical
// retrieval-and-synthesis endpoint; the rest expose the audit /
// replay surface so an agent can introspect prior runs.

import { z } from 'zod';
import { QueryRequest, NamespaceSlug } from '@textral/contracts';
import { defineTool } from './types.js';

export const query = defineTool({
  name: 'query',
  description:
    'Run a citation-grounded query. Returns answer + citations + full audit. output.mode=structured returns JSON instead of text.',
  inputSchemaZod: QueryRequest,
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.query(args);
  },
});

export const listQueryEvents = defineTool({
  name: 'list_query_events',
  description: 'List recent query events for the calling tenant. Filter by namespace or status; cursor-paginated.',
  inputSchemaZod: z.object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
    namespace_slug: NamespaceSlug.optional(),
    status: z
      .enum([
        'received',
        'retrieval_started',
        'retrieval_completed',
        'synthesis_started',
        'completed',
        'failed',
      ])
      .optional(),
  }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    const q: { limit?: number; cursor?: string; namespace_slug?: string; status?: string } = {};
    if (args.limit !== undefined) q.limit = args.limit;
    if (args.cursor !== undefined) q.cursor = args.cursor;
    if (args.namespace_slug !== undefined) q.namespace_slug = args.namespace_slug;
    if (args.status !== undefined) q.status = args.status;
    return await client.queryEvents.list(q);
  },
});

export const getQueryEvent = defineTool({
  name: 'get_query_event',
  description: 'Fetch a single query audit row by id.',
  inputSchemaZod: z.object({ id: z.string() }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.queryEvents.get(args.id);
  },
});

export const getQueryResponse = defineTool({
  name: 'get_query_response',
  description:
    'Fetch the original mirrored answer for a historical query event. Surfaces 410 QUERY_RESPONSE_UNAVAILABLE if the mirror is missing.',
  inputSchemaZod: z.object({ id: z.string() }),
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.queryEvents.getResponse(args.id);
  },
});
