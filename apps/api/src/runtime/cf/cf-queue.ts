// Cloudflare Queue → QueueProducer adapter. Trivial passthrough.

import type { QueueProducer } from '../shared/interfaces.js';

export class CfQueueProducer implements QueueProducer {
  constructor(private readonly q: Queue<unknown>) {}
  async send(message: unknown): Promise<void> {
    await this.q.send(message);
  }
}
