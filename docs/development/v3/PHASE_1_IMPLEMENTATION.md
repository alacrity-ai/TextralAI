# V3 Phase 1 — Implementation Steps

> Companion to `docs/v3/PHASE-1_DETAILED_DESIGN.md`. Concrete, ordered
> steps. A dev follows this end-to-end and at the close has shipped
> everything Phase 1 promises: vector store pluggability (Vectorize +
> Qdrant + Pinecone), per-namespace backend selection, a dev
> docker-compose stack, validator parity across all three backends.
>
> **No open questions.** Where the design doc left a choice open,
> this document picks one and stays with it.

---

## At completion, you will have

- Three vector store adapters implementing one `VectorStore`
  interface: Vectorize V2 (existing, refactored into its own file),
  Qdrant (new), Pinecone (new).
- A `VectorBinding` shape threaded through retrieval and ingest
  call sites — every `vectorStoreFor(...)` invocation reads the
  backend + index name from a namespace or version_index row, not
  a hard-coded embedding profile string.
- Migration `0006_namespace_vector_backend.sql` adding
  `vector_backend` + `vector_index_name` columns to `namespaces`
  AND `version_indexes`. Existing rows default to `'vectorize'` /
  `NULL`; no behavior change on V2 deploys.
- A Qdrant adapter that auto-creates collections at namespace-
  creation time (idempotent).
- A Pinecone adapter that points at an operator-provisioned
  serverless index host URL stored in `vector_index_name`. Fails
  fast with a clear error if the index doesn't exist.
- `infrastructure/docker/docker-compose.dev.yml` running Qdrant +
  the ingest Container locally; `make dev-stack` brings them up.
- `apps/api/scripts/validate-cookbook.ts --backend
  vectorize|qdrant|pinecone` runs all eight cookbook patterns
  against the chosen backend; all 24 (8 × 3) live-validate against
  deployed dev.
- Documentation: Namespaces tag description carries the vector-
  backend selection rules + the Qdrant / Pinecone tradeoffs;
  `register-namespace` code samples have variants per backend.

By the end of this guide a contributor can `make dev-stack`, run
the api Worker via `wrangler dev --remote --env dev`, exercise the
end-to-end ingest + query flow against a local Qdrant, and the
deployed dev environment supports `POST /v1/namespaces` with
`vector_backend: 'qdrant'` or `'pinecone'`.

---

## What this implementation specifically does NOT do

- **No D1 → Postgres migration.** That's Phase 2.
- **No KV → Redis, R2 → S3, Queues → Redis-lists, Worker → Node
  port.** All Phase 2.
- **No `frontend` / admin console.** Out of scope.
- **No data migration tool from Vectorize → Qdrant.** Tenants
  who want to switch backends create a new namespace + re-ingest
  under `mode='full'`. We document but do not ship a copy script.
- **No automatic Pinecone index creation.** Pinecone account-level
  index provisioning (region, tier, dimensions) is operator-side
  via the Pinecone dashboard or REST API. The adapter consumes the
  host URL and fails fast if the index doesn't exist.
- **No Vectorize → Qdrant collection lifecycle on namespace
  delete.** Soft-delete leaves the upstream Qdrant collection in
  place; documented as a Phase 2 follow-on.
- **No tearing apart `provider-keys` table to add Pinecone as a
  "provider key."** Pinecone is a vector store, not an LLM
  provider; configuration lives at the namespace + env level.

---

## Prerequisites

Already true at the end of Phase 5 audit cleanup:

- `apps/api/src/retrieval/vector-store.ts` defines `VectorStore`
  interface + `class VectorizeV2Adapter` + `vectorStoreFor(env,
  embeddingProfile)`.
- `env.VECTORIZE_OPENAI_LARGE` is referenced in exactly two places:
  `apps/api/src/types.ts` (binding type) and
  `apps/api/src/retrieval/vector-store.ts` (adapter).
- `apps/api/src/retrieval/vectorize-query.ts` is a thin shim around
  `vectorStoreFor`; called by `apps/api/src/retrieval/hybrid.ts`
  via `denseQuery(env, args)`.
- `tools/check-no-inline-d1.sh` allows two exceptions
  (`ingestion/lease.ts`, `audit/query-events.ts`); all other D1
  access is in `apps/api/src/db/*.ts`.
- The cookbook validator (`apps/api/scripts/validate-cookbook.ts`)
  defines 8 patterns end-to-end and currently runs against a
  fixed namespace.

Operational prerequisites:

- `pnpm` and Node 24.
- Cloudflare API token (in `DO_NOT_COMMIT.md`) for `make
  deploy-dev` / `make migrate-dev`.
- A working V2 dev deploy.
- A Pinecone account + a serverless index pre-provisioned with
  dimensions=1536 (we'll use `cookbook-pinecone` as the index
  name); API key in `DO_NOT_COMMIT.md`.
- Docker / Docker Compose v2 installed locally.

---

## Locked-in technology choices

### Vector backend selection

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Where backend is selected | **Per-namespace, locked at create time** | Switching backends mid-life requires re-ingest under a new namespace; mirrors how `corpus_profile` works. |
| Selection field | **`namespaces.vector_backend ∈ {'vectorize','qdrant','pinecone'}`** | Plain SQL string column. Default `'vectorize'` for back-compat. |
| Per-backend handle | **`namespaces.vector_index_name TEXT NULL`** — opaque to the consumer; meaningful to the adapter | Vectorize: NULL (binding is global). Qdrant: collection name. Pinecone: full host URL (e.g. `https://cookbook-xxx.svc.us-east-1.pinecone.io`). |
| Denormalization | **Both columns also live on `version_indexes`** | Ingest hot path reads `vidx` rows; this avoids a namespace lookup per upsert. |
| Selector signature | **`vectorStoreFor(env, binding: VectorBinding)`** where `VectorBinding = { backend, index_name, embedding_dimensions }` | Routes / helpers extract `binding` from the row they already loaded. |

### Adapter implementation

| Concern | Choice | Rationale |
|---------|--------|-----------|
| HTTP client | **`globalThis.fetch`**, no SDK dep | Both Qdrant and Pinecone REST APIs are small + stable. Adds no bundle weight. |
| Qdrant point ID | **`uuidv5(chunk_id, NAMESPACE_DNS)`** with chunk_id stored in payload | Qdrant requires point IDs to be UUID-or-integer; v2 chunk_ids (`chk_ver_…_00000`) aren't valid. v1 used the same pattern. |
| Pinecone vector ID | **chunk_id directly** | Pinecone accepts arbitrary string IDs ≤512 bytes. The Vectorize 64-byte cap (`_chunk_id_guard`) keeps us well under. |
| Pinecone API key auth | **`Api-Key: <key>` header** | Pinecone serverless authentication standard. |
| Qdrant API key auth | **`api-key: <key>` header**, optional | Qdrant Cloud + locally-hosted Qdrant share this header convention; locally we typically run without auth. |
| Filter translation | **Each adapter owns its own filter shape**; the shared `DenseFilter` is the canonical input | Qdrant's `must`/`should`/`must_not` differs from Pinecone's `$eq`/`$in`/`$and`. Translation is per-adapter. |
| Distance metric | **Cosine for all three** | V2 already pins cosine on Vectorize; the cookbook narrative profile uses cosine. |

### Lifecycle

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Qdrant collection creation | **Adapter PUTs the collection at namespace-create time, idempotent** | First-write must not race with collection creation. PUT returns 200 if the collection already exists with matching params. |
| Pinecone index creation | **Operator-provisioned out-of-band; adapter just verifies on first use** | Pinecone's index creation is a multi-minute, account-level operation. Auto-creation would couple us to dashboard/API state we shouldn't own. |
| Dev compose lifecycle | **`make dev-stack` brings up Qdrant + ingest; `make dev-api-remote` runs Worker via `wrangler dev --remote`** | Worker hits `host.docker.internal:6333` for Qdrant. CF bindings (D1/R2/Queues/AI) stay remote. The existing `make dev-api` target (no `--remote`) stays put for fully-local miniflare workflows. |

