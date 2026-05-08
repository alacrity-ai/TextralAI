# Bulk Uploads — Implementation Plan

> **Status.** Build plan, sequenced. Companion to
> [`BULK_UPLOADS_DESIGN.md`](./BULK_UPLOADS_DESIGN.md). Reads top-to-bottom.
> Open questions in the design doc are now closed (see §11 below for
> what was locked).
>
> **Owners.** API + DB + SDK: TBD. Sandbox UX: TBD. MCP: TBD.
>
> **Last drafted:** 2026-05-08.

---

## 1. What this doc commits to

The design doc says *what* and *why*. This doc says *what files,
in what order, with what tests*. It is the buildable form.

Three phases. Each phase is independently shippable:

| Phase | Deliverable | Acceptance criteria from design (§11) |
|---|---|---|
| **1** | API + DB + SDK + Sandbox bulk path | 1, 2, 4, 5, 6, 7 |
| **2** | MCP `ingest_local_paths` + streaming | 3 |
| **3** | Webhooks + cost rollup polish | none — depends on WEBHOOKS.md / COST_ATTRIBUTION.md |

Phase 1 alone hits 6 of 7 acceptance criteria. Phase 2 hits the
seventh (MCP). Phase 3 depends on roadmap items that haven't started.

## 2. Conventions

Where prior precedent exists in the codebase, follow it. Cited
references for each section:

- Migrations: dual-write `migrations/postgres/00NN_*.sql` and
  `migrations/sqlite/00NN_*.sql` (next number is **0014**).
- Routes: one file per resource under `apps/api/src/routes/`. Mount
  in `apps/api/src/app.ts`.
- Contracts: Zod schemas in `packages/contracts/src/`. New file:
  `bulk-ingest.ts`.
- SDK: extend `packages/sdk/src/client.ts` with a new `bulkIngest`
  block, mirroring how `infraKeys` / `providerKeys` are organized.
- MCP tools: one file per tool group in `packages/mcp/src/tools/`.
  New file: `bulk-ingest.ts`. Register in `tools/index.ts`. Tool
  descriptions ≤ 200 chars (eager throw at module load — caught us
  on 0.1.3).
- Sandbox: add bulk handling to `apps/sandbox/src/pages/Ingest.tsx`.
  New components under `apps/sandbox/src/components/bulk/`.

---

## 3. Phase 1 — API + DB + SDK + Sandbox

### 3.1 Migrations (`migrations/{postgres,sqlite}/0014_bulk_jobs.sql`)

Both flavors. Schemas mirror §4.1 of the design doc; nuances per
backend below.

**Postgres flavor:**

```sql
-- 0014_bulk_jobs.sql
CREATE TABLE bulk_jobs (
  bulk_job_id           TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  namespace_id          TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN (
                          'accepted','uploading','finalizing','processing',
                          'complete','partial','failed','cancelled','expired'
                        )),
  config_json           JSONB NOT NULL,
  on_existing           TEXT NOT NULL CHECK (on_existing IN (
                          'skip_if_unchanged','new_version','replace_current'
                        )),
  client_request_id     TEXT,
  total_files           INTEGER NOT NULL,
  files_uploaded        INTEGER NOT NULL DEFAULT 0,
  files_succeeded       INTEGER NOT NULL DEFAULT 0,
  files_failed          INTEGER NOT NULL DEFAULT 0,
  files_skipped         INTEGER NOT NULL DEFAULT 0,
  source                TEXT NOT NULL CHECK (source IN ('api','mcp','sandbox')),
  auto_finalize         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            BIGINT NOT NULL,
  finalized_at          BIGINT,
  completed_at          BIGINT,
  expires_at            BIGINT NOT NULL
);

CREATE INDEX idx_bulk_jobs_tenant     ON bulk_jobs(tenant_id, created_at DESC);
CREATE INDEX idx_bulk_jobs_namespace  ON bulk_jobs(namespace_id, created_at DESC);
CREATE INDEX idx_bulk_jobs_expires    ON bulk_jobs(expires_at)
  WHERE state IN ('accepted','uploading');
CREATE UNIQUE INDEX uq_bulk_jobs_client_dedupe
  ON bulk_jobs(tenant_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE TABLE bulk_job_files (
  bulk_job_id           TEXT NOT NULL REFERENCES bulk_jobs(bulk_job_id) ON DELETE CASCADE,
  ordinal               INTEGER NOT NULL,
  filename              TEXT NOT NULL,
  size_bytes            BIGINT NOT NULL,
  content_type          TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN (
                          'pending','uploaded','finalized',
                          'enqueued','processing','succeeded',
                          'failed','skipped'
                        )),
  upload_id             TEXT,
  upload_url_expires_at BIGINT,
  document_id           TEXT,
  version_id            TEXT,
  ingestion_job_id      TEXT,
  error_code            TEXT,
  error_detail          TEXT,
  client_request_id     TEXT,
  PRIMARY KEY (bulk_job_id, ordinal)
);

CREATE INDEX idx_bulk_job_files_state   ON bulk_job_files(bulk_job_id, state);
CREATE INDEX idx_bulk_job_files_doc     ON bulk_job_files(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX idx_bulk_job_files_job     ON bulk_job_files(ingestion_job_id) WHERE ingestion_job_id IS NOT NULL;

-- FK on existing ingestion_jobs so the queue worker can write back without
-- needing a join table.
ALTER TABLE ingestion_jobs
  ADD COLUMN bulk_job_id TEXT REFERENCES bulk_jobs(bulk_job_id) ON DELETE SET NULL;
CREATE INDEX idx_ingestion_jobs_bulk ON ingestion_jobs(bulk_job_id) WHERE bulk_job_id IS NOT NULL;
```

**SQLite flavor:** identical structure, but `JSONB` → `TEXT`,
`BIGINT` → `INTEGER`, drop `WHERE` clauses on partial unique indexes
that SQLite versions before 3.8 didn't support (current Cloudflare D1
runs 3.43+, so partial indexes work — keep the unique dedupe and
expiry indexes as partial).

