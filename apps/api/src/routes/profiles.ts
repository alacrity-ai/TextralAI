// GET /v1/profiles — corpus profile registry. Backs the
// `textral://profiles` MCP resource. Read-only; tenant-scoped only
// because every /v1/* route runs under requireApiKey.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { listProfiles } from '@textral/corpus-profiles';
import type { Env, Variables } from '../types.js';
import { z } from '../openapi/z.js';
import { Responses } from '../openapi/registry.js';

export const profilesRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const ProfileEntry = z
  .object({
    id: z.string(),
    description: z.string().nullable(),
  })
  .passthrough()
  .openapi('CorpusProfileEntry');

const ProfilesListResponse = z
  .object({ data: z.array(ProfileEntry) })
  .openapi('CorpusProfileListResponse');

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Meta'],
  summary: 'List corpus profiles',
  description:
    'Returns the corpus profile registry — the same data that drives chunking + enrichment + retrieval defaults at namespace-create time.',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Profile registry.',
      content: { 'application/json': { schema: ProfilesListResponse } },
    },
    401: Responses.unauthorized,
  },
});

profilesRoute.openapi(listRoute, (c) => {
  const profiles = listProfiles().map((p) => ({
    id: p.id,
    description: p.description ?? null,
    chunking: p.chunking,
    retrieval_defaults: p.retrieval_defaults,
    prompt_defaults: p.prompt_defaults,
    enrichment: p.enrichment,
  }));
  return c.json({ data: profiles }, 200);
});
