# @textral/sdk

Typed TypeScript REST client for the [Textral](https://github.com/alacrity-ai/TextralAI) RAG API. One method per route, every response shaped by `@textral/contracts`. Streaming queries, retry/backoff, AbortSignal cancellation, async pagination iterators, and `~/.textral/profiles.toml` resolution out of the box.

```bash
npm install @textral/sdk
```

## Quick start

```ts
import { TextralClient } from '@textral/sdk';

// Profile mode — credentials lazy-resolved from ~/.textral/profiles.toml.
const client = new TextralClient({ profile: 'hosted-prod' });

const r = await client.query({
  namespace: 'cookbook',
  query: 'What survived the Library of Alexandria?',
  embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536 },
  inference:  { provider: 'openai', model: 'gpt-4o-mini' },
});

console.log(r.answer);
```

## Configuration

Three ways to point the client at an endpoint:

```ts
// 1. Explicit credentials (eager).
new TextralClient({ baseUrl: 'https://api.textral.alacrity.ai', apiKey: 'tx_live_…' });

// 2. Profile name — lazy resolved on first request.
new TextralClient({ profile: 'hosted-prod' });

// 3. Profile name — eager resolution. Errors at construction time.
const client = await TextralClient.fromProfile('hosted-prod');
```

Full options:

```ts
new TextralClient({
  baseUrl?:   string,
  apiKey?:    string,
  profile?:   string,                    // ~/.textral/profiles.toml
  retry?:     RetryPolicy | false,       // default: see below
  fetch?:     typeof globalThis.fetch,   // override for tests
  timeoutMs?: number,                    // default 30_000; 0 = disabled
});
```

## Profiles

The `~/.textral/profiles.toml` resolver lives in [`@textral/profiles`](https://www.npmjs.com/package/@textral/profiles); the SDK re-exports it for convenience.

```toml
default = "hosted-prod"

[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_..."

[profiles.hosted-prod]
base_url = "https://api.textral.alacrity.ai"
api_key  = "tx_live_..."
```

Precedence chain (top → bottom, first match wins):

1. Constructor `{ baseUrl, apiKey }`
2. `name` argument → file lookup
3. `TEXTRAL_PROFILE` env var → file lookup
4. File's `default = "..."` field
5. Lex-first profile in the file
6. Synth `_env` profile from `TEXTRAL_BASE_URL` + `TEXTRAL_API_KEY`
7. Throws `TextralProfileNotFound`

The same file is consumed by `@textral/mcp`. One source of truth.

## Resources

Every public REST route maps to one method. Resource blocks group related endpoints.

```ts
client.me()
client.namespaces.{list,create,get,listDocuments,iterateDocuments}
client.documents.{register,get,createUpload,putUploadBytes,finalize,ingest,listChunks,iterateChunks}
client.chunks.{get}
client.ingestionJobs.{get,retry}
client.query(body)              // sync JSON
client.query.stream(body)       // SSE async iterator
client.queryEvents.{list,get,getResponse,iterate}
client.providerKeys.{list,create,test}
client.infraKeys.{list,create,test,revoke}
client.bulkIngest.{submit,finalize,get,files,iterateFiles,cancel,retry,list,iterate,uploadUrlFor}
client.admin.{listFailingJobs,iterateFailingJobs}
client.models.{list}
```

## Streaming

`client.query.stream(body)` returns an async iterable of typed SSE frames. Streams are **not retried** (per design — a partially-consumed response can't be replayed cleanly). On interruption, an iteration throws `TextralStreamInterrupted` with the underlying cause.

```ts
import { TextralStreamInterrupted } from '@textral/sdk';

try {
  for await (const frame of client.query.stream({ ... })) {
    switch (frame.type) {
      case 'token':    process.stdout.write(frame.value); break;
      case 'citation': console.error(`[${frame.ordinal}] ${frame.section_path}`); break;
      case 'audit':    console.error(`audit: ${frame.query_event_id}`); break;
    }
  }
} catch (e) {
  if (e instanceof TextralStreamInterrupted) {
    // Caller decides whether to re-issue the whole query.
  } else throw e;
}
```

## Retry & backoff

Default: **3 attempts**, exponential backoff with ±25% jitter, `Retry-After` honored, retries 429/502/503/504. GET and DELETE always retried; POST only when on the idempotent allowlist (auth-redeem, bulk submit, finalize endpoints — server-side dedupe makes them safe).

```ts
new TextralClient({
  baseUrl, apiKey,
  retry: {
    maxAttempts: 5,
    initialDelayMs: 500,
    maxDelayMs: 8_000,
    retryOn: [429, 502, 503, 504],
    onRetry: ({ attempt, status, delayMs }) =>
      console.error(`retry #${attempt}: ${status} → sleep ${delayMs}ms`),
  },
});