`config_json` stores the shared `IngestRequest` minus `version_id`.
Worker reads it back for each file's enqueue.

### 3.2 Contracts (`packages/contracts/src/bulk-ingest.ts`)

New file. Reuses `EmbeddingConfig`, `ChunkingConfig`,
`EnrichmentConfig`, `IndexingConfig` from `ingest.ts`.

```ts
import { z } from 'zod';
import {
  EmbeddingConfig,
  ChunkingConfig,
  EnrichmentConfig,
  IndexingConfig,
} from './ingest.js';

export const BulkOnExisting = z.enum([
  'skip_if_unchanged',
  'new_version',
  'replace_current',
]);
export type BulkOnExisting = z.infer<typeof BulkOnExisting>;

export const BulkSource = z.enum(['api', 'mcp', 'sandbox']);
export type BulkSource = z.infer<typeof BulkSource>;

export const BulkConfig = z.object({
  embedding: EmbeddingConfig,
  chunking: ChunkingConfig.default({}),
  enrichment: EnrichmentConfig.default({}),
  indexing: IndexingConfig.default({}),
  mode: z.enum(['full', 'embed_only', 'enrichment_only']).default('full'),
  doc_type: z.string().optional(),
});
export type BulkConfig = z.infer<typeof BulkConfig>;

export const BulkFileEntry = z.object({
  ordinal: z.number().int().nonnegative(),
  filename: z.string().min(1).max(512),
  size_bytes: z.number().int().positive().max(25 * 1024 * 1024),
  content_type: z.string().min(1),
  client_request_id: z.string().optional(),
});
export type BulkFileEntry = z.infer<typeof BulkFileEntry>;

export const BulkSubmitRequest = z.object({
  namespace: z.string().min(1),
  config: BulkConfig,
  files: z.array(BulkFileEntry).min(1).max(1000),
  on_existing: BulkOnExisting.default('skip_if_unchanged'),
  auto_finalize: z.boolean().default(true),
  client_request_id: z.string().optional(),
});
export type BulkSubmitRequest = z.infer<typeof BulkSubmitRequest>;

export const BulkUploadSlot = z.object({
  ordinal: z.number().int(),
  upload_url: z.string().url(),
  upload_id: z.string(),
  expires_at: z.number().int(),
  method: z.literal('PUT'),
  headers: z.record(z.string()),
});
export type BulkUploadSlot = z.infer<typeof BulkUploadSlot>;

export const BulkSubmitResponse = z.object({
  bulk_job_id: z.string(),
  state: z.string(),
  total_files: z.number().int(),
  uploads: z.array(BulkUploadSlot),
  expires_at: z.number().int(),
});
export type BulkSubmitResponse = z.infer<typeof BulkSubmitResponse>;

// Aggregate status (GET /v1/ingest/bulk/{id})
export const BulkJobCounts = z.object({
  pending: z.number().int(),
  uploaded: z.number().int(),
  finalized: z.number().int(),
  enqueued: z.number().int(),
  processing: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});
export type BulkJobCounts = z.infer<typeof BulkJobCounts>;

export const BulkJobStatus = z.object({
  bulk_job_id: z.string(),
  state: z.string(),
  namespace: z.string(),
  total_files: z.number().int(),
  counts: BulkJobCounts,
  progress_pct: z.number().int().min(0).max(100),
  first_failure: z
    .object({
      ordinal: z.number().int(),
      filename: z.string(),
      error_code: z.string(),
      error_detail: z.string().optional(),
    })
    .nullable(),
  source: BulkSource,
  created_at: z.number().int(),
  finalized_at: z.number().int().nullable(),
  completed_at: z.number().int().nullable(),
  audit_query_event_filter: z.string(),
});
export type BulkJobStatus = z.infer<typeof BulkJobStatus>;

export const BulkJobFile = z.object({
  ordinal: z.number().int(),
  filename: z.string(),
  size_bytes: z.number().int(),
  content_type: z.string(),
  state: z.string(),
  document_id: z.string().nullable(),
  version_id: z.string().nullable(),
  ingestion_job_id: z.string().nullable(),
  error_code: z.string().nullable(),
  error_detail: z.string().nullable(),
});
export type BulkJobFile = z.infer<typeof BulkJobFile>;
```

Re-export from `packages/contracts/src/index.ts`.

### 3.3 Routes (`apps/api/src/routes/bulk-ingest.ts`)

New route module. Mount under `/v1/ingest/bulk` from `app.ts`. Seven
handlers:

| Method | Path | Handler |
|---|---|---|
| POST | `/v1/ingest/bulk` | `submitBulkJob` |
| POST | `/v1/ingest/bulk/:id/finalize` | `finalizeBulkJob` |
| GET | `/v1/ingest/bulk/:id` | `getBulkJobStatus` |
| GET | `/v1/ingest/bulk/:id/files` | `listBulkJobFiles` |
| DELETE | `/v1/ingest/bulk/:id` | `cancelBulkJob` |
| POST | `/v1/ingest/bulk/:id/retry` | `retryFailedFiles` |
| GET | `/v1/ingest/bulk` | `listBulkJobs` |

#### `submitBulkJob` happy path (the only complex one)

```
1.  Authenticate: tenant_id from API key.
2.  Validate body via BulkSubmitRequest.
3.  Resolve namespace by name → namespace_id; assert tenant ownership.
4.  Resolve provider_key_ref → provider_key_id (existing helper).
5.  Resolve embedding profile → effective dimensions.
6.  Dim-lock check:
      if namespace.dim_lock IS NOT NULL and namespace.dim_lock != effective_dim:
        return BULK_DIMENSION_LOCK_MISMATCH (no R2, no DB writes).
7.  Quota check:
      tenant active bulk jobs >= 10 → BULK_QUOTA_EXCEEDED.
8.  Idempotency check:
      if client_request_id provided AND a bulk_jobs row exists for
      (tenant_id, client_request_id) within 24h:
        return that job's BulkSubmitResponse, regenerating presigned
        URLs only for entries still in 'pending' state.
9.  Validate filenames are unique within the request.
10. Validate sum(size_bytes) <= 5 GB.
11. INSERT bulk_jobs (state='accepted', config_json=BulkConfig).
12. INSERT bulk_job_files (one per entry, state='pending').
13. For each file, generate a presigned R2 PUT URL (reuse
    apps/api/src/lib/r2-presign.ts). Update upload_id +
    upload_url_expires_at.
14. Return BulkSubmitResponse with the upload slots.
```