### Dev stack

| Concern | Choice |
|---------|--------|
| Compose file location | `infrastructure/docker/docker-compose.dev.yml` |
| Qdrant image | `qdrant/qdrant:latest` |
| Qdrant ports | `6333` (HTTP REST) + `6334` (gRPC, reserved/unused) |
| Qdrant volume | `qdrantdata:/qdrant/storage` |
| Ingest container reuse | The existing `apps/ingest/Dockerfile` builds the same image |
| Networking | Single `default` bridge network; Worker reaches via `host.docker.internal` |

### Validation matrix

| Concern | Choice |
|---------|--------|
| Validator flag | `--backend vectorize|qdrant|pinecone` |
| Namespace shape | One cookbook namespace per backend (e.g. `cookbook-vectorize`, `cookbook-qdrant`, `cookbook-pinecone`); same fixture, same questions |
| CI | Local `vectorize` runs against deployed dev Vectorize index; `qdrant` runs against the dev-stack Qdrant; `pinecone` runs against the live Pinecone account, gated by a `RUN_PINECONE_TESTS=1` env |

---

## Naming and locations

```
apps/api/
├── src/
│   ├── retrieval/
│   │   ├── vector-store.ts                ← MODIFIED — interface + selector only
│   │   ├── adapters/
│   │   │   ├── vectorize.ts               ← MOVED — was inline in vector-store.ts
│   │   │   ├── qdrant.ts                  ← NEW
│   │   │   └── pinecone.ts                ← NEW
│   │   ├── vectorize-query.ts             ← MODIFIED — accepts VectorBinding
│   │   └── hybrid.ts                      ← MODIFIED — passes binding through
│   ├── db/
│   │   ├── namespaces.ts                  ← MODIFIED — vector_backend / index_name fields
│   │   └── version-indexes.ts             ← MODIFIED — same fields, denormalised
│   ├── routes/
│   │   ├── namespaces.ts                  ← MODIFIED — accept vector_backend on POST + ensureBackingExists
│   │   ├── internal/
│   │   │   └── ingest-write.ts            ← MODIFIED — pass VectorBinding into vectorStoreFor
│   │   └── query.ts                       ← MODIFIED — pass binding to retrieval
│   ├── ingestion/
│   │   └── dispatch.ts                    ← MODIFIED — propagate ns.vector_* into vidx insert
│   ├── types.ts                           ← MODIFIED — QDRANT_URL/PINECONE_API_KEY env types
│   └── openapi/
│       └── code-samples.ts                ← MODIFIED — Qdrant/Pinecone variants
├── migrations/
│   └── 0006_namespace_vector_backend.sql  ← NEW
├── scripts/
│   └── validate-cookbook.ts               ← MODIFIED — --backend flag + matrix
├── test/
│   ├── retrieval/
│   │   ├── qdrant-adapter.test.ts         ← NEW
│   │   └── pinecone-adapter.test.ts       ← NEW
│   └── namespace-vector-backend.test.ts   ← NEW
├── wrangler.toml                          ← MODIFIED — new env vars + secret bindings
infrastructure/docker/
└── docker-compose.dev.yml                 ← NEW
packages/contracts/src/
└── namespace.ts                           ← MODIFIED — vector_backend on Namespace + NamespaceCreate
docs/v3/
└── PHASE_1_QUICKSTART.md                  ← NEW (operator-facing)
Makefile                                   ← MODIFIED — new targets
```

Total new files: **8** (1 migration + 2 new adapters + 1 moved adapter file + 3 new test files + 1 compose file + 1 operator quickstart). Modified files: **~14** (selector, two retrieval shims, three routes, three db helpers, dispatch, types, validator script, two openapi files, contracts namespace, wrangler.toml, Makefile).

Sample-variant changes are line-edits inside the existing `code-samples.ts` file, not a new file.

---

## Step 1 — Refactor `vector-store.ts` to extract `VectorizeV2Adapter`

### 1.1 Create `apps/api/src/retrieval/adapters/vectorize.ts`

Move the existing `VectorizeV2Adapter` class verbatim:

```ts
// apps/api/src/retrieval/adapters/vectorize.ts
//
// Cloudflare Vectorize V2 adapter. The V2 API returns
// `{ mutationId }` (V1 returned `{ ids, count }` and is being
// deprecated). The binding is passed in from `vectorStoreFor` —
// this class doesn't read `env`.

import type { DenseFilter, DenseHit, VectorRecord, VectorStore } from '../vector-store.js';

export class VectorizeV2Adapter implements VectorStore {
  constructor(private readonly index: Vectorize) {}

  async upsert(records: VectorRecord[]): Promise<{ mutation_id: string | null }> {
    if (records.length === 0) return { mutation_id: null };
    const result = await this.index.upsert(records as unknown as VectorizeVector[]);
    return { mutation_id: result.mutationId ?? null };
  }

  async query(
    vector: number[],
    opts: { topK: number; filter: DenseFilter },
  ): Promise<DenseHit[]> {
    const result = await this.index.query(vector, {
      topK: opts.topK,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filter: opts.filter as any,
      returnMetadata: 'all',
    });
    return result.matches.map((m) => ({ chunk_id: m.id, score: m.score }));
  }

  async deleteByIds(ids: string[]): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    await this.index.deleteByIds(ids);
    return { count: ids.length };
  }
}
```

### 1.2 Slim `vector-store.ts` to interface + selector

Replace the file contents with:

```ts
// apps/api/src/retrieval/vector-store.ts
//
// Vendor-agnostic vector store abstraction. Three backends today:
// Vectorize (CF), Qdrant (self-host or Qdrant Cloud), Pinecone
// (managed). Each implements the `VectorStore` interface. The
// selector picks an adapter based on the `VectorBinding` the
// caller hands in (resolved from a namespace or version_index row).

import { TextralError } from '@textral/contracts';
import type { Env } from '../types.js';
import { VectorizeV2Adapter } from './adapters/vectorize.js';
import { QdrantAdapter } from './adapters/qdrant.js';
import { PineconeAdapter } from './adapters/pinecone.js';

export type VectorBackend = 'vectorize' | 'qdrant' | 'pinecone';

export interface VectorBinding {
  backend: VectorBackend;
  /** Backend-meaningful handle. Vectorize: ignored. Qdrant: collection name.
   *  Pinecone: full host URL (https://....pinecone.io). */
  index_name: string | null;
  /** Vector dimensionality. Used for collection creation in Qdrant
   *  and verification in Pinecone. */
  embedding_dimensions: number;
}

export interface VectorMetadata {
  tenant_id: string;
  namespace_id: string;
  document_id: string;
  version_id: string;
  version_index_id: string;
  artifact_type: string;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface DenseFilter {
  tenant_id: string;
  namespace_id: string;
  version_id?: { $in: string[] } | string;
  artifact_type?: { $in: string[] } | string;
}

export interface DenseHit {
  chunk_id: string;
  score: number;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<{ mutation_id: string | null }>;
  query(
    vector: number[],
    opts: { topK: number; filter: DenseFilter },
  ): Promise<DenseHit[]>;
  deleteByIds(ids: string[]): Promise<{ count: number }>;
  /** Idempotent backing-resource creation. Called once at namespace
   *  create time. Adapters that need no provisioning (Vectorize)
   *  return immediately. */
  ensureBackingExists?(): Promise<void>;
}

export function vectorStoreFor(env: Env, binding: VectorBinding): VectorStore {
  switch (binding.backend) {
    case 'vectorize':
      return new VectorizeV2Adapter(env.VECTORIZE_OPENAI_LARGE);
    case 'qdrant': {
      if (!env.QDRANT_URL) {
        throw new TextralError(
          'BAD_REQUEST',
          400,
          'Qdrant backend selected but QDRANT_URL is unset on this deploy',
        );
      }
      if (!binding.index_name) {
        throw new TextralError(
          'BAD_REQUEST',
          400,
          'Qdrant backend requires vector_index_name (collection name)',
        );
      }
      return new QdrantAdapter({
        url: env.QDRANT_URL,
        apiKey: env.QDRANT_API_KEY,
        collection: binding.index_name,
        dimensions: binding.embedding_dimensions,
      });
    }
    case 'pinecone': {
      if (!env.PINECONE_API_KEY) {
        throw new TextralError(
          'BAD_REQUEST',
          400,
          'Pinecone backend selected but PINECONE_API_KEY is unset on this deploy',
        );
      }
      if (!binding.index_name) {
        throw new TextralError(
          'BAD_REQUEST',
          400,
          'Pinecone backend requires vector_index_name (full index host URL)',
        );
      }
      return new PineconeAdapter({
        host: binding.index_name,
        apiKey: env.PINECONE_API_KEY,
        dimensions: binding.embedding_dimensions,
      });
    }
  }
}
```

