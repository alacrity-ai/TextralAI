// Read-only contextual resource. Resources surface system knowledge
// (OpenAPI spec, profiles, error catalog) — not tenant data, which
// belongs in tools.

import type { TextralClient } from '@textral/sdk';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

export interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: (ctx: { client: TextralClient }) => Promise<ReadResourceResult>;
}