// Disable retries entirely:
new TextralClient({ baseUrl, apiKey, retry: false });
```

When the policy gives up, throws `TextralRetryExhausted` whose `.cause` carries the last underlying error:

```ts
import { TextralRetryExhausted } from '@textral/sdk';

try { await client.query(...); }
catch (e) {
  if (e instanceof TextralRetryExhausted) {
    console.error(`gave up after ${e.attempts} tries: ${e.cause}`);
  }
}
```

## Pagination

Every paginated list method has an `iterate()` sibling that walks `next_cursor` automatically.

```ts
for await (const ev of client.queryEvents.iterate({ namespace_slug: 'docs' })) {
  // ev: QueryEvent
}
```

Aborts cleanly via `{ signal }`:

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 5_000);

for await (const doc of client.namespaces.iterateDocuments('docs', {}, { signal: ac.signal })) {
  // ...
}
```

Available iterators:

```ts
client.namespaces.iterateDocuments(slug)
client.documents.iterateChunks(id)
client.queryEvents.iterate({ ... })
client.bulkIngest.iterate({ ... })
client.bulkIngest.iterateFiles(id)
client.admin.iterateFailingJobs()
```

## Cancellation

Every public method takes an optional `{ signal: AbortSignal }`. Aborting cancels the in-flight HTTP request **and** any pending retry-backoff sleep.

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 1_000);
await client.namespaces.list({ signal: ac.signal });
```

Per-request timeouts are configured at the client level (`timeoutMs`, default 30s) and compose with caller signals — whichever fires first wins.

## Bulk ingest orchestrator

For multi-file ingestion, `bulkIngestOrchestrate(client, ...)` drives the full choreography (manifest → parallel uploads → poll until terminal):

```ts
import { bulkIngestOrchestrate } from '@textral/sdk';

const result = await bulkIngestOrchestrate(client, {
  namespace: 'docs',
  config: {
    embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536 },
    chunking: { profile: 'generic', target_tokens: 600, overlap_tokens: 80 },
    mode: 'full',
  },
  files: [{ filename, bytes, size_bytes, content_type }, ...],
  on_existing: 'skip_if_unchanged',
  auto_finalize: true,
  concurrency: 4,
  onProgress: (snap) => console.log(snap.state, snap.progress_pct),
});
```

## Errors

All errors extend `TextralError`. Concrete classes:

| Class | When |
|---|---|
| `TextralApiError` | Server returned a 4xx/5xx with the canonical envelope. `.code`, `.status`, `.requestId`, `.details`, `.retryAfter`. |
| `TextralRetryExhausted` | Retry policy gave up after N attempts. `.attempts`, `.cause`. |
| `TextralStreamInterrupted` | SSE stream ended without `[DONE]`. `.cause`. |
| `TextralProfileNotFound` | Profile name not found, or no precedence rung produced credentials. |

## Cookbook

[`examples/`](./examples) has 7 paste-and-run scripts:

| File | Concept |
|---|---|
| `01-quick-start.ts` | One query, one cited answer |
| `02-ingest-and-query.ts` | Single-file ingest pipeline |
| `03-bulk-ingest.ts` | Bulk orchestrator |
| `04-streaming.ts` | SSE streaming |
| `05-profiles.ts` | `~/.textral/profiles.toml` |
| `06-retry-and-cancel.ts` | Retry policy + cancellation |
| `07-paginate-events.ts` | Pagination iterators |

## Versioning

Released in lockstep with `@textral/{contracts,profiles,mcp}`. The contracts package is the source of truth; SDK methods derive their typed shapes from it. A bump to one is a bump to all.

The 0.x line is sub-1.0; minor bumps may include breaking changes. The 1.0 commitment locks the public surface — see the [SDKs design plan](https://github.com/alacrity-ai/TextralAI/blob/main/docs/development/sdks/SDKS_DESIGN_PLAN.md) for the timeline.

## License

MIT.