### Acceptance — Step 1

- [ ] `apps/api/src/retrieval/adapters/vectorize.ts` exists with
      `VectorizeV2Adapter` exported.
- [ ] `apps/api/src/retrieval/vector-store.ts` no longer contains
      a class; only the interface + selector.
- [ ] `pnpm typecheck` clean. The new adapter modules
      (`qdrant.ts`, `pinecone.ts`) won't exist yet — accept the
      typecheck failure on lines 4 + 5 of vector-store.ts and
      proceed; Steps 5 + 6 supply the missing files.

---

## Step 2 — Migration `0006_namespace_vector_backend.sql`

### 2.1 Create `apps/api/migrations/0006_namespace_vector_backend.sql`

```sql
-- V3 Phase 1 — pluggable vector store backend selection.
--
-- Adds two columns to BOTH `namespaces` and `version_indexes`:
--   * vector_backend     'vectorize' | 'qdrant' | 'pinecone'
--   * vector_index_name  opaque per-backend handle (collection name
--                        for Qdrant; host URL for Pinecone; NULL
--                        for Vectorize).
--
-- Defaults preserve V2 behavior: every existing namespace continues
-- to use Vectorize. New namespaces that want Qdrant/Pinecone pass
-- the field explicitly on POST /v1/namespaces.
--
-- The columns are denormalized onto version_indexes (read by the
-- ingest hot path) to avoid a namespace lookup per upsert.

ALTER TABLE namespaces ADD COLUMN vector_backend TEXT NOT NULL DEFAULT 'vectorize';
ALTER TABLE namespaces ADD COLUMN vector_index_name TEXT;

ALTER TABLE version_indexes ADD COLUMN vector_backend TEXT NOT NULL DEFAULT 'vectorize';
ALTER TABLE version_indexes ADD COLUMN vector_index_name TEXT;
```

### 2.2 Apply locally + remote

`vitest-pool-workers` re-applies all migrations before each test
run (see `apps/api/test/setup.ts`); no extra wiring needed for
tests.

For the deployed dev: run `make migrate-dev` after the migration
file lands.

### Acceptance — Step 2

- [ ] Migration file present at the path above.
- [ ] After `make migrate-dev`, `wrangler d1 execute textral-dev
      --command "PRAGMA table_info(namespaces);"` shows
      `vector_backend` (TEXT, NOT NULL, default `'vectorize'`) +
      `vector_index_name` (TEXT, nullable).
- [ ] Same on `version_indexes`.
- [ ] Existing rows: every row has `vector_backend = 'vectorize'`
      and `vector_index_name = NULL`. (`SELECT DISTINCT
      vector_backend FROM namespaces;` returns one row.)

---

## Step 3 — Contract + DB helper updates

### 3.1 Extend `packages/contracts/src/namespace.ts`

```ts
// packages/contracts/src/namespace.ts
import { z } from 'zod';

export const NamespaceSlug = z.string().min(2).max(31)
  .regex(/^[a-z][a-z0-9-]+$/, 'slug must start with a-z and contain only a-z, 0-9, and -');

export const VectorBackend = z.enum(['vectorize', 'qdrant', 'pinecone']);
export type VectorBackend = z.infer<typeof VectorBackend>;

export const Namespace = z.object({
  id: z.string(),
  tenant_id: z.string(),
  slug: NamespaceSlug,
  corpus_profile: z.string(),
  default_embedding_profile: z.string(),
  default_inference_model: z.string().nullable(),
  default_prompt_template_id: z.string().nullable(),
  vector_backend: VectorBackend,
  vector_index_name: z.string().nullable(),
  created_at: z.number().int(),
});
export type Namespace = z.infer<typeof Namespace>;

export const NamespaceCreate = z.object({
  slug: NamespaceSlug,
  corpus_profile: z.string().default('generic'),
  default_embedding_profile: z.string().default('openai-text-embedding-3-large'),
  default_inference_model: z.string().nullable().optional(),
  default_prompt_template_id: z.string().nullable().optional(),
  vector_backend: VectorBackend.default('vectorize'),
  /** Required for `qdrant` / `pinecone`. Ignored for `vectorize`.
   *  Qdrant: collection name (will be auto-created idempotently).
   *  Pinecone: full host URL (e.g. https://my-idx.svc.us-east-1.pinecone.io). */
  vector_index_name: z.string().min(1).max(512).optional(),
});
export type NamespaceCreate = z.infer<typeof NamespaceCreate>;

// Backend choice is locked at create time. Strip vector_backend +
// vector_index_name from the update shape so PATCH /v1/namespaces
// can never mutate them — preserves the "switch backends → new
// namespace + re-ingest" contract.
export const NamespaceUpdate = NamespaceCreate.partial()
  .omit({ slug: true, vector_backend: true, vector_index_name: true });
export type NamespaceUpdate = z.infer<typeof NamespaceUpdate>;
```

### 3.2 Update `apps/api/src/db/namespaces.ts`

Extend `NamespaceRow`, `rowToNamespace`, and `InsertNamespaceArgs`
with the two new fields. The `insertNamespace` helper:

```ts
export interface InsertNamespaceArgs {
  id: string;
  tenant_id: string;
  slug: string;
  corpus_profile: string;
  default_embedding_profile: string;
  default_inference_model: string | null;
  default_prompt_template_id: string | null;
  vector_backend: 'vectorize' | 'qdrant' | 'pinecone';
  vector_index_name: string | null;
}

export async function insertNamespace(
  db: D1Database,
  args: InsertNamespaceArgs,
): Promise<Namespace> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO namespaces
         (id, tenant_id, slug, corpus_profile, default_embedding_profile,
          default_inference_model, default_prompt_template_id,
          vector_backend, vector_index_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.id,
      args.tenant_id,
      args.slug,
      args.corpus_profile,
      args.default_embedding_profile,
      args.default_inference_model,
      args.default_prompt_template_id,
      args.vector_backend,
      args.vector_index_name,
      now,
    )
    .run();
  return {
    id: args.id,
    tenant_id: args.tenant_id,
    slug: args.slug,
    corpus_profile: args.corpus_profile,
    default_embedding_profile: args.default_embedding_profile,
    default_inference_model: args.default_inference_model,
    default_prompt_template_id: args.default_prompt_template_id,
    vector_backend: args.vector_backend,
    vector_index_name: args.vector_index_name,
    created_at: now,
  };
}
```

`rowToNamespace` likewise maps the two new columns.

### 3.3 Update `apps/api/src/db/version-indexes.ts`

Same extension to `VersionIndexRow`, the row → object mapper, and
`InsertVersionIndexArgs`. Add to the SQL `INSERT` statement.

### Acceptance — Step 3

- [ ] `pnpm --filter @textral/contracts build` clean.
- [ ] Importing `Namespace` from `@textral/contracts` exposes
      `vector_backend` + `vector_index_name`.
- [ ] `insertNamespace({ ..., vector_backend: 'qdrant',
      vector_index_name: 'cookbook' })` writes both columns to D1.
- [ ] `getNamespaceBySlug` round-trips the new fields.

---

## Step 4 — Qdrant adapter

### 4.1 Create `apps/api/src/retrieval/adapters/qdrant.ts`

