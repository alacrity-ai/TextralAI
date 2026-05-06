// S3BlobStore integration test against a testcontainers MinIO. The
// adapter wraps @aws-sdk/client-s3 with `forcePathStyle: true`, which
// is what MinIO requires.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { S3BlobStore } from '../../../src/runtime/node/s3-blob-store.js';

const BUCKET = 'textral-test';

let container: StartedTestContainer;
let s3: S3Client;
let store: S3BlobStore;

beforeAll(async () => {
  container = await new GenericContainer('minio/minio:latest')
    .withCommand(['server', '/data'])
    .withEnvironment({
      MINIO_ROOT_USER: 'textral',
      MINIO_ROOT_PASSWORD: 'textral_dev',
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000).forStatusCode(200))
    .start();

  s3 = new S3Client({
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    region: 'us-east-1',
    credentials: { accessKeyId: 'textral', secretAccessKey: 'textral_dev' },
    forcePathStyle: true,
  });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  store = new S3BlobStore(s3, BUCKET);
}, 90_000);

afterAll(async () => {
  s3.destroy();
  await container.stop();
}, 30_000);

async function readBody(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(all);
}

describe('S3BlobStore', () => {
  it('put + get round-trip preserves bytes and contentType', async () => {
    const body = new TextEncoder().encode('hello blob');
    await store.put('k1', body, { contentType: 'text/plain' });
    const got = await store.get('k1');
    expect(got).not.toBeNull();
    expect(got!.contentType).toBe('text/plain');
    expect(got!.size).toBe(body.length);
    expect(await readBody(got!.body)).toBe('hello blob');
  });

  it('get returns null for missing keys', async () => {
    const got = await store.get('does-not-exist');
    expect(got).toBeNull();
  });

  it('head returns size + contentType + metadata', async () => {
    await store.put('k2', 'meta-payload', {
      contentType: 'application/json',
      metadata: { 'tenant-id': 't_1' },
    });
    const head = await store.head('k2');
    expect(head).not.toBeNull();
    expect(head!.contentType).toBe('application/json');
    expect(head!.size).toBe('meta-payload'.length);
    expect(head!.metadata?.['tenant-id']).toBe('t_1');
  });

  it('head returns null for missing keys', async () => {
    expect(await store.head('does-not-exist')).toBeNull();
  });

  it('delete removes the object', async () => {
    await store.put('k3', 'tmp');
    await store.delete('k3');
    expect(await store.get('k3')).toBeNull();
  });

  it('put accepts a ReadableStream body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed-'));
        controller.enqueue(new TextEncoder().encode('payload'));
        controller.close();
      },
    });
    await store.put('k4', stream, { contentType: 'text/plain' });
    const got = await store.get('k4');
    expect(await readBody(got!.body)).toBe('streamed-payload');
  });
});
