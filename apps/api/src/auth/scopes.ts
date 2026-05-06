// Scope-check helper.
//
// Scopes live on the resolved API key (api_keys.scopes JSON array).
// `'*'` is the wildcard — useful for the bootstrap key. Specific
// scopes (e.g. 'admin') gate admin endpoints.

import type { Context } from 'hono';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../types.js';

export function hasScope(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  scope: string,
): boolean {
  const scopes = c.get('api_key_scopes') ?? [];
  return scopes.includes('*') || scopes.includes(scope);
}

export function requireScope(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  scope: string,
): void {
  if (!hasScope(c, scope)) {
    throw new TextralError(
      'INSUFFICIENT_SCOPE',
      403,
      `This endpoint requires the '${scope}' scope`,
    );
  }
}