```ts
// apps/api/src/retrieval/adapters/qdrant.ts
//
// Qdrant adapter. Uses the REST API directly (no SDK dep). One
// collection per Textral namespace; collection name comes from
// the namespace's `vector_index_name`. Distance metric: cosine.
//
// Point ID translation: Qdrant requires UUID or unsigned int.
// Textral chunk_ids are like `chk_ver_<ulid>_<ord>` — not valid.
// We deterministically derive a UUIDv5 from the chunk_id and
// store the original chunk_id in the point's payload. v1's
// `apps/rag-core/app/clients/qdrant.py` used the same trick.

import { TextralError } from '@textral/contracts';
import type {
  DenseFilter,
  DenseHit,
  VectorMetadata,
  VectorRecord,
  VectorStore,
} from '../vector-store.js';

// RFC 4122 NAMESPACE_DNS (matches v1's `uuid.uuid5(uuid.NAMESPACE_DNS, chunk_id)`).
const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const DISTANCE = 'Cosine';

interface QdrantConfig {
  url: string;
  apiKey?: string;
  collection: string;
  dimensions: number;
}

interface QdrantPointPayload extends VectorMetadata {
  chunk_id: string;
}

export class QdrantAdapter implements VectorStore {
  constructor(private readonly cfg: QdrantConfig) {}

  // ── Collection lifecycle ───────────────────────────────────
  async ensureBackingExists(): Promise<void> {
    // Qdrant: PUT /collections/{name} is idempotent only when the
    // body matches; otherwise it returns 4xx. Use GET first, PUT
    // only on 404.
    const head = await this.fetch(`/collections/${this.cfg.collection}`, { method: 'GET' });
    if (head.status === 200) return;
    if (head.status !== 404) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Qdrant collection check failed (${head.status})`,
      );
    }
    const create = await this.fetch(`/collections/${this.cfg.collection}`, {
      method: 'PUT',
      body: JSON.stringify({
        vectors: { size: this.cfg.dimensions, distance: DISTANCE },
      }),
    });
    if (!create.ok) {
      const text = await create.text();
      throw new TextralError(
        'INTERNAL',
        500,
        `Qdrant create-collection failed: ${create.status} ${text.slice(0, 200)}`,
      );
    }
    // Add a payload index on tenant_id + version_id for fast filtering.
    for (const field of ['tenant_id', 'version_id', 'artifact_type']) {
      await this.fetch(`/collections/${this.cfg.collection}/index`, {
        method: 'PUT',
        body: JSON.stringify({ field_name: field, field_schema: 'keyword' }),
      });
    }
  }

  // ── Upsert ────────────────────────────────────────────────
  async upsert(records: VectorRecord[]): Promise<{ mutation_id: string | null }> {
    if (records.length === 0) return { mutation_id: null };
    const points = await Promise.all(
      records.map(async (r) => ({
        id: await uuidv5(NAMESPACE_DNS, r.id),
        vector: r.values,
        payload: { ...r.metadata, chunk_id: r.id } as QdrantPointPayload,
      })),
    );
    const res = await this.fetch(
      `/collections/${this.cfg.collection}/points?wait=true`,
      { method: 'PUT', body: JSON.stringify({ points }) },
    );
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Qdrant upsert failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    return { mutation_id: null }; // Qdrant doesn't return a mutation id; null is acceptable per VectorStore contract.
  }

  // ── Query ─────────────────────────────────────────────────
  async query(
    vector: number[],
    opts: { topK: number; filter: DenseFilter },
  ): Promise<DenseHit[]> {
    const must: Array<Record<string, unknown>> = [
      { key: 'tenant_id', match: { value: opts.filter.tenant_id } },
      { key: 'namespace_id', match: { value: opts.filter.namespace_id } },
    ];
    if (opts.filter.version_id) {
      const v = opts.filter.version_id;
      must.push(
        typeof v === 'string'
          ? { key: 'version_id', match: { value: v } }
          : { key: 'version_id', match: { any: v.$in } },
      );
    }
    if (opts.filter.artifact_type) {
      const a = opts.filter.artifact_type;
      must.push(
        typeof a === 'string'
          ? { key: 'artifact_type', match: { value: a } }
          : { key: 'artifact_type', match: { any: a.$in } },
      );
    }
    const res = await this.fetch(`/collections/${this.cfg.collection}/points/search`, {
      method: 'POST',
      body: JSON.stringify({
        vector,
        limit: opts.topK,
        filter: { must },
        with_payload: true,
      }),
    });
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Qdrant search failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as {
      result: Array<{ id: string | number; score: number; payload?: { chunk_id?: string } }>;
    };
    return body.result.map((m) => ({
      chunk_id: m.payload?.chunk_id ?? String(m.id),
      score: m.score,
    }));
  }

  // ── Delete ────────────────────────────────────────────────
  async deleteByIds(ids: string[]): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    const points = await Promise.all(ids.map((id) => uuidv5(NAMESPACE_DNS, id)));
    const res = await this.fetch(
      `/collections/${this.cfg.collection}/points/delete?wait=true`,
      { method: 'POST', body: JSON.stringify({ points }) },
    );
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Qdrant delete failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    return { count: ids.length };
  }

  // ── Internal ──────────────────────────────────────────────
  private fetch(path: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.cfg.apiKey ? { 'api-key': this.cfg.apiKey } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    };
    return fetch(`${this.cfg.url}${path}`, { ...init, headers });
  }
}

/** UUIDv5(name, namespace). Web Crypto + manual byte rewrite per
 *  RFC 4122. Pure-fetch — no node `crypto` import.
 *  Returns the canonical 8-4-4-4-12 hex form. */
