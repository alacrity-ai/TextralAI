// CF wrapper: iterate a Workers `MessageBatch`, dispatch each message
// to `runIngestMessage`, then call `msg.ack()` / `msg.retry()`.
//
// `Bindings` is built once per batch (not per message) by the worker
// default export.

import {
  runIngestMessage,
  type IngestQueueMessage,
} from '../../ingestion/ingest-message.js';
import type { Bindings } from '../shared/interfaces.js';

export type { IngestQueueMessage };

export async function processIngestQueue(
  batch: MessageBatch<IngestQueueMessage>,
  bindings: Bindings,
): Promise<void> {
  for (const msg of batch.messages) {
    const result = await runIngestMessage(msg.body, bindings);
    if (result.ack) msg.ack();
    else msg.retry();
  }
}