R2 keys live under `tmp/bulk/{bulk_job_id}/{ordinal}` until finalize
moves them to canonical document storage. The existing single-file
ingest already uses `tmp/` for unfinalized uploads — same convention.

#### `finalizeBulkJob`

Two paths to enter `finalizing` state:

1. Caller calls `POST .../finalize` explicitly (when `auto_finalize: false`).
2. Server transitions automatically when last file's R2 PUT lands
   (R2 event notification or polled HEAD). For Phase 1, we use a
   short-poll on the `state` column: when `files_uploaded ==
   total_files` and `auto_finalize == true`, the next read
   transitions and triggers the per-file finalize loop. Cleaner
   than wiring R2 events for Phase 1; revisit if latency hurts.

The finalize loop, **per file**:

```
finalize_file(bulk_job_id, ordinal):
  read row from bulk_job_files
  state must be 'uploaded'

  # Reuse existing finalize logic from /v1/documents/{id}/uploads/{u}/finalize
  # but driven server-side instead of via REST call. Extract into a helper:
  # apps/api/src/ingestion/finalize.ts → finalizeUpload(env, upload_id, ...)

  result = finalizeUpload(env, upload_id):
    HEAD R2 object → assert size matches
    compute SHA-256 streaming
    move tmp/bulk/.../{ordinal} → blobs/{content_hash}
    UPSERT documents (filename, namespace, content_hash) — dedupe key
    if dedupe hit AND on_existing == 'skip_if_unchanged':
      mark bulk_job_files.state = 'skipped', return
    else:
      INSERT new version_id
      bulk_job_files.state = 'finalized'

  enqueue ingestion job:
    INSERT ingestion_jobs (..., bulk_job_id=$1)
    publish to queue
    bulk_job_files.state = 'enqueued'
```

Per-file failures here become `state='failed'` with appropriate
`error_code`. The bulk job's aggregate state continues progressing.

After looping all files, transition `bulk_jobs.state` from
`finalizing` → `processing`. The queue worker takes over from here.

#### Other handlers (sketch only)

- `getBulkJobStatus`: SELECT row + counts, derive `progress_pct` and
  `first_failure`, return `BulkJobStatus`.
- `listBulkJobFiles`: paginated SELECT from `bulk_job_files`.
- `cancelBulkJob`: refuse if any file is `succeeded`. Otherwise
  UPDATE remaining files to `failed` with `error_code = 'BULK_JOB_CANCELLED'`,
  set bulk_jobs.state = `cancelled`, completed_at = now.
- `retryFailedFiles`: only operates on `state='failed'` rows. Re-issue
  presigned URL if upload itself failed; otherwise re-enqueue
  ingestion job. Reset row state accordingly.
- `listBulkJobs`: filters by namespace, state, source, date range.
  Default 25 rows, max 100.

### 3.4 Queue worker write-back (`apps/api/src/ingestion/dispatch.ts`)

The queue worker (or whatever owns terminal-state writes for an
`ingestion_job`) gets one new check at terminal-state time:

```ts
// Pseudo — actual code lives wherever ingestion_jobs flips to
// 'succeeded' / 'failed' today.

async function onIngestionJobTerminal(jobId: string, terminal: 'succeeded' | 'failed', err?: ErrorRow) {
  const job = await db.selectOne('SELECT bulk_job_id, ... FROM ingestion_jobs WHERE id = ?', jobId);

  // ... existing terminal-state work for single-file ...

  if (job.bulk_job_id) {
    await updateBulkJobFile(db, {
      bulk_job_id: job.bulk_job_id,
      ingestion_job_id: jobId,
      new_state: terminal,
      error_code: err?.code,
      error_detail: err?.detail,
    });
    await rollupBulkJobAggregates(db, job.bulk_job_id);
  }
}
```

`rollupBulkJobAggregates` recounts `bulk_job_files` by state in one
query, updates `bulk_jobs.{files_uploaded,files_succeeded,files_failed,files_skipped}`,
and transitions `state` if all files have terminal status. Idempotent.

### 3.5 SDK helper (`packages/sdk/src/client.ts`)

Mirror the `infraKeys` pattern. Add a new `bulkIngest` block:

```ts
// Low-level — direct API mapping
bulkIngest = {
  submit: (body: BulkSubmitRequest): Promise<BulkSubmitResponse> =>
    this._call('POST', '/v1/ingest/bulk', body),
  finalize: (id: string): Promise<{ ok: true }> =>
    this._call('POST', `/v1/ingest/bulk/${encodeURIComponent(id)}/finalize`),
  get: (id: string): Promise<BulkJobStatus> =>
    this._call('GET', `/v1/ingest/bulk/${encodeURIComponent(id)}`),
  files: (id: string, page = 1, pageSize = 100): Promise<{ data: BulkJobFile[]; cursor: string | null }> =>
    this._call('GET', `/v1/ingest/bulk/${encodeURIComponent(id)}/files?page=${page}&page_size=${pageSize}`),
  cancel: (id: string): Promise<{ ok: true }> =>
    this._call('DELETE', `/v1/ingest/bulk/${encodeURIComponent(id)}`),
  retry: (id: string): Promise<{ ok: true }> =>
    this._call('POST', `/v1/ingest/bulk/${encodeURIComponent(id)}/retry`),
  list: (params?: { namespace?: string; state?: string }): Promise<{ data: BulkJobStatus[] }> =>
    this._call('GET', `/v1/ingest/bulk?${new URLSearchParams(params ?? {})}`),
};
```

