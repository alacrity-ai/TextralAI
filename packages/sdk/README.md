# @textral/sdk

Typed TypeScript REST client for the [Textral](https://github.com/alacrity-ai/TextralAI) RAG API. One method per route, every response shaped by `@textral/contracts`.

## Install

```bash
npm install @textral/sdk
```

## Usage

```ts
import { TextralClient } from '@textral/sdk';

const client = new TextralClient({
  baseUrl: 'https://textral-api-dev.leif-e24.workers.dev',
  apiKey: process.env.TEXTRAL_API_KEY!,
});

// Tenancy
const me = await client.me();
console.log(me.tenant.id, me.runtime); // 'ten_abc', 'cf'

// Namespaces
const namespaces = await client.namespaces.list();
const ns = await client.namespaces.create({
  slug: 'my-corpus',
  vector_backend: 'vectorize',
});

// Ingest
const doc = await client.documents.register('my-corpus', {
  title: 'Quick brown fox',
  doc_type: 'passage',
});
const upload = await client.documents.createUpload(doc.id, {
  content_type: 'text/markdown',
  size_bytes: bytes.byteLength,
});
await client.documents.putUploadBytes(upload.url, bytes, 'text/markdown');
const fin = await client.documents.finalize(doc.id, upload.upload_id);
await client.documents.ingest(doc.id, {
  version_id: fin.version_id,
  embedding: { provider: 'openai', model: 'text-embedding-3-large' },
  chunking: {},
  mode: 'embed_only',
});

// Query
const response = await client.query({
  namespace: 'my-corpus',
  query: 'What does the fox do?',
  embedding: { provider: 'openai', model: 'text-embedding-3-large' },
  inference: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  // ... other config; see @textral/contracts QueryRequest
});
```

## Surface

| Group | Methods |
|---|---|
| Tenancy | `me()` |
| Namespaces | `namespaces.{list,create,get,listDocuments}` |
| Documents | `documents.{register,get,createUpload,putUploadBytes,finalize,ingest,listChunks}` |
| Chunks | `chunks.get` |
| Ingestion jobs | `ingestionJobs.{get,retry}` |
| Query | `query`, `queryEvents.{list,get,getResponse}` |
| Provider keys | `providerKeys.{list,create,test}` |
| Admin | `admin.listFailingJobs` |
| Models | `models.list` |

Every method returns a fully-typed response per the corresponding `@textral/contracts` schema. Errors throw `TextralApiError` with `status`, `code`, `message`, and `request_id` fields.

## Error handling

```ts
import { TextralClient, TextralApiError } from '@textral/sdk';

try {
  await client.namespaces.get('does-not-exist');
} catch (e) {
  if (e instanceof TextralApiError && e.code === 'NAMESPACE_NOT_FOUND') {
    // handle gracefully
  } else {
    throw e;
  }
}
```

## Versioning

`@textral/sdk` ships in lockstep with `@textral/contracts` and `@textral/mcp`. Treat 0.x as pre-stable; breaking changes can land in any minor until 1.0.

## Links

- [Textral repository](https://github.com/alacrity-ai/TextralAI)
- [`@textral/contracts`](https://npmjs.com/package/@textral/contracts) — Zod schemas this client uses
- [`@textral/mcp`](https://npmjs.com/package/@textral/mcp) — MCP server for agents (built on this SDK)

## License

MIT
