// `textral://openapi` — the live /openapi.json document. Lets the
// agent discover any endpoint we haven't wrapped as a tool.

import type { ResourceDef } from './types.js';

export const openapiResource: ResourceDef = {
  uri: 'textral://openapi',
  name: 'Textral OpenAPI spec',
  description: 'The full /openapi.json document for the Textral REST API.',
  mimeType: 'application/json',
  read: async ({ client }) => {
    const res = await client.raw('/openapi.json');
    if (!res.ok) {
      throw new Error(`failed to fetch /openapi.json: HTTP ${res.status}`);
    }
    const text = await res.text();
    return {
      contents: [
        {
          uri: 'textral://openapi',
          mimeType: 'application/json',
          text,
        },
      ],
    };
  },
};
