# @textral/contracts

Zod schemas + TypeScript types for the [Textral](https://github.com/alacrity-ai/TextralAI) REST API. The single source of truth for request and response shapes shared between the API server, the SDK, the MCP server, and the sandbox UI.

## When to install

You probably want [`@textral/sdk`](https://npmjs.com/package/@textral/sdk) instead — it depends on this package and gives you a typed REST client. Install `@textral/contracts` directly only if:

- You're building a service in TypeScript that talks to a Textral API and you want the request/response types without pulling in the SDK's `fetch` machinery.
- You're building tooling that validates payloads against the wire contracts (e.g., a fixture generator, a contract-test harness, an OpenAPI cross-check).

## Install

```bash
npm install @textral/contracts
```

## What's inside

```ts
import {
  // Request schemas
  NamespaceCreate,
  IngestRequest,
  QueryRequest,
  ProviderKeyCreate,

  // Response shapes
  Namespace,
  Document,
  IngestionJob,
  Chunk,
  QueryResponse,
  QueryEvent,
  ProviderKey,
  KnownModel,

  // Error contracts
  TextralError,
  ErrorCode,
} from '@textral/contracts';
```

Every export is a `zod` schema with an inferred `.infer<typeof Schema>` type alias. The schemas double as the OpenAPI source — the API server's Scalar reference is generated directly from these shapes.

## Versioning

`@textral/contracts` ships in lockstep with `@textral/sdk` and `@textral/mcp`. Treat 0.x as pre-stable; breaking changes can land in any minor until 1.0.

## Links

- [Textral repository](https://github.com/alacrity-ai/TextralAI)
- [`@textral/sdk`](https://npmjs.com/package/@textral/sdk) — typed REST client built on these schemas
- [`@textral/mcp`](https://npmjs.com/package/@textral/mcp) — MCP server for agents

## License

MIT