Plus a higher-level orchestration helper that does the full
choreography for browser/Node clients. New file
`packages/sdk/src/bulk-orchestrator.ts`:

```ts
interface BulkOrchestrateInput {
  namespace: string;
  config: BulkConfig;
  files: Array<{ filename: string; bytes: Blob | Uint8Array | ReadableStream; content_type: string }>;
  on_existing?: BulkOnExisting;
  auto_finalize?: boolean;
  concurrency?: number;
  client_request_id?: string;
  onProgress?: (snapshot: BulkJobStatus) => void;
  pollIntervalMs?: number;     // default 1500
  signal?: AbortSignal;
}

export async function bulkIngestOrchestrate(
  client: Client,
  input: BulkOrchestrateInput,
): Promise<BulkJobStatus> {
  // 1. Submit manifest with size/content-type from input.files.
  // 2. PUT each file's bytes to its presigned slot, in parallel
  //    bounded by concurrency (default 6 for browser, 8 for Node).
  // 3. If auto_finalize: false → call .finalize() once last PUT lands.
  // 4. Poll .get(id) every pollIntervalMs; emit onProgress.
  // 5. Resolve when state is terminal. Reject on signal.aborted.
}
```

This is what the Sandbox and the MCP tool both call internally.

### 3.6 Sandbox (`apps/sandbox/src/pages/Ingest.tsx` + new components)

#### File-count branch

The existing file picker / drop zone gets two changes:

1. `<input type="file" multiple webkitdirectory>` — note that
   `webkitdirectory` is intentionally added; folder drop is in
   the design.
2. After file selection, branch on `files.length`:
   - `== 1`: existing flow.
   - `>= 2`: render `<BulkIngestPanel files={files} />`.

#### New components (`apps/sandbox/src/components/bulk/`)

```
bulk/
├── BulkIngestPanel.tsx        Wrapper. Owns shared-config form + file table.
├── BulkConfigForm.tsx         The single shared-config form.
├── BulkFileTable.tsx          Sortable per-file rows with editable filename column.
├── BulkProgress.tsx           Live progress bar + counts + first-failure banner.
├── BulkFileRow.tsx            One row, with status icon, click-to-drawer.
└── BulkFailureDrawer.tsx      Slide-over with error_code + retry-this-file action.
```

Page-level wiring in `Ingest.tsx`:

```
on bulk submit:
  call bulkIngestOrchestrate(client, {
    namespace,
    config: <from form>,
    files,
    on_existing: 'skip_if_unchanged',
    auto_finalize: false,         // Sandbox uses confirm step (locked answer §11)
    concurrency: 6,
    onProgress: setStatus,
    signal: abortController.signal,
  })

on first response (after submit, before finalize):
  show "Confirm ingest" with summary (files, total bytes, embedding model, est. cost if available)
  → user clicks Confirm → call client.bulkIngest.finalize(bulkJobId)

bulk_job_id goes into the URL hash (#bulk=bjk_…). On mount, if the
hash is set, call client.bulkIngest.get(id) and resume rendering
without re-submitting.
```

#### Drag-drop folder support

When a folder is dropped, walk the entry tree via `DataTransferItem.webkitGetAsEntry`,
flatten to files, cap at 1000 with a banner — see design §5.3. If
the folder contains > 1000 files, queue the first 1000 and surface
a hint about the >1000 limitation (forward-link to roadmap section
once it lands per Q3 of design open questions).

#### Progress UI states

Use the existing palette:

| Per-file state | Color | Icon |
|---|---|---|
| pending | `text-tertiary` | hourglass |
| uploaded | `accent-amber` | up-arrow |
| finalized | `accent-amber` | check-faded |
| enqueued | `accent-amber` | clock |
| processing | `accent-amber` (pulsing) | spinner |
| succeeded | `accent-success` | ✓ |
| skipped | `text-tertiary` | dash |
| failed | `accent-coral` | ✗ |

Polling cadence: 1500ms while not terminal, stop at terminal. Use
`AbortController` on unmount.

### 3.7 OpenAPI / Scalar docs (`apps/api/src/openapi/` + `routes/docs.ts`)

The API serves a Scalar-rendered docs UI at `/docs` plus an
OpenAPI 3.1 spec at `/openapi.json`, both wired in
`apps/api/src/routes/docs.ts`. Routes authored with
`@hono/zod-openapi` (`createRoute({ ... })` style) auto-register
into the spec — but the *quality* of the rendered Scalar docs
depends on five explicit surfaces. Touching all five is
non-optional for the bulk-ingest feature.

#### 3.7.1 Per-route OpenAPI metadata

Every handler in `bulk-ingest.ts` is authored with
`createRoute({ ... })`, not raw `app.post(...)`. Each route MUST set:

- `tags: ['Bulk Ingest']` — exact string, matches the new tag group
  below.
- `summary` — one short imperative sentence (≤ 60 chars). Renders
  as the Scalar sidebar entry.
- `description` — Markdown-OK paragraph (≤ 2 sentences). What it
  does, what gates it (idempotency, dim-lock).
- `request.body.content['application/json'].schema` — the Zod
  contract from `packages/contracts/src/bulk-ingest.ts` with
  `.openapi({ example: { ... } })` chained on for a usable example.
- `responses` — full success + error catalog. 4xx responses with
  the canonical `Responses.errorJson(...)` helper from
  `apps/api/src/openapi/registry.ts`.

#### 3.7.2 New tag group

`apps/api/src/routes/docs.ts` defines `TAG_GROUPS`. Insert
`Bulk Ingest` after `Documents` so the sidebar reads:

```
Get started
Documents
  └─ ingest, finalize, list, get
Bulk Ingest                      ← new
  └─ submit, finalize, get, files, retry, cancel, list
Namespaces
…
```

