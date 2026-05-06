// RedisKvStore integration test against a testcontainers Redis.
//
// Covers:
//   - put + get round-trip (text default)
//   - put + get with `type: 'json'` parse
//   - get-missing returns null
//   - put with TTL: value visible immediately, gone after expiry

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import Redis from 'ioredis';
import { RedisKvStore } from '../../../src/runtime/node/redis-kv.js';

let container: StartedTestContainer;
let redis: Redis;
let kv: RedisKvStore;

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  redis = new Redis({
    host: container.getHost(),
    port: container.getMappedPort(6379),
    maxRetriesPerRequest: 5,
    connectTimeout: 10_000,
  });
  kv = new RedisKvStore(redis);
}, 60_000);

afterAll(async () => {
  redis.disconnect();
  await container.stop();
}, 30_000);

describe('RedisKvStore', () => {
  it('put + get text round-trip', async () => {
    await kv.put('k:text', 'hello');
    expect(await kv.get('k:text')).toBe('hello');
  });

  it('put + get json round-trip', async () => {
    await kv.put('k:json', JSON.stringify({ a: 1, b: ['x'] }));
    const got = await kv.get<{ a: number; b: string[] }>('k:json', { type: 'json' });
    expect(got).toEqual({ a: 1, b: ['x'] });
  });

  it('get returns null for missing keys', async () => {
    expect(await kv.get('k:nope')).toBeNull();
    expect(await kv.get('k:nope', { type: 'json' })).toBeNull();
  });

  it('put with TTL: value lives for the TTL window', async () => {
    await kv.put('k:ttl', 'transient', { ttlSeconds: 1 });
    expect(await kv.get('k:ttl')).toBe('transient');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await kv.get('k:ttl')).toBeNull();
  });

  it('delete removes the key', async () => {
    await kv.put('k:del', 'gone');
    await kv.delete('k:del');
    expect(await kv.get('k:del')).toBeNull();
  });
});
