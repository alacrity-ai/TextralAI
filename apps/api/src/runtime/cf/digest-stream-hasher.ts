// Workers `crypto.DigestStream` → Hasher adapter. The Workers
// runtime exposes a streaming SHA-256 builder that lets us hash
// large uploads without buffering the bytes in memory.
//
// The Node side uses `node:crypto`'s `createHash` over a piped
// stream (see runtime/node/node-crypto-hasher.ts).

import type { Hasher } from '../shared/interfaces.js';

export class DigestStreamHasher implements Hasher {
  async sha256OfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    // `crypto.DigestStream` is a Workers-runtime-only API: it's not
    // declared by `lib.dom`, `lib.webworker`, or
    // `@cloudflare/workers-types` (as of writing). The `any` cast is
    // necessary because the type doesn't exist on the global crypto.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hashStream = new (globalThis as any).crypto.DigestStream('SHA-256');
    await stream.pipeTo(hashStream);
    const buf: ArrayBuffer = await hashStream.digest;
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