#### 3.7.3 Tag description

`apps/api/src/openapi/tag-descriptions.ts` — add an entry for the
new tag with a Markdown blurb. Should explain in 4–6 sentences:
the manifest → presigned-URLs → finalize → poll lifecycle, the
dim-lock-fail-fast guarantee, the homogeneous-config v1 constraint,
and a forward-link to `BULK_UPLOADS_DESIGN.md` for the full spec.
This text renders as the Scalar landing block when a user clicks
the "Bulk Ingest" tag in the sidebar.

#### 3.7.4 Code samples

`apps/api/src/openapi/code-samples.ts` adds per-route x-codeSamples.
For bulk-ingest:

- **`POST /v1/ingest/bulk`** — bash (curl), TypeScript (SDK
  `client.bulkIngest.submit(...)`), Python (when Python SDK lands —
  for v1, omit Python or stub a comment).
- **`POST /v1/ingest/bulk/{id}/finalize`** — curl + TS one-liner.
- **`GET /v1/ingest/bulk/{id}`** — curl with example response
  (truncated `BulkJobStatus`).

Higher-leverage TS sample for the page anchor: the orchestrator
helper, `bulkIngestOrchestrate(client, { ... })`, since that's what
real consumers will use 90% of the time.

#### 3.7.5 Error catalog

`apps/api/src/openapi/error-catalog.ts` (and whichever data file it
reads) gets the new bulk-specific error codes:

```
BULK_TOO_MANY_FILES                  413
BULK_BYTES_EXCEEDED                  413
BULK_DUPLICATE_FILENAMES_IN_JOB      400
BULK_DIMENSION_LOCK_MISMATCH         409
BULK_NAMESPACE_NOT_FOUND             404
BULK_PROVIDER_KEY_NOT_FOUND          400
BULK_QUOTA_EXCEEDED                  429
BULK_DUPLICATE_REQUEST_ID_DIFFERENT_MANIFEST  409
BULK_FILE_HASH_MISMATCH              400
BULK_FILE_UPLOAD_EXPIRED             410
BULK_FILE_FORMAT_UNSUPPORTED         415
BULK_FILE_PROVIDER_THROTTLED         429
BULK_JOB_CANCELLED                   (per-file terminal cause, not HTTP)
```

Each gets a short Markdown row with: when raised, what to do.
`renderErrorCatalogMarkdown` then surfaces them in `/docs` *and*
the MCP `textral://error-catalog` resource picks them up
automatically (same source).

#### 3.7.6 OpenAPI coverage test

`apps/api/test/openapi-coverage.test.ts` enforces invariants on the
generated spec — verify what it currently asserts and confirm the
new bulk routes pass. If it asserts every route has a `summary`,
`tags`, `description`, and at least one `responses` entry, the new
routes need all of those (which §3.7.1 already requires). If
coverage assertions evolve while building this feature, update
them.

#### 3.7.7 Verification

After Phase 1 lands, manually check:

1. `https://api.textral.alacrity.ai/openapi.json` — spec includes
   all seven new operations under the `Bulk Ingest` tag.
2. `https://api.textral.alacrity.ai/docs` — Scalar sidebar renders
   the new group, each route has its description + example + code
   samples.
3. Each `BULK_*` error code renders in the error-catalog section.
4. The "Try it" panel in Scalar can hit `POST /v1/ingest/bulk`
   against dev with a small manifest.

Skipping this surface is the difference between "the API works" and
"the API looks like a real product." Treat it as part of Phase 1's
definition-of-done.

### 3.8 Phase 1 test plan

Unit tests:

- `apps/api/test/bulk-ingest.test.ts` — submit happy path, dedupe
  by `client_request_id`, dim-lock conflict, quota cap, file count
  cap, byte total cap, filename-uniqueness, presigned URL generation.
- `apps/api/test/bulk-finalize.test.ts` — auto-finalize trigger,
  per-file finalize delegating to existing helper, queue enqueue
  with `bulk_job_id` set.
- `apps/api/test/bulk-rollup.test.ts` — terminal-state aggregate
  rollup writes correct counts and transitions bulk job state.
- `apps/api/test/bulk-cancel.test.ts` — refuses with succeeded
  files; otherwise marks remaining failed.
- `apps/api/test/bulk-retry.test.ts` — only operates on failed rows.
- `packages/sdk/test/bulk-orchestrator.test.ts` — uploads in
  parallel within concurrency cap; polls; resolves on terminal.

Integration / E2E:

- Submit a 5-file bulk via SDK against the dev API. Assert:
  - All 5 succeed.
  - Total ingestion time < 30s (smoke).
  - All 5 documents queryable from the namespace.
  - One audit lookup with `bulk_job_id` filter returns 5 docs.
- Resubmit the same 5 files with `client_request_id`: same job id,
  no extra ingestion.
- Mutate one file's bytes, re-submit with `on_existing:
  skip_if_unchanged`: 4 skipped, 1 new version.
- Submit 1001 files: rejected at submit.
- Submit against a 1024-d namespace with a 1536-d config: rejected
  at submit, no R2 writes.

### 3.9 Phase 1 rollout

1. Land migrations on dev DB. Manually verify schema.
2. Deploy API with new routes behind `BULK_INGEST_ENABLED=true` env
   flag (default off for the first day). Smoke-test via SDK.
3. Flip flag on for dev. Full E2E run.
4. Land Sandbox UX in dev. Use it in the daily loop for a week.
5. Flip flag on in prod. Land Sandbox UX in prod.

Total Phase 1 budget: **~5 working days**. Database is the longest pole.

---

## 4. Phase 2 — MCP `ingest_local_paths`

### 4.1 New tool (`packages/mcp/src/tools/bulk-ingest.ts`)

Three tools. Each `defineTool` description **≤ 200 chars** (the
0.1.3 regression in MCP_RELEASE.md proved we have to enforce this
eagerly). Reserve detail for workflow prompts.

```ts
export const ingestLocalPaths = defineTool({
  name: 'ingest_local_paths',
  description:
    'Bulk-ingest local files. Pass paths or globs. The MCP server reads bytes from disk; never base64 in tool args. Stdio-only. Use dry_run first.',
  // …input schema follows LARGE_INGEST_ISSUE.md §3.2 (discriminated union by `mode`).
});

