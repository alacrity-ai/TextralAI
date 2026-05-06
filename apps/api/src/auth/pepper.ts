// Read the API-key pepper.
//
// Production: bound via Cloudflare Secrets Store, exposed as a
//   `SecretsStoreSecret` with a `.get()` method.
// Tests: bound as a plain string via miniflare.bindings — easier than
//   stubbing a real Secrets Store. The shape difference is hidden here.
//
// If the pepper is missing or empty we throw — never proceed with a
// blank pepper.

import type { Env } from '../types.js';
import { TextralError } from '@textral/contracts';

export async function readPepper(env: Env): Promise<string> {
  const binding = env.API_KEY_PEPPER as unknown;
  let value: string | undefined;
  if (typeof binding === 'string') {
    value = binding;
  } else if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    value = await (binding as { get: () => Promise<string> }).get();
  }
  if (!value) {
    throw new TextralError('INTERNAL', 500, 'API_KEY_PEPPER not configured');
  }
  return value;
}
