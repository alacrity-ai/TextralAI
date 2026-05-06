// Self-host queue consumer. Node-runtime sibling of
// `runtime/cf/queue-consumer.ts`. The CF version walks a `MessageBatch`
// and translates the per-message result into ack()/retry(); the
// Node version `BRPOP`s a Redis list and re-LPUSHes (or
// dead-letters) on retry.
//
// Same per-message dispatch: `runIngestMessage(msg, bindings)`. The
// container call, retry policy, and outcome handling are
// runtime-agnostic — only the queue plumbing forks.
//
// Lifecycle: SIGTERM exits the loop, drains in-flight bg tasks, and
// closes pool/redis. The BRPOP timeout is 5s so shutdown converges
// quickly even under low queue traffic.

import { buildNodeBindings } from '../bindings.js';
import {
  runIngestMessage,
  type IngestQueueMessage,
} from '../../../ingestion/ingest-message.js';
import { QUEUE_KEY, DEAD_KEY } from '../redis-queue.js';

const MAX_ATTEMPTS = 3;
const POLL_TIMEOUT_SEC = 5;

const ctx = buildNodeBindings(process.env);

console.log(
  JSON.stringify({
    event: 'ingest_consumer_started',
    queue: QUEUE_KEY,
    runtime: 'node',
  }),
);

let stopped = false;
let shuttingDown = false;
const stop = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopped = true;
  console.log(JSON.stringify({ event: 'consumer_shutdown', signal }));
  await ctx.bg.drain();
  await ctx.pgPool.end();
  ctx.redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

while (!stopped) {
  const popped = await ctx.redis.brpop(QUEUE_KEY, POLL_TIMEOUT_SEC);
  if (!popped) continue;
  const [, raw] = popped;
  let msg: IngestQueueMessage;
  try {
    msg = JSON.parse(raw) as IngestQueueMessage;
  } catch (e) {
    console.error(
      JSON.stringify({
        event: 'consumer_bad_message',
        raw,
        message: String((e as Error).message),
      }),
    );
    await ctx.redis.lpush(DEAD_KEY, raw);
    continue;
  }
  const result = await runIngestMessage(msg, ctx.bindings);
  if (!result.ack) {
    if (msg.attempt + 1 >= MAX_ATTEMPTS) {
      await ctx.redis.lpush(
        DEAD_KEY,
        JSON.stringify({ ...msg, dead_reason: result.reason ?? 'unknown' }),
      );
      console.warn(
        JSON.stringify({
          event: 'consumer_dead_lettered',
          job_id: msg.job_id,
          attempt: msg.attempt,
          ...(result.reason ? { reason: result.reason } : {}),
        }),
      );
    } else {
      await ctx.redis.lpush(
        QUEUE_KEY,
        JSON.stringify({ ...msg, attempt: msg.attempt + 1 }),
      );
    }
  }
}