export const getBulkIngestJob = defineTool({
  name: 'get_bulk_ingest_job',
  description:
    'Poll a bulk ingest job. Returns aggregate counts and first failure. Pass only_failures=true to get just failed file rows.',
});

export const cancelBulkIngestJob = defineTool({
  name: 'cancel_bulk_ingest_job',
  description:
    'Cancel an in-flight bulk ingest. Refuses if any file already succeeded. Cancellation is terminal.',
});
```

Register all three in `packages/mcp/src/tools/index.ts`. Update
the test count in `packages/mcp/test/server.test.ts` (currently
expects 21 → 24) and the alphabetical ship-list.

### 4.2 Local-FS reader

New file `packages/mcp/src/fs/path-resolver.ts`:

```ts
// Pipeline (LARGE_INGEST_ISSUE.md §3.8):
//   1. require absolute path
//   2. realpath (resolve symlinks)
//   3. assert under allowlisted root
//   4. stat (exists, regular file)
//   5. extension policy
//   6. size policy
//   7. open ReadableStream

export interface ResolvedFile {
  abs_path: string;
  realpath: string;
  size_bytes: number;
  content_type: string;
  rel_path: string;     // for `title_from: "relative_path"`
}

export async function resolveFiles(
  request: IngestLocalPathsRequest,
  config: McpFsConfig,
): Promise<{ files: ResolvedFile[]; skipped: SkippedFile[] }> { … }
```

Allowlist + extension policy comes from env / config:

```
TEXTRAL_MCP_FS_INGEST            = stdio_only        # default
TEXTRAL_MCP_FS_INGEST_ROOTS      = colon-separated absolute paths
TEXTRAL_MCP_FS_INGEST_EXTENSIONS = .md,.mdx,.txt,.json,.yaml,.yml,.pdf
TEXTRAL_MCP_FS_INGEST_MAX_FILE_BYTES  = 10485760     # 10 MiB per file
TEXTRAL_MCP_FS_INGEST_MAX_BATCH_BYTES = 524288000    # 500 MiB per batch
```

Defaults are sane for a developer's laptop. `stdio_only` means: if
the MCP server is running over HTTP transport (future feature),
this tool is **silently absent from the tool list**. Discoverable
only when stdio.

### 4.3 Streaming progress (locked decision — Q8)

Two-tier UX:

1. **Default `wait=true`**: stream MCP progress notifications keyed
   on `bulk_job_id`. The agent sees:
   ```
   progress: 47 queued, uploading...
   progress: 12/47 uploaded, 0 succeeded
   progress: 47/47 uploaded, 18 succeeded, 1 failed
   complete: 46 succeeded, 1 failed (scholars.pdf: encrypted)
   ```
   The MCP SDK supports notifications on long-running tools.
2. **`wait=false`**: returns immediately with `bulk_job_id`. Agent
   polls `get_bulk_ingest_job` on demand.

Default is `wait=true` because MCP is a first-class citizen and
agents handle streaming responses natively.

Implementation: orchestrator uses a `Notifier` interface. SDK
orchestrator emits `onProgress(snapshot)`; the MCP wrapper translates
each snapshot to a notification. No new SDK API surface.

### 4.4 The `dry_run` shape (LARGE_INGEST_ISSUE.md §3.6, locked)

`dry_run: true` returns **without contacting the API**:

```jsonc
{
  "matched_count":     66,
  "total_size_bytes":  718336,
  "skipped": [
    { "path": "/abs/.../bin.jpg", "reason": "EXTENSION_NOT_ALLOWED" }
  ],
  "files": [
    { "path": "/abs/.../1-DESIGN.md", "size_bytes": 55220, "content_type": "text/markdown" }
  ]
}
```

Agent UX is: dry-run → confirm with the user → real run. The tool
description encourages this pattern.

### 4.5 Workflow prompts

Add a workflow prompt in `packages/mcp/src/prompts/`:
`bulk_ingest_directory.ts`. Invoked when an agent says "ingest a
folder" — gives it the canonical 3-step recipe (create namespace if
needed → dry_run → confirmed run). Drives compliance with the
intended UX.

### 4.6 Phase 2 test plan

Unit:

- `packages/mcp/test/path-resolver.test.ts` — symlink escape, abs
  required, extension policy, size policy, allowlist enforcement.
- `packages/mcp/test/bulk-ingest-tool.test.ts` — dry_run produces
  expected shape; non-dry calls SDK orchestrator; concurrency cap
  honored; description-length compliance.
- `packages/mcp/test/server.test.ts` updated tool count (21→24)
  and ship-list.

Integration (run against dev API + a temp directory of seed files):

- `ingest_local_paths` over 20 markdown files in temp dir → bulk
  job runs end-to-end, agent receives streaming progress, terminal
  result is summary.
- Re-run with one file edited → `skip_if_unchanged` skips 19, new
  version for 1.
- Bad path (escapes allowlist via `..`) → `PATH_NOT_ALLOWED` before
  any API call.
- 50,000-file glob → `BULK_TOO_MANY_FILES` after dry_run shows the
  count (we explicitly want the agent to see the count and bail).

### 4.7 Phase 2 rollout

1. Bump `@textral/{contracts,sdk,mcp}` in lockstep to **0.2.0**
   (minor — new tools, no breaking changes). Run the full
   `MCP_RELEASE.md` gate including `pnpm test`.
2. The Sandbox doesn't change for Phase 2.
3. Update the public landing-page roadmap card noting bulk ingest
   shipped.

Total Phase 2 budget: **~3 working days**.

---

## 5. Phase 3 — Polish (depends on roadmap items not yet shipped)

Don't start until the prerequisites land.

| Item | Prereq | Note |
|---|---|---|
| Webhook events for bulk job state | `WEBHOOKS.md` lands | Emit `bulk_job.completed` / `failed` / `partial` only. Per-file events would spam (locked answer §11). |
| Cost rollup per bulk job | `COST_ATTRIBUTION.md` lands | New column `total_cost_usd_micros` on `bulk_jobs`, populated at terminal. |
| MCP HTTP transport — bulk tool absence | HTTP transport ships | Tool registry already filters by `stdio_only`; just verify when transport lands. |

Each of these is < 1 day of work once its prerequisite is real.

---

## 6. Cross-cutting concerns

### 6.1 Idempotency keys

`client_request_id` discipline:

- Bulk job-level: required to be tenant-unique within 24h. Server
  rejects re-use with a different file set inside 24h
  (`BULK_DUPLICATE_REQUEST_ID_DIFFERENT_MANIFEST`).
- Per-file: tenant-globally unique recommended; server enforces
  uniqueness within a single bulk job. SDK orchestrator generates
  ULIDs by default if caller doesn't supply one.

### 6.2 R2 cleanup

Two cleanup paths:

1. **TTL on un-finalized jobs.** A nightly Worker cron job
   (`scheduled` handler) selects bulk jobs in `accepted` / `uploading`
   state with `expires_at < now()`, deletes their `tmp/bulk/{job_id}/`
   prefix from R2, marks the row `expired`. New cron entry:
   `apps/api/src/scheduled/bulk-job-expire.ts`.
2. **Cancel.** `cancelBulkJob` deletes the same prefix immediately.

Both paths log a row to the existing audit/ops log.

### 6.3 Audit integration

No new audit table. The existing `query_events` /
`ingestion_jobs` rows pick up `bulk_job_id` via the new FK. The
new audit query is the join:

```sql
SELECT d.*, v.*, ij.*
FROM bulk_job_files bjf
JOIN documents d ON d.id = bjf.document_id
JOIN versions v ON v.id = bjf.version_id
JOIN ingestion_jobs ij ON ij.id = bjf.ingestion_job_id
WHERE bjf.bulk_job_id = $1;
```

Surface this through `GET /v1/ingest/bulk/{id}/audit` as a Phase 1.5
nice-to-have. Not needed for Phase 1 acceptance.

### 6.4 Observability

Add OTLP spans (or whatever ingestion currently uses) at:

- `bulk.submit` — duration of the submit request, files count,
  total bytes.
- `bulk.finalize.per_file` — finalize timing per file.
- `bulk.rollup` — aggregate state recompute timing.

These help spot the slow paths (presigned URL generation? finalize
loop? rollup query?) without instrumenting code reactively after the
first slow customer.

---

## 7. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Auto-finalize polling adds latency between last upload and queue enqueue | low | Phase 1: 1500ms poll on the `state` column in the rollup loop. Re-evaluate with R2 events if avg time-to-process > 5s. |
| 1000-file submit times out the Worker (CPU budget) on submit due to N presigned URL generations | medium | Generate URLs in batches of 50 inside a single isolated CPU window. Verified locally with R2 SDK before merging. If it bites, push presigned-URL generation to a deferred `await waitUntil` and stream them via an SSE / second GET. |
| D1 transaction cost for 1000-row INSERT | medium | Use D1 batch API. Single transaction, prepared statements. Benchmark in Phase 1 dev. |
| One slow ingestion job blocks queue for the rest of the bulk | low | Existing queue has per-job concurrency. Bulk doesn't change concurrency semantics — N files is N jobs in the queue, not one mega-job. |
| Sandbox uploads 1000 files, browser drops half due to network glitch | medium | Per-file failure isolation handles this. Retry button re-uploads only the failed ones. |
| MCP description-length regression (a la 0.1.3) | medium | The release runbook's pnpm-test hard gate (added in 0.1.4) catches it. Extend `server.test.ts` to also assert tool count post-bulk. |
| Per-file overrides creep into Phase 1 scope | medium | Locked in §11; `per_file_overrides` field intentionally omitted from contracts. Adding it later is additive. |

---

## 8. File-touch summary (Phase 1)

| Action | Path |
|---|---|
| Add | `apps/api/migrations/postgres/0014_bulk_jobs.sql` |
| Add | `apps/api/migrations/sqlite/0014_bulk_jobs.sql` |
| Add | `packages/contracts/src/bulk-ingest.ts` |
| Edit | `packages/contracts/src/index.ts` (re-export) |
| Add | `apps/api/src/routes/bulk-ingest.ts` |
| Add | `apps/api/src/ingestion/bulk-rollup.ts` |
| Add | `apps/api/src/ingestion/finalize.ts` (extracted helper from existing single-file finalize route) |
| Edit | `apps/api/src/ingestion/dispatch.ts` (or wherever ingestion job terminal-state writes happen) |
| Edit | `apps/api/src/app.ts` (route mount) |
| Add | `apps/api/src/scheduled/bulk-job-expire.ts` |
| Edit | `apps/api/wrangler.toml` (cron entry, `BULK_INGEST_ENABLED` env) |
| Add | `packages/sdk/src/bulk-orchestrator.ts` |
| Edit | `packages/sdk/src/client.ts` (add `bulkIngest` block) |
| Edit | `packages/sdk/src/index.ts` (export orchestrator) |
| Edit | `apps/sandbox/src/pages/Ingest.tsx` (file-count branch) |
| Add | `apps/sandbox/src/components/bulk/BulkIngestPanel.tsx` |
| Add | `apps/sandbox/src/components/bulk/BulkConfigForm.tsx` |
| Add | `apps/sandbox/src/components/bulk/BulkFileTable.tsx` |
| Add | `apps/sandbox/src/components/bulk/BulkProgress.tsx` |
| Add | `apps/sandbox/src/components/bulk/BulkFileRow.tsx` |
| Add | `apps/sandbox/src/components/bulk/BulkFailureDrawer.tsx` |
| Add | `apps/api/test/bulk-{ingest,finalize,rollup,cancel,retry}.test.ts` |
| Add | `packages/sdk/test/bulk-orchestrator.test.ts` |
| Edit | `apps/api/src/routes/docs.ts` (add `Bulk Ingest` to `TAG_GROUPS`) |
| Edit | `apps/api/src/openapi/tag-descriptions.ts` (Markdown blurb for Bulk Ingest) |
| Edit | `apps/api/src/openapi/code-samples.ts` (curl + TS samples for bulk routes; orchestrator sample) |
| Edit | `apps/api/src/openapi/error-catalog.ts` (12 new `BULK_*` error rows) |
| Verify | `apps/api/test/openapi-coverage.test.ts` (assert new routes pass coverage invariants) |
| Edit | `docs/development/bulk_ingest/BULK_UPLOADS_DESIGN.md` (mark Phase 1 ✓ at top once shipped) |

## 9. File-touch summary (Phase 2)

| Action | Path |
|---|---|
| Add | `packages/mcp/src/tools/bulk-ingest.ts` |
| Add | `packages/mcp/src/fs/path-resolver.ts` |
| Edit | `packages/mcp/src/tools/index.ts` (register new tools) |
| Edit | `packages/mcp/test/server.test.ts` (count 21→24, ship-list) |
| Add | `packages/mcp/test/path-resolver.test.ts` |
| Add | `packages/mcp/test/bulk-ingest-tool.test.ts` |
| Add | `packages/mcp/src/prompts/bulk_ingest_directory.ts` |
| Edit | `packages/mcp/src/prompts/index.ts` (register prompt) |
| Edit | `apps/landing/src/components/Roadmap.astro` (move bulk-ingest to "shipped") |
| Edit | `docs/landingpage/COPY_DECK.md` (announcement copy) |
| Bump | `@textral/{contracts,sdk,mcp}` to **0.2.0** in lockstep |

---

## 10. Sequence at a glance

```
PHASE 1 (≈ 5 days)
├─ Day 1–2: migrations + contracts + routes (skeleton, dim-lock + idempotency)
├─ Day 3:   finalize loop + queue worker write-back + rollup
├─ Day 4:   SDK orchestrator + Phase 1 unit tests + Scalar/OpenAPI surface
└─ Day 5:   Sandbox UX + E2E smoke + flag-on dev

