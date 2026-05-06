// Redis-list → QueueProducer adapter. Mirrors V1's pattern:
// LPUSH onto a list, BRPOP from the consumer side. Single shared
// list across all producers; the consumer (Step 19) blocks on
// `BRPOP` against the same key.

import type Redis from 'ioredis';
import type { QueueProducer } from '../shared/interfaces.js';

export const QUEUE_KEY = 'textral:ingest';
export const DEAD_KEY = 'textral:ingest:dead';

export class RedisQueueProducer implements QueueProducer {
  constructor(private readonly redis: Redis) {}

  async send(message: unknown): Promise<void> {
    await this.redis.lpush(QUEUE_KEY, JSON.stringify(message));
  }
}
