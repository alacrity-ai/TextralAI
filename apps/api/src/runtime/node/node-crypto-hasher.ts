// node:crypto → Hasher adapter. Streams bytes through a SHA-256
// hash without buffering. Counterpart to the Workers-only
// `runtime/cf/digest-stream-hasher.ts`.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Hasher } from '../shared/interfaces.js';

export class NodeCryptoHasher implements Hasher {
  async sha256OfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const hash = createHash('sha256');
    const node = Readable.fromWeb(stream as never);
    for await (const chunk of node) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }
}