PHASE 2 (≈ 3 days, after 1 ships)
├─ Day 1: MCP path-resolver + bulk-ingest tool wiring
├─ Day 2: streaming progress + dry_run shape + tests
└─ Day 3: lockstep release 0.2.0 + landing-page update

PHASE 3 (gated on WEBHOOKS.md / COST_ATTRIBUTION.md)
└─ Bolt-on as those land; each ≈ 1 day.
```

---

## 11. What was locked from design open questions

| # | Question | Decision |
|---|---|---|
| 1 | Per-file heterogeneity | **Wait.** No `per_file_overrides` in v1 contracts. |
| 2 | Auto-finalize default | **Sandbox uses `false` + confirm step. SDK and MCP use `true`.** |
| 3 | >1000-file folder upload | **Defer.** Sandbox shows hint + first 1000. Add roadmap item: `BULK_INGEST_GROUPING.md` for `bulk_job_group_id` later. |
| 4 | URL-based bulk | **Out of scope.** Future URL-source bulk goes through the connector marketplace path (`INTEGRATIONS.md`) and reuses the bulk job model on the inside. No URL mode added to `ingest_local_paths`. |
| 5 | Bulk re-ingest of known docs | **Skip.** No `bulk_reingest` tool in v1. |
| 6 | Webhook events | **`bulk_job.completed`, `bulk_job.failed`, `bulk_job.partial` only.** No per-file events. Phase 3, gated on `WEBHOOKS.md`. |
| 7 | Job-level retry button | **No.** A new bulk job is a new bulk job. |
| 8 | MCP progress streaming | **Phase 2, default `wait=true` streams progress notifications.** MCP is a first-class citizen; agents handle streaming natively. |

---

## 12. Acceptance criteria mapping (from design §11)

| # | Criterion | Phase that satisfies it |
|---|---|---|
| 1 | Sandbox: 47 mixed files, partial success, retry-failed | **1** |
| 2 | API: curl-only end-to-end with poll | **1** |
| 3 | MCP: directory ingest, no bytes in agent context, idempotent re-run | **2** |
| 4 | Audit: `bulk_job_id` filter returns full lineage | **1** (via §6.3) |
| 5 | Idempotency: same `client_request_id` = same job | **1** |
| 6 | Limits: 1001 files = `BULK_TOO_MANY_FILES` | **1** |
| 7 | Dim-lock: 1024d ns + 1536d cfg = `BULK_DIMENSION_LOCK_MISMATCH` | **1** |

When all seven are passing in CI and verified manually in dev,
implementation is **done** in the sense the design doc means.

---

## 13. Followups noted for the roadmap (after this ships)

- **`BULK_INGEST_GROUPING.md`** — `bulk_job_group_id` for >1000-file
  workflows (locked answer §11.3). Add to `docs/roadmap/`
  alongside `BULK_UPLOAD_SANDBOX.md`.
- **Bulk re-ingest of known documents.** When chunking profile or
  embedding model changes, re-embed without re-upload. Skip in v1
  (§11.5); revisit when a customer needs it.
- **Per-file `chunking` / `doc_type` overrides.** Unblock when a
  real heterogeneous-corpus customer surfaces (§11.1).
- **R2 event-driven auto-finalize** instead of state polling. If
  Phase 1 telemetry shows finalize lag matters, swap polling for
  R2 → Worker event subscriptions.

---

> **Last reviewed:** 2026-05-08. Status: **proposed**. Awaiting
> implementation kickoff. When Phase 1 begins, change Status to
> `in flight` and check items off in the Phase 1 file-touch table
> (§8) as PRs land.
