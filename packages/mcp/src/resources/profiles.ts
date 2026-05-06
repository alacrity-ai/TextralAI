// `textral://profiles` — the corpus profile registry. Lets the
// agent answer "what does the legal profile do?" without an extra
// REST call.

import type { ResourceDef } from './types.js';

export const profilesResource: ResourceDef = {
  uri: 'textral://profiles',
  name: 'Textral corpus profiles',
  description:
    'Registry of corpus profiles (chunking + enrichment + retrieval defaults), shipped via /v1/profiles.',
  mimeType: 'application/json',
  read: async ({ client }) => {
    const res = await client.raw('/v1/profiles');
    if (!res.ok) {
      throw new Error(`failed to fetch /v1/profiles: HTTP ${res.status}`);
    }
    const text = await res.text();
    return {
      contents: [
        {
          uri: 'textral://profiles',
          mimeType: 'application/json',
          text,
        },
      ],
    };
  },
};
