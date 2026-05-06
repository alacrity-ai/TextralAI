// Models registry tool. One thin wrapper over GET /v1/models so the
// agent can ask "what models are available?" without scraping docs.

import { ListModelsQuery } from '@textral/contracts';
import { defineTool } from './types.js';

export const listModels = defineTool({
  name: 'list_models',
  description:
    'List the curated registry of known models per provider/kind. Filters: provider, kind (embedding|inference|rerank), include_deprecated.',
  inputSchemaZod: ListModelsQuery,
  handler: async ({ args, client, recordRestCall }) => {
    recordRestCall();
    return await client.models.list(args);
  },
});