async function uuidv5(namespaceOid: string, name: string): Promise<string> {
  const ns = uuidToBytes(namespaceOid);
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const buf = new Uint8Array(ns.length + nameBytes.length);
  buf.set(ns, 0);
  buf.set(nameBytes, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  // Set version (5) + variant (RFC 4122) bits.
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  return bytesToUuid(hash.subarray(0, 16));
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
```

### 4.2 Adapter unit test — `apps/api/test/retrieval/qdrant-adapter.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { QdrantAdapter } from '../../src/retrieval/adapters/qdrant.js';

afterEach(() => vi.restoreAllMocks());

const cfg = {
  url: 'http://qdrant:6333',
  collection: 'test-coll',
  dimensions: 1536,
};

function mockFetch(routes: Record<string, (init: RequestInit) => Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    for (const [path, handler] of Object.entries(routes)) {
      if (url.endsWith(path)) return handler(init);
    }
    return new Response('not stubbed: ' + url, { status: 500 });
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

describe('QdrantAdapter', () => {
  it('ensureBackingExists creates the collection on 404', async () => {
    mockFetch({
      '/collections/test-coll': (init) => {
        if (init.method === 'GET') return new Response('not found', { status: 404 });
        if (init.method === 'PUT') return new Response('{}', { status: 200 });
        return new Response('?', { status: 500 });
      },
      '/collections/test-coll/index': () => new Response('{}', { status: 200 }),
    });
    const a = new QdrantAdapter(cfg);
    await a.ensureBackingExists();
    // No throw → pass.
  });

  it('upsert sends chunk_id in payload + UUIDv5 as point id', async () => {
    let captured: unknown;
    mockFetch({
      '/collections/test-coll/points?wait=true': (init) => {
        captured = JSON.parse(String(init.body));
        return new Response('{}', { status: 200 });
      },
    });
    const a = new QdrantAdapter(cfg);
    await a.upsert([
      {
        id: 'chk_ver_test_00000',
        values: new Array(1536).fill(0),
        metadata: {
          tenant_id: 'ten_a', namespace_id: 'ns_b', document_id: 'doc_c',
          version_id: 'ver_d', version_index_id: 'vidx_e', artifact_type: 'passage',
        },
      },
    ]);
    const points = (captured as { points: Array<{ id: string; payload: { chunk_id: string } }> }).points;
    expect(points).toHaveLength(1);
    expect(points[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(points[0]!.payload.chunk_id).toBe('chk_ver_test_00000');
  });

  it('query translates filter shape correctly', async () => {
    let captured: unknown;
    mockFetch({
      '/collections/test-coll/points/search': (init) => {
        captured = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ result: [
          { id: 'x', score: 0.9, payload: { chunk_id: 'chk_a' } },
        ] }), { status: 200 });
      },
    });
    const a = new QdrantAdapter(cfg);
    const res = await a.query([0, 0, 0], {
      topK: 5,
      filter: { tenant_id: 't', namespace_id: 'n', version_id: { $in: ['v1', 'v2'] } },
    });
    expect(res).toEqual([{ chunk_id: 'chk_a', score: 0.9 }]);
    const body = captured as { filter: { must: Array<{ key: string; match: unknown }> } };
    expect(body.filter.must.find((m) => m.key === 'tenant_id')!.match).toEqual({ value: 't' });
    expect(body.filter.must.find((m) => m.key === 'version_id')!.match).toEqual({ any: ['v1', 'v2'] });
  });

  it('deleteByIds maps each chunk_id to UUIDv5', async () => {
    let captured: unknown;
    mockFetch({
      '/collections/test-coll/points/delete?wait=true': (init) => {
        captured = JSON.parse(String(init.body));
        return new Response('{}', { status: 200 });
      },
    });
    const a = new QdrantAdapter(cfg);
    const r = await a.deleteByIds(['chk_a', 'chk_b']);
    expect(r.count).toBe(2);
    const points = (captured as { points: string[] }).points;
    expect(points).toHaveLength(2);
    expect(points[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

### Acceptance — Step 4

- [ ] `apps/api/src/retrieval/adapters/qdrant.ts` exists and
      exports `QdrantAdapter`.
- [ ] `pnpm --filter @textral/api typecheck` clean (the
      `vector-store.ts` import resolves).
- [ ] `pnpm --filter @textral/api exec vitest run
      test/retrieval/qdrant-adapter.test.ts` — all 4 tests pass.

---

## Step 5 — Pinecone adapter

### 5.1 Create `apps/api/src/retrieval/adapters/pinecone.ts`

```ts
// apps/api/src/retrieval/adapters/pinecone.ts
//
// Pinecone serverless adapter. Uses the data-plane host URL
// (e.g. https://my-idx.svc.us-east-1.pinecone.io) directly. The
// caller supplies the host as `vector_index_name` on the
// namespace; the operator pre-creates the index out-of-band via
// Pinecone dashboard or REST.
//
// Vector IDs are chunk_ids verbatim — Pinecone accepts up to 512
// bytes per id; the existing _chunk_id_guard caps at 64.

import { TextralError } from '@textral/contracts';
import type {
  DenseFilter,
  DenseHit,
  VectorRecord,
  VectorStore,
} from '../vector-store.js';

interface PineconeConfig {
  host: string;          // full URL, e.g. "https://my-idx.svc.us-east-1.pinecone.io"
  apiKey: string;
  dimensions: number;
}

export class PineconeAdapter implements VectorStore {
  constructor(private readonly cfg: PineconeConfig) {}

  async ensureBackingExists(): Promise<void> {
    // Index creation is operator-side. Verify reachability with a
    // GET on /describe_index_stats; surface a clean 400 if not.
    const res = await this.fetch('/describe_index_stats', { method: 'POST', body: '{}' });
    if (res.status === 404) {
      throw new TextralError(
        'BAD_REQUEST',
        400,
        `Pinecone index at ${this.cfg.host} not found. Provision it via the Pinecone dashboard or API first.`,
      );
    }
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Pinecone reachability check failed (${res.status})`,
      );
    }
  }

  async upsert(records: VectorRecord[]): Promise<{ mutation_id: string | null }> {
    if (records.length === 0) return { mutation_id: null };
    const vectors = records.map((r) => ({
      id: r.id,
      values: r.values,
      metadata: r.metadata as unknown as Record<string, string>,
    }));
    const res = await this.fetch('/vectors/upsert', {
      method: 'POST',
      body: JSON.stringify({ vectors }),
    });
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Pinecone upsert failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    return { mutation_id: null };
  }

  async query(
    vector: number[],
    opts: { topK: number; filter: DenseFilter },
  ): Promise<DenseHit[]> {
    const filter: Record<string, unknown> = {
      tenant_id: { $eq: opts.filter.tenant_id },
      namespace_id: { $eq: opts.filter.namespace_id },
    };
    if (opts.filter.version_id) {
      filter.version_id =
        typeof opts.filter.version_id === 'string'
          ? { $eq: opts.filter.version_id }
          : { $in: opts.filter.version_id.$in };
    }
    if (opts.filter.artifact_type) {
      filter.artifact_type =
        typeof opts.filter.artifact_type === 'string'
          ? { $eq: opts.filter.artifact_type }
          : { $in: opts.filter.artifact_type.$in };
    }
    const res = await this.fetch('/query', {
      method: 'POST',
      body: JSON.stringify({
        vector,
        topK: opts.topK,
        filter,
        includeMetadata: false,
        includeValues: false,
      }),
    });
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Pinecone query failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as { matches: Array<{ id: string; score: number }> };
    return body.matches.map((m) => ({ chunk_id: m.id, score: m.score }));
  }

  async deleteByIds(ids: string[]): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    const res = await this.fetch('/vectors/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Pinecone delete failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    return { count: ids.length };
  }

  private fetch(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.cfg.host}${path}`, {
      ...init,
      headers: {
        'Api-Key': this.cfg.apiKey,
        // Pin a recent stable API version. Update if Pinecone
        // releases a newer one and the data-plane shape changes.
        'X-Pinecone-API-Version': '2025-04',
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  }
}
```

### 5.2 Adapter unit test — `apps/api/test/retrieval/pinecone-adapter.test.ts`

Same shape as Qdrant: mock `fetch`, pin upsert/query/delete request
shapes, verify `ensureBackingExists` 404 → BAD_REQUEST mapping.

### Acceptance — Step 5

- [ ] Adapter exists.
- [ ] `vector-store.ts` import resolves; `pnpm typecheck` clean.
- [ ] Pinecone adapter test green.
- [ ] `ensureBackingExists` returns clean error path on 404.

---

## Step 6 — Wire the namespace creation flow

### 6.1 Update `apps/api/src/routes/namespaces.ts`

```ts
namespacesRoute.openapi(createRouteDef, async (c) => {
  const tenantId = c.get('tenant_id')!;
  const data = c.req.valid('json');
  validateCorpusProfileOrThrow(data.corpus_profile);

  // Reject inconsistent configs early.
  if ((data.vector_backend === 'qdrant' || data.vector_backend === 'pinecone')
       && !data.vector_index_name) {
    throw new TextralError(
      'BAD_REQUEST',
      400,
      `${data.vector_backend} backend requires vector_index_name`,
    );
  }
  if (data.vector_backend === 'vectorize' && data.vector_index_name) {
    throw new TextralError(
      'BAD_REQUEST',
      400,
      'vectorize backend does not accept vector_index_name (binding is global)',
    );
  }

  const existing = await getNamespaceBySlug(c.env.DB, tenantId, data.slug);
  if (existing) {
    throw new TextralError('NAMESPACE_ALREADY_EXISTS', 409, `Namespace already exists: ${data.slug}`);
  }

  const ns = await insertNamespace(c.env.DB, {
    id: newId('ns'),
    tenant_id: tenantId,
    slug: data.slug,
    corpus_profile: data.corpus_profile,
    default_embedding_profile: data.default_embedding_profile,
    default_inference_model: data.default_inference_model ?? null,
    default_prompt_template_id: data.default_prompt_template_id ?? null,
    vector_backend: data.vector_backend,
    vector_index_name: data.vector_index_name ?? null,
  });

  // Provision backing store if the backend needs it. Done after
  // the D1 row is committed so a botched provisioning leaves the
  // namespace in a "broken-but-explicit" state — operator can
  // delete + retry rather than getting a half-state.
  const dimensions = inferDimensionsFromProfile(data.default_embedding_profile);
  const store = vectorStoreFor(c.env, {
    backend: ns.vector_backend,
    index_name: ns.vector_index_name,
    embedding_dimensions: dimensions,
  });
  if (store.ensureBackingExists) {
    await store.ensureBackingExists();
  }

  return c.json(ns, 201);
});
```

`inferDimensionsFromProfile` is a small helper next to it:

```ts
function inferDimensionsFromProfile(profile: string): number {
  // V2 trivia: the contract default for `default_embedding_profile`
  // is the bare `'openai-text-embedding-3-large'`, but
  // `vectorStoreFor` (today) only resolves the `-1536` suffix form.
  // Both are accepted here so a namespace created with the contract
  // default still resolves a sensible dimension. (Cleaning up the
  // contract-vs-selector mismatch is a separate task; out of scope
  // for V3 Phase 1.)
  if (profile === 'openai-text-embedding-3-large-1536'
      || profile === 'openai-text-embedding-3-large') return 1536;
  if (profile === 'workers-bge-large-en-v1-5-1024') return 1024;
  // Fallback: 1536 (OpenAI default). Adapter will fail clearly if
  // there's a mismatch.
  return 1536;
}
```

### 6.2 Acceptance — Step 6

- [ ] Existing tests still pass (`namespaces-route.test.ts` etc).
- [ ] `POST /v1/namespaces` with `vector_backend: 'qdrant',
      vector_index_name: 'foo'` against `make dev-stack`-running
      Qdrant creates a `foo` collection with size=1536 + cosine
      distance.
- [ ] `POST /v1/namespaces` with `vector_backend: 'qdrant'` and
      no `vector_index_name` → 400 BAD_REQUEST.
- [ ] `POST /v1/namespaces` with `vector_backend: 'vectorize',
      vector_index_name: 'something'` → 400 BAD_REQUEST.

---

## Step 7 — Propagate binding through ingestion + retrieval

### 7.1 Update `apps/api/src/ingestion/dispatch.ts`

When inserting a `version_indexes` row, copy the namespace's
backend + index name onto it:

```ts
await insertVersionIndex(env.DB, {
  // ... existing fields ...
  vector_backend: ns.vector_backend,
  vector_index_name: ns.vector_index_name,
});
```

### 7.2 Update `apps/api/src/retrieval/vectorize-query.ts`

```ts
import type { Env } from '../types.js';
import type { DenseFilter, DenseHit, VectorBinding } from './vector-store.js';
import { vectorStoreFor } from './vector-store.js';

export type { DenseHit };

export interface DenseQueryArgs {
  vector: number[];
  topK: number;
  filter: DenseFilter;
  binding: VectorBinding;
}

export async function denseQuery(env: Env, args: DenseQueryArgs): Promise<DenseHit[]> {
  const store = vectorStoreFor(env, args.binding);
  return store.query(args.vector, { topK: args.topK, filter: args.filter });
}
```

### 7.3 Update `apps/api/src/retrieval/hybrid.ts`

Extend `HybridArgs` with `binding: VectorBinding`. Pass through to
`denseQuery`. The route caller (query.ts) already has the namespace
loaded — it builds the binding inline:

```ts
// In query.ts handler:
const retrieval = await runHybridRetrieval(c.env, {
  query_vector: queryVec,
  query_text: body.query,
  tenant_id: tenantId,
  namespace_id: ns.id,
  version_ids: versionIds,
  artifact_types: profile.retrieval_defaults.artifact_types,
  top_k_dense: body.retrieval.top_k_dense,
  top_k_sparse: body.retrieval.top_k_sparse,
  rrf_k: body.retrieval.rrf_k,
  binding: {
    backend: ns.vector_backend,
    index_name: ns.vector_index_name,
    embedding_dimensions: body.embedding.dimensions ?? 1536,
  },
});
```

The same edit lands in `query-stream.ts`.

### 7.4 Update `apps/api/src/routes/internal/ingest-write.ts`

Two `vectorStoreFor` call sites (`/internal/vectorize/upsert` line
~430; `/internal/vectorize/delete-by-filter` line ~462). Both have
a `vidx` row already loaded; build the binding from it:

```ts
const store = vectorStoreFor(c.env, {
  backend: vidx.vector_backend as VectorBackend,
  index_name: vidx.vector_index_name,
  embedding_dimensions: vidx.embedding_dimensions,
});
```

### Acceptance — Step 7

- [ ] `pnpm typecheck` clean.
- [ ] All existing query + ingestion tests still pass.
- [ ] No remaining `vectorStoreFor(env, profile)` (string-arg)
      call sites — `grep -rn 'vectorStoreFor' apps/api/src/` shows
      only object-arg invocations.

---

## Step 8 — Env vars + `wrangler.toml`

### 8.1 Update `apps/api/src/types.ts`

```ts
export interface Env {
  // ... existing ...
  /** Qdrant URL — empty/unset disables the qdrant backend. */
  QDRANT_URL?: string;
  QDRANT_API_KEY?: string;
  /** Pinecone API key — required when any namespace uses backend='pinecone'. */
  PINECONE_API_KEY?: string;
}
```

### 8.2 Update `apps/api/wrangler.toml`

Per-env `[vars]` blocks add:

```toml
[env.dev.vars]
# ... existing ...
QDRANT_URL = ""              # set to "http://host.docker.internal:6333" for dev-stack
```

API keys go through `wrangler secret put`:

```bash
wrangler secret put QDRANT_API_KEY --env dev   # leave blank for local Qdrant
wrangler secret put PINECONE_API_KEY --env dev
```

### Acceptance — Step 8

- [ ] `wrangler.toml` declares `QDRANT_URL` for each env.
- [ ] `make deploy-dev` succeeds; no warnings about unknown vars.
- [ ] `wrangler secret list --env dev` shows
      `PINECONE_API_KEY` (and optionally `QDRANT_API_KEY`).

---

## Step 9 — `infrastructure/docker/docker-compose.dev.yml`

### 9.1 Create the file

The `infrastructure/docker/` directory does not yet exist at the
repo root — create it first:

```bash
mkdir -p infrastructure/docker
```

Then write the compose file:

```yaml
# infrastructure/docker/docker-compose.dev.yml
#
# V3 Phase 1 dev stack. Brings up Qdrant + the ingest Container
# locally so contributors can iterate without round-tripping every
# code change through deployed dev. The api Worker stays on
# `wrangler dev --remote --env dev` (run separately).
#
# Networking: the Worker reaches Qdrant via
# `http://host.docker.internal:6333` (Wrangler dev exposes the
# host network to the Worker isolate on macOS / Windows / WSL;
# on Linux you may need `--add-host=host.docker.internal:host-gateway`
# on the qdrant service or set QDRANT_URL=http://localhost:6333).

services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"      # HTTP REST
      - "6334:6334"      # gRPC (reserved; unused in Phase 1)
    volumes:
      - qdrantdata:/qdrant/storage
    healthcheck:
      test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/6333'"]
      interval: 5s
      timeout: 3s
      retries: 5

  ingest:
    build:
      context: ../..
      dockerfile: apps/ingest/Dockerfile
    ports:
      - "8000:8000"
    env_file:
      - ../../apps/api/.secrets.dev.env   # INTERNAL_HMAC_SECRET
    environment:
      WORKER_INTERNAL_URL: ${WORKER_INTERNAL_URL:-http://host.docker.internal:8787}
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:8000/health')\""]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  qdrantdata:

networks:
  default:
    driver: bridge
```

### 9.2 Update `Makefile`

There is already a `dev-api` target that runs `wrangler dev --env dev`
(no `--remote` — uses miniflare's in-process bindings). V3 Phase 1
needs a new variant that runs the Worker locally but with **real CF
bindings** (D1 / R2 / Queues / AI). Add a new target alongside the
existing one — do **not** replace `dev-api`:

```makefile
dev-stack: ## Bring up the V3 Phase 1 dev stack (qdrant + ingest)
	docker compose -f infrastructure/docker/docker-compose.dev.yml up -d --wait
	@echo
	@echo "  Qdrant:  http://localhost:6333"
	@echo "  Ingest:  http://localhost:8000"
	@echo
	@echo "  Now run 'make dev-api-remote' in another terminal to start the Worker."

dev-stack-down: ## Stop and remove the V3 Phase 1 dev stack
	docker compose -f infrastructure/docker/docker-compose.dev.yml down

dev-api-remote: ## Run the api Worker locally with --remote bindings (CF dev account)
	cd apps/api && npx wrangler dev --remote --env dev
```

### Acceptance — Step 9

- [ ] `make dev-stack` brings both services up healthy in ≤30
      seconds.
- [ ] `curl http://localhost:6333/collections` returns 200.
- [ ] `curl http://localhost:8000/health` returns 200.
- [ ] `make dev-stack-down` cleans up.

---

## Step 10 — Cookbook validator with `--backend` flag

### 10.1 Update `apps/api/scripts/validate-cookbook.ts`

The script today reads `LIVE_NAMESPACE` from env at module top-level
(line 22) and falls back to `'cookbook'`. Swap the fallback to be
backend-derived so a single run targets the matching test
namespace:

**Replace:**

```ts
const NAMESPACE = process.env.LIVE_NAMESPACE ?? 'cookbook';
```

**With:**

```ts
const BACKEND = (() => {
  const i = process.argv.indexOf('--backend');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return 'vectorize';
})() as 'vectorize' | 'qdrant' | 'pinecone';
const NAMESPACE = process.env.LIVE_NAMESPACE ?? `cookbook-${BACKEND}`;

console.log(`Cookbook backend=${BACKEND} namespace=${NAMESPACE}`);
```

Existing pattern bodies reference `NAMESPACE`; they're unchanged.

### 10.2 Acceptance — Step 10

- [ ] `validate-cookbook.ts --backend qdrant
      LIVE_WORKER_URL=... LIVE_API_KEY=... LIVE_NAMESPACE=cookbook-qdrant`
      runs all 8 patterns and prints `8/8 patterns OK`.
- [ ] Same for `--backend pinecone`.
- [ ] No-flag invocation defaults to `vectorize` (back-compat).

---

## Step 11 — Live validation matrix

Build the live testbed against deployed dev by:

1. Bootstrap a fresh tenant + API key via the existing
   `/v1/admin/bootstrap` flow (the cookbook tenant from prior work
   can also be reused).
2. Register the OpenAI BYOK from `DO_NOT_COMMIT.md` under label
   `default`.
3. **Pinecone setup** (one-time, operator-side):
   - Provision a serverless Pinecone index named `cookbook-v3` via
     dashboard, dimensions=1536, cosine, `aws/us-east-1` region.
     The host URL appears in the dashboard
     (e.g. `cookbook-v3-xxx.svc.aped-4627-b74a.pinecone.io`).
   - Set the API key as a Worker secret:
     `wrangler secret put PINECONE_API_KEY --env dev` with the
     value from `DO_NOT_COMMIT.md`.
4. **Qdrant setup** (already running locally via `make dev-stack`):
   - Set `QDRANT_URL=http://host.docker.internal:6333` in
     `wrangler.toml` for the dev env (or via `wrangler secret`).
5. Create three cookbook namespaces:
   - `cookbook-vectorize` — backend=vectorize.
   - `cookbook-qdrant` — backend=qdrant, vector_index_name=`cookbook-qdrant-passages`.
   - `cookbook-pinecone` — backend=pinecone, vector_index_name=`https://cookbook-v3-xxx.svc.aped-4627-b74a.pinecone.io`.
6. Ingest `apps/api/test/fixtures/narrative-tiny.md` into each.
7. Wait 25 s for vector propagation.
8. Run validator three times:
   ```bash
   LIVE_WORKER_URL=$WORKER LIVE_API_KEY=$KEY LIVE_NAMESPACE=cookbook-vectorize \
     pnpm exec tsx scripts/validate-cookbook.ts --backend vectorize
   LIVE_WORKER_URL=$WORKER LIVE_API_KEY=$KEY LIVE_NAMESPACE=cookbook-qdrant \
     pnpm exec tsx scripts/validate-cookbook.ts --backend qdrant
   LIVE_WORKER_URL=$WORKER LIVE_API_KEY=$KEY LIVE_NAMESPACE=cookbook-pinecone \
     pnpm exec tsx scripts/validate-cookbook.ts --backend pinecone
   ```

### Acceptance — Step 11

- [ ] All three validator runs print `8/8 patterns OK`.
- [ ] The structured-output pattern (#3) returns identical
      `answer.object.scholars` shape on all three backends.
- [ ] `audit.candidates_returned` is in the same range
      (1–10 candidates) across backends. Exact equality not
      required (each backend's score function differs).
- [ ] `degradation_level` values match across backends for the
      same query.

---

## Step 12 — Update Scalar docs

V3 Phase 1 introduces a new dimension to the API surface
(per-namespace vector backend). Six places in the rendered Scalar
docs reference vector storage today, all of which need adjustment
so a reader on `/docs` learns about the backend choice in the
right places + no longer thinks "Vectorize" is hard-coded:

1. **Landing page** (`landing-description.ts`) — mental model +
   "Choosing a strategy" tables + common recipes.
2. **Namespaces tag description** — primary home of the new
   "Vector backend selection" section.
3. **Provider Keys tag description** — disambiguates "vector
   store" from "provider key" so readers don't look in the wrong
   place.
4. **Ingestion tag description** — stage 5 ("index") currently
   says "Vectorize V2"; replace with "the namespace's vector
   backend (Vectorize / Qdrant / Pinecone)."
5. **Query tag description** — pipeline step 2 ("Retrieve") says
   "dense (Vectorize)"; replace with backend-agnostic phrasing.
6. **Code samples** on `POST /v1/namespaces` — add Qdrant +
   Pinecone curl variants alongside the existing Vectorize
   default.

Plus a new operator-facing quickstart at
`docs/v3/PHASE_1_QUICKSTART.md`.

### 12.1 Update Namespaces tag description in `apps/api/src/openapi/tag-descriptions.ts`

Append:

```markdown
## Vector backend selection (V3 Phase 1)

Each namespace pins one of three vector backends at create time:

| Backend | When to pick | \`vector_index_name\` |
|---------|--------------|-----------------------|
| \`vectorize\` (default) | Cloudflare-hosted Textral; the simplest path | not set (binding is global) |
| \`qdrant\` | Self-hosted or Qdrant Cloud; OSS option | collection name (auto-created idempotently) |
| \`pinecone\` | Managed Pinecone serverless | full host URL (operator pre-provisions the index) |

Backend choice is locked at create time. Switching backends after
data is indexed requires a new namespace + re-ingest under
\`mode='full'\`. Use the same approach to migrate between embedding
profiles.

Operator config required:
- Qdrant: \`QDRANT_URL\` env var; optional \`QDRANT_API_KEY\` secret.
- Pinecone: \`PINECONE_API_KEY\` Worker secret. Operator
  pre-provisions the serverless index in the Pinecone console;
  Textral references it by host URL.
```

### 12.2 Update Provider Keys tag description in `apps/api/src/openapi/tag-descriptions.ts`

Append a short "Not what you're looking for?" callout so readers
don't conflate "vector store" with "provider key":

```markdown
> **Vector store ≠ provider key.** Vector backends (Vectorize,
> Qdrant, Pinecone) are configured per-namespace at create time —
> see the **Namespaces** tag. They are **not** provider keys; you
> never register a Qdrant or Pinecone API key here. Operator-side
> config (\`QDRANT_URL\`, \`PINECONE_API_KEY\`) lives in the
> deploy environment.
```

### 12.3 Update Ingestion tag description in `apps/api/src/openapi/tag-descriptions.ts`

Stage 5 currently reads:

> 5. **index** — upserts vectors to Vectorize V2 + writes chunks
>    to D1.

Replace with:

> 5. **index** — upserts vectors to the namespace's configured
>    vector backend (Vectorize, Qdrant, or Pinecone) + writes
>    chunks to D1.

### 12.4 Update Query tag description in `apps/api/src/openapi/tag-descriptions.ts`

Pipeline step 2 currently reads:

> 2. **Retrieve** dense (Vectorize) + sparse (D1 FTS5), fuse via
>    Reciprocal Rank Fusion (\`retrieval.strategy='hybrid_rrf'\`).

Replace with:

> 2. **Retrieve** dense (the namespace's vector backend) + sparse
>    (D1 FTS5), fuse via Reciprocal Rank Fusion
>    (\`retrieval.strategy='hybrid_rrf'\`). Backend choice is
>    transparent to the caller — Vectorize, Qdrant, and Pinecone
>    all return the same `audit.candidates_returned` /
>    `audit.retrieval_status` shape.

### 12.5 Update landing page in `apps/api/src/openapi/landing-description.ts`

Three edits, all small.

**a) "Mental model" section** — add a single sentence near the
provider-keys paragraph noting that vector storage is also
configurable per-namespace:

> Each namespace also picks a **vector backend** — Vectorize
> (default, Cloudflare-hosted), Qdrant (self-host or Qdrant
> Cloud), or Pinecone (managed serverless). Choice is locked at
> create time and transparent to the query path.

**b) "Choosing a strategy → Ingestion" table** — add a row:

```markdown
| Pluggable vector store (self-host or non-CF) | \`vector_backend='qdrant'\` or \`'pinecone'\` |
```

**c) "Common recipes" section** — add an entry:

```markdown
- **Self-host with Qdrant** —
  \`POST /v1/namespaces\` with \`vector_backend='qdrant'\`.
  See `docs/v3/PHASE_1_QUICKSTART.md`.
```

### 12.6 Add code samples for Qdrant + Pinecone variants in `apps/api/src/openapi/code-samples.ts`

Extend the `REG_NAMESPACE` entry's samples to add a Qdrant + Pinecone
variant per language (or label-distinguish them). Example:

```ts
{
  lang: 'shell',
  label: 'curl (Qdrant backend)',
  source: `curl -X POST "${URL_}/v1/namespaces" \\
  -H "X-Textral-Api-Key: ${KEY}" \\
  -H 'content-type: application/json' \\
  -d '{
    "slug": "my-docs",
    "corpus_profile": "narrative",
    "default_embedding_profile": "openai-text-embedding-3-large-1536",
    "vector_backend": "qdrant",
    "vector_index_name": "my-docs-passages"
  }'`,
},
{
  lang: 'shell',
  label: 'curl (Pinecone backend)',
  source: `curl -X POST "${URL_}/v1/namespaces" \\
  -H "X-Textral-Api-Key: ${KEY}" \\
  -H 'content-type: application/json' \\
  -d '{
    "slug": "my-docs",
    "corpus_profile": "narrative",
    "default_embedding_profile": "openai-text-embedding-3-large-1536",
    "vector_backend": "pinecone",
    "vector_index_name": "https://my-idx-xxx.svc.us-east-1.pinecone.io"
  }'`,
},
```

### 12.7 New operator-facing quickstart — `docs/v3/PHASE_1_QUICKSTART.md`

A short runbook covering:

1. `make dev-stack` to bring up Qdrant + ingest.
2. `make dev-api` in another terminal.
3. Bootstrap (or reuse) a tenant.
4. Create a namespace with `vector_backend: 'qdrant'`.
5. Run a query through the Cookbook.
6. Tear down with `make dev-stack-down`.

### Acceptance — Step 12

- [ ] Hitting `/docs` on deployed dev shows the new tag-description
      section on **Namespaces** with the "Vector backend
      selection" table.
- [ ] **Provider Keys** tag carries the "Vector store ≠ provider
      key" callout.
- [ ] **Ingestion** tag's stage-5 prose no longer says "Vectorize
      V2"; instead reads "the namespace's configured vector
      backend."
- [ ] **Query** tag's pipeline step 2 prose is backend-agnostic.
- [ ] Landing page (`/docs` top section) carries:
      - the new "vector backend" sentence in the mental model,
      - a row in the "Choosing a strategy → Ingestion" table,
      - a "Self-host with Qdrant" entry under "Common recipes."
- [ ] `POST /v1/namespaces` in `/docs` shows the Qdrant and
      Pinecone curl variants in addition to the default.
- [ ] `docs/v3/PHASE_1_QUICKSTART.md` exists and walks an outside
      operator end-to-end in ≤10 minutes.
- [ ] No regression: the docs-regression test
      (`apps/api/test/docs-regression.test.ts`) stays green —
      flagship operations still have `x-codeSamples`, every
      grouped tag still has a description, the error-catalog
      table still renders.

---

## Step 13 — Phase 1 close-out

### 13.1 Cross-cutting verification

```bash
pnpm -r typecheck
pnpm -r lint
pnpm --filter @textral/api test     # the full vitest suite
bash tools/check-no-inline-d1.sh   # CI guard
```

All green.

### 13.2 Live e2e regression

```bash
make test-live          # the existing Phase 4 happy-path
make test-live-phase5   # narrative + reranker fallback
LIVE_NAMESPACE=cookbook-qdrant pnpm --filter @textral/api exec tsx \
  scripts/validate-cookbook.ts --backend qdrant
LIVE_NAMESPACE=cookbook-pinecone pnpm --filter @textral/api exec tsx \
  scripts/validate-cookbook.ts --backend pinecone
```

All green.

### 13.3 Deploy + verify

```bash
make deploy-dev
make migrate-dev
```

Spot check on the deployed dev:

```bash
curl -ks "$WORKER/openapi.json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ns_tag = next(t for t in d['tags'] if t['name']=='Namespaces')
print('Namespaces tag has Vector-backend section:',
  'Vector backend selection' in ns_tag.get('description',''))
print('paths still good:', '/v1/namespaces' in d['paths'])
"
```

### 13.4 Phase 1 ships when

- All 13 numbered steps' acceptance bullets pass.
- The cookbook validator matrix is green on `vectorize`,
  `qdrant`, and `pinecone` against deployed dev.
- A new docs-regression test asserts every adapter's `index_name`
  contract (Vectorize null, Qdrant non-null, Pinecone non-null
  starting with `https://`).
- `wrangler deploy --env dev` succeeds + the existing test-live
  scripts still pass against the new deploy.

---

## Files added / modified — summary

**New (10):**

1. `apps/api/migrations/0006_namespace_vector_backend.sql`
2. `apps/api/src/retrieval/adapters/vectorize.ts` (moved class body)
3. `apps/api/src/retrieval/adapters/qdrant.ts`
4. `apps/api/src/retrieval/adapters/pinecone.ts`
5. `apps/api/test/retrieval/qdrant-adapter.test.ts`
6. `apps/api/test/retrieval/pinecone-adapter.test.ts`
7. `apps/api/test/namespace-vector-backend.test.ts`
8. `infrastructure/docker/docker-compose.dev.yml`
9. `docs/v3/PHASE_1_QUICKSTART.md`
10. `docs/development/v3/PHASE_1_IMPLEMENTATION.md` (this file)

**Modified (~14):**

1. `apps/api/src/retrieval/vector-store.ts`
2. `apps/api/src/retrieval/vectorize-query.ts`
3. `apps/api/src/retrieval/hybrid.ts`
4. `apps/api/src/routes/namespaces.ts`
5. `apps/api/src/routes/query.ts`
6. `apps/api/src/routes/query-stream.ts`
7. `apps/api/src/routes/internal/ingest-write.ts`
8. `apps/api/src/db/namespaces.ts`
9. `apps/api/src/db/version-indexes.ts`
10. `apps/api/src/ingestion/dispatch.ts`
11. `apps/api/src/types.ts`
12. `apps/api/scripts/validate-cookbook.ts`
13. `apps/api/src/openapi/tag-descriptions.ts`
14. `apps/api/src/openapi/code-samples.ts`
15. `apps/api/wrangler.toml`
16. `packages/contracts/src/namespace.ts`
17. `Makefile`

---

End of V3 Phase 1 implementation guide. The next document is
`docs/development/v3/PHASE_2_IMPLEMENTATION.md` — drafted only
after Phase 1 has merged and the cookbook matrix has been green
on all three backends for ≥1 day on deployed dev.
