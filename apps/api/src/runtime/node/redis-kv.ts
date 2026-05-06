// Redis → KvStore adapter. Wraps `ioredis` for the self-host
// runtime's KV backing. TTL via `EX` seconds.
//
// Single-instance only; cluster / sentinel modes are operator's
// configuration concern (the `Redis` constructor accepts both).

import type Redis from 'ioredis';
import type { KvStore } from '../shared/interfaces.js';

export class RedisKvStore implements KvStore {
  constructor(private readonly redis: Redis) {}

  async get<T = string>(
    key: string,
    opts?: { type?: 'json' | 'text' },
  ): Promise<T | null> {
    const v = await this.redis.get(key);
    if (v === null) return null;
    if (opts?.type === 'json') return JSON.parse(v) as T;
    return v as unknown as T;
  }

  async put(
    key: string,
    value: string,
    opts?: { ttlSeconds?: number },
  ): Promise<void> {
    if (opts?.ttlSeconds) {
      await this.redis.set(key, value, 'EX', opts.ttlSeconds);
    } else {
      await this.redis.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
