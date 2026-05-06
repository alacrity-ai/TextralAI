// `textral://error-catalog` — every error code Textral can emit,
// paired with when it fires and the recommended recovery. The agent
// uses this to interpret error responses without a parsed Scalar
// page.

import type { ResourceDef } from './types.js';

export const errorCatalogResource: ResourceDef = {
  uri: 'textral://error-catalog',
  name: 'Textral error catalog',
  description: 'Structured error catalog (code → http/when/recovery), served by /v1/error-catalog.',
  mimeType: 'application/json',
  read: async ({ client }) => {
    const res = await client.raw('/v1/error-catalog');
    if (!res.ok) {
      throw new Error(`failed to fetch /v1/error-catalog: HTTP ${res.status}`);
    }
    const text = await res.text();
    return {
      contents: [
        {
          uri: 'textral://error-catalog',
          mimeType: 'application/json',
          text,
        },
      ],
    };
  },
};
