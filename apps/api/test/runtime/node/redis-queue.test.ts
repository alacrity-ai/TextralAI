// RedisQueueProducer + BRPOP consumer round-trip via a testcontainers
// Redis. We don't spin up the full ingest-consumer entrypoint here
// (that requires Postgres + MinIO too) — instead we exercise the
// LPUSH semantics from RedisQueueProducer and the BRPOP semantics
// the consumer uses, both against the same shared QUEUE_KEY.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import Redis from 'ioredis';
import {
  RedisQueueProducer,
  QUEUE_KEY,
  DEAD_KEY,
} from '../../../src/runtime/node/redis-queue.js';

let container: StartedTestContainer;
let redis: Redis;
let queue: RedisQueueProducer;

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  redis = new Redis({
    host: container.getHost(),
    port: container.getMappedPort(6379),
    // Generous retry budget to absorb container cold-start jitter on
    // contended CI / dev hosts; commands themselves are cheap.
    maxRetriesPerRequest: 5,
    connectTimeout: 10_000,
  });
  queue = new RedisQueueProducer(redis);
}, 60_000);

afterAll(async () => {
  redis.disconnect();
  await container.stop();
}, 30_000);

describe('RedisQueueProducer', () => {
  it('LPUSHes to the shared QUEUE_KEY; BRPOP receives same payload', async () => {
    const msg = { job_id: 'job_a', tenant_id: 't_1', attempt: 0 };
    await queue.send(msg);
    const popped = await redis.brpop(QUEUE_KEY, 5);
    expect(popped).not.toBeNull();
    const [, raw] = popped!;
    expect(JSON.parse(raw)).toEqual(msg);
  });

  it('preserves FIFO order across multiple sends', async () => {
    await queue.send({ id: 1 });
    await queue.send({ id: 2 });
    await queue.send({ id: 3 });
    const popped: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await redis.brpop(QUEUE_KEY, 5);
      const m = JSON.parse(r![1]) as { id: number };
      popped.push(m.id);
    }
    expect(popped).toEqual([1, 2, 3]);
  });

  it('exports the dead-letter key separate from the live queue', () => {
    expect(QUEUE_KEY).toBe('textral:ingest');
    expect(DEAD_KEY).toBe('textral:ingest:dead');
    expect(QUEUE_KEY).not.toBe(DEAD_KEY);
  });

  it('BRPOP returns null when the queue is empty after the timeout', async () => {
    // Make sure the queue is drained.
    while ((await redis.brpop(QUEUE_KEY, 1)) !== null) {
      // drain
    }
    const r = await redis.brpop(QUEUE_KEY, 1);
    expect(r).toBeNull();
  });
});
