// Verifies NodeCryptoHasher matches WebCrypto SHA-256 for the same
// input bytes. Both runtimes (CF DigestStreamHasher / Node
// NodeCryptoHasher) must produce identical hex digests so blob
// deduplication works across runtimes.

import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { NodeCryptoHasher } from '../../../src/runtime/node/node-crypto-hasher.js';

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function webcryptoHex(bytes: Uint8Array): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('NodeCryptoHasher.sha256OfStream', () => {
  it('matches WebCrypto for empty input', async () => {
    const hasher = new NodeCryptoHasher();
    const empty = new Uint8Array(0);
    const got = await hasher.sha256OfStream(streamOf(empty));
    const want = await webcryptoHex(empty);
    expect(got).toBe(want);
    expect(got).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches WebCrypto for "hello world"', async () => {
    const hasher = new NodeCryptoHasher();
    const bytes = new TextEncoder().encode('hello world');
    const got = await hasher.sha256OfStream(streamOf(bytes));
    expect(got).toBe(await webcryptoHex(bytes));
    expect(got).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });

  it('matches WebCrypto for multi-chunk streams', async () => {
    const hasher = new NodeCryptoHasher();
    const a = new TextEncoder().encode('foo');
    const b = new TextEncoder().encode('bar');
    const c = new TextEncoder().encode('baz');
    const all = new Uint8Array(a.length + b.length + c.length);
    all.set(a, 0);
    all.set(b, a.length);
    all.set(c, a.length + b.length);

    const multi = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(a);
        controller.enqueue(b);
        controller.enqueue(c);
        controller.close();
      },
    });
    const got = await hasher.sha256OfStream(multi);
    expect(got).toBe(await webcryptoHex(all));
  });
});
