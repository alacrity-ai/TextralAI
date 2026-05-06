// KVNamespace → KvStore adapter. Translates the runtime-shared
// `KvStore` interface onto the Cloudflare KV binding API.
//
// TTL translation: KvStore uses `ttlSeconds`; KV uses `expirationTtl`.
// `type: 'json'` opt routes to KV's typed-get for one-call parsing.

import type { KvStore } from '../shared/interfaces.js';

export class CfKvStore implements KvStore {
  constructor(private readonly kv: KVNamespace) {}

  async get<T = string>(
    key: string,
    opts?: { type?: 'json' | 'text' },
  ): Promise<T | null> {
    if (opts?.type === 'json') {
      return (await this.kv.get<T>(key, 'json')) ?? null;
    }
    return ((await this.kv.get(key, 'text')) as T | null) ?? null;
  }

  async put(
    key: string,
    value: string,
    opts?: { ttlSeconds?: number },
  ): Promise<void> {
    await this.kv.put(
      key,
      value,
      opts?.ttlSeconds ? { expirationTtl: opts.ttlSeconds } : {},
    );
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
