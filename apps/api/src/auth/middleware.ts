// API-key authentication middleware.
//
// Order of operations (every /v1/* request):
//   1. Read X-Textral-Api-Key header. Reject if missing.
//   2. HMAC against the server-side pepper.
//   3. Cache lookup (KV, 60 s TTL) → resolved tenant.
//   4. On miss: SELECT tenant_id FROM api_keys WHERE key_hash = ?
//      AND revoked_at IS NULL.
//   5. Populate Hono context: tenant_id, api_key_id.
//   6. Best-effort fire-and-forget UPDATE last_used_at via bg.spawn.
//   7. On miss after DB lookup: throw TextralError(INVALID_API_KEY, 401).

import { createMiddleware } from 'hono/factory';
import { TextralError } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import { hmacKey } from './api-key.js';
import { readPepper } from './pepper.js';
import { readResolvedKey, writeResolvedKey } from './tenant-cache.js';
import { lookupApiKeyByHash, touchApiKeyLastUsed } from '../db/api-keys.js';

export const requireApiKey = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    const raw = c.req.header('X-Textral-Api-Key');
    if (!raw) {
      throw new TextralError('INVALID_API_KEY', 401, 'Missing X-Textral-Api-Key header');
    }

    const pepper = await readPepper(c.env);
    const keyHash = await hmacKey(pepper, raw);

    let resolved = await readResolvedKey(c.env.kv, keyHash);
    if (!resolved) {
      const row = await lookupApiKeyByHash(c.env.db, keyHash);
      if (!row) {
        throw new TextralError('INVALID_API_KEY', 401, 'API key invalid or revoked');
      }
      resolved = row;
      c.env.bg.spawn(writeResolvedKey(c.env.kv, keyHash, resolved));
    }

    c.set('tenant_id', resolved.tenant_id);
    c.set('api_key_id', resolved.api_key_id);
    c.set('api_key_scopes', resolved.scopes ?? []);

    // last_used_at is a soft signal; failure here doesn't fail the request.
    c.env.bg.spawn(
      touchApiKeyLastUsed(c.env.db, resolved.api_key_id).catch(() => undefined),
    );

    await next();
  },
);
