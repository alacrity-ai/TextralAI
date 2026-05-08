# Bulk Uploads — Design

> **Status.** Design proposal. Supersedes `BULK_UPLOAD_SANDBOX.md`
> (problem statement) and incorporates `LARGE_INGEST_ISSUE.md` (the
> deep MCP-side analysis) as §5.2 of this doc.
>
> **Surfaces in scope.** API, MCP, Sandbox. Same job model. Same audit.
>
> **Last drafted:** 2026-05-08. Owner: Leif.

---

## 1. Why this exists

Textral's ingest pipeline is well-architected for a single document.
The existing flow is already the "right" shape for bulk:

```
POST /v1/namespaces/{ns}/documents          → register
POST /v1/documents/{id}/uploads             → presigned R2 URL
PUT  <presigned>                            → upload bytes
POST /v1/documents/{id}/uploads/{u}/finalize → compute hash, dedupe
POST /v1/documents/{id}/ingest              → enqueue ingestion job
```

Five hops × one file = fine. Five hops × 100 files = a coordination
problem nobody should be solving in a `for` loop in their own code,
and which **can't** be solved in an agent's context window because of
the failure mode documented in `LARGE_INGEST_ISSUE.md` §1.

This document specifies a **single bulk job model** that:

- The SDK can drive transparently from a list of `File` objects or
  filesystem paths.
- The MCP server can drive from a directory glob without ever placing
  file bytes in the agent's tool-call payload.
- The Sandbox can drive from a multi-file drag-drop, with progress
  that survives a page refresh.
- The API exposes as a single, durable, replayable job that audit and
  UI can both query.

## 2. Non-goals (v1)

- **Per-file embedding/chunking heterogeneity.** v1 enforces one
  embedding config, one chunking profile, one provider-key set, one
  namespace, per bulk job. Mixing per file is future work — see §10.
- **Re-ingest / version-bump in bulk.** Already-known `document_id`s
  getting new versions in batch — useful, but a separate operation,
  per `LARGE_INGEST_ISSUE.md` §4. Future work.
- **URL-based bulk** (`urls: [...]`). Future work; pulls in HTTP
  fetching, content-type sniffing, redirect handling.
- **Cross-namespace bulk.** A bulk job targets exactly one namespace.
  If you want two, you submit two jobs. Keeping this constraint avoids
  per-file dim-lock conflicts blowing up mid-job.
- **Files larger than 25 MB.** Existing per-file cap stays. Anything
  larger needs the chunked-upload future work mentioned in
  `LARGE_INGEST_ISSUE.md` §4 — orthogonal to bulk.

## 3. Design at a glance

```
                    ┌─────────────────────────────────────────────┐
                    │            POST /v1/ingest/bulk             │
                    │   (manifest: per-file rows, shared config)  │
                    └────────────────┬────────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────────┐
                    │   bulk_job_id + N presigned R2 PUT URLs     │
                    └────────────────┬────────────────────────────┘
                                     │
       ┌─────────────────────────────┼──────────────────────────────┐
       │  Client uploads each file directly to R2 (parallel, conc.) │
       └─────────────────────────────┼──────────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────────┐
                    │   POST /v1/ingest/bulk/{job_id}/finalize    │
                    │   (or auto-finalize as files arrive)        │
                    └────────────────┬────────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────────┐
                    │  Each file → existing single-file pipeline: │
                    │  finalize → register → enqueue ingest job.  │
                    │  No new pipeline.                           │
                    └────────────────┬────────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────────┐
                    │  GET /v1/ingest/bulk/{job_id} for aggregate │
                    │  state. Per-file failures isolated.         │
                    └─────────────────────────────────────────────┘
```

Key principles:

1. **Bulk is a thin orchestration layer over the existing
   single-file pipeline.** No parallel implementation. No new
   chunking, no new embedding path. Per-file rows resolve to ordinary
   `documents` and `ingestion_jobs`.
2. **Per-file isolation.** One bad PDF doesn't fail the other 99.
   The bulk job's terminal state is `complete`, `partial`, or
   `failed`, derived from per-file states.
3. **Bytes never traverse the agent's context.** MCP reads from the
   agent's local filesystem and uploads directly to R2.
4. **Idempotent at every level.** `client_request_id` per file in the
   manifest. Hash-based deduplication unchanged from single-file.
5. **One config per job.** Homogeneous corpus assumption — see §6.

## 4. Architecture

### 4.1 The `bulk_jobs` entity

New D1 table. Roughly:

```sql
CREATE TABLE bulk_jobs (
  bulk_job_id           TEXT PRIMARY KEY,        -- bjk_{ULID}
  tenant_id             TEXT NOT NULL,
  namespace_id          TEXT NOT NULL,
  state                 TEXT NOT NULL,           -- see §4.2
  config_json           TEXT NOT NULL,           -- shared embedding/chunking/etc
  client_request_id     TEXT,                    -- caller-supplied dedupe key
  total_files           INTEGER NOT NULL,
  files_uploaded        INTEGER NOT NULL DEFAULT 0,
  files_succeeded       INTEGER NOT NULL DEFAULT 0,
  files_failed          INTEGER NOT NULL DEFAULT 0,
  files_skipped         INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  finalized_at          INTEGER,                 -- when caller called finalize
  completed_at          INTEGER,                 -- terminal-state timestamp
  expires_at            INTEGER NOT NULL,        -- 7-day TTL on un-finalized jobs
  source                TEXT NOT NULL            -- 'api' | 'mcp' | 'sandbox'
);

CREATE TABLE bulk_job_files (
  bulk_job_id           TEXT NOT NULL,
  ordinal               INTEGER NOT NULL,        -- stable index for caller
  filename              TEXT NOT NULL,
  size_bytes            INTEGER NOT NULL,
  content_type          TEXT NOT NULL,
  state                 TEXT NOT NULL,           -- see §4.2
  upload_id             TEXT,                    -- existing uploads row
  upload_url            TEXT,                    -- presigned R2 PUT, expires
  upload_url_expires_at INTEGER,
  document_id           TEXT,                    -- after register
  version_id            TEXT,                    -- after finalize
  ingestion_job_id      TEXT,                    -- after ingest enqueue
  error_code            TEXT,                    -- canonical error catalog ref
  error_detail          TEXT,
  client_request_id     TEXT,                    -- per-file idempotency
  PRIMARY KEY (bulk_job_id, ordinal)
);

CREATE INDEX idx_bulk_jobs_tenant ON bulk_jobs(tenant_id, created_at DESC);
CREATE INDEX idx_bulk_jobs_namespace ON bulk_jobs(namespace_id, created_at DESC);
CREATE INDEX idx_bulk_job_files_state ON bulk_job_files(bulk_job_id, state);
```

The bulk job stores **shared config** once (embedding, chunking,
mode, etc. — exactly the existing `IngestRequest` shape minus
`version_id` which is per-file). Per-file rows reference the
`uploads` and `documents` and `ingestion_jobs` rows that the existing
single-file pipeline already creates.

### 4.2 State machine

**Bulk job states:**

| State | Meaning | Terminal? |
|---|---|---|
| `accepted` | Manifest validated, presigned URLs issued, awaiting uploads. | no |
| `uploading` | At least one file's bytes in R2; still receiving. | no |
| `finalizing` | Caller called `finalize` (or auto-finalize tripped); per-file ingest jobs being enqueued. | no |
| `processing` | All files enqueued; ingestion_jobs running. | no |
| `complete` | Every file `succeeded`. | ✓ |
| `partial` | At least one `succeeded` and at least one `failed` or `skipped`. | ✓ |
| `failed` | Every file `failed` (or job aborted before any succeeded). | ✓ |
| `cancelled` | Caller cancelled before completion. Per-file states frozen. | ✓ |
| `expired` | Job not finalized within TTL; presigned URLs expired; cleaned. | ✓ |

**Per-file states:**

| State | Meaning |
|---|---|
| `pending` | Manifest entry exists, presigned URL issued, no upload yet. |
| `uploaded` | R2 PUT succeeded; bytes in `tmp/` prefix. |
| `finalized` | `finalize` ran; hash computed; deduplicated against existing version (or fresh). |
| `enqueued` | `ingestion_job` row created; queue consumer not yet picked it up. |
| `processing` | `ingestion_job` actively chunking/embedding/indexing. |
| `succeeded` | Ingestion job completed; vectors indexed; document version live. |
| `failed` | Any step above raised; `error_code` populated. |
| `skipped` | `on_existing: skip_if_unchanged` matched; no new version cut. |

**Transitions are monotonic.** A file does not move from `succeeded`
back to `processing`. The only way a "succeeded" file gets
re-processed is by submitting a new bulk job with `force_rebuild`
or `on_existing: new_version`.

### 4.3 Reuse of existing single-file primitives

The bulk endpoints emit and own no new ingestion machinery. Internally:

| Bulk action | Reuses |
|---|---|
| Issue presigned URL per file | Existing `POST /v1/documents/{id}/uploads` logic, extracted into a helper |
| Finalize a file | Existing `POST /v1/documents/{id}/uploads/{u}/finalize` |
| Enqueue ingest | Existing `POST /v1/documents/{id}/ingest` (writes to the same queue) |
| Track progress | Per-file rows mirror state from `documents` + `ingestion_jobs` |

The queue consumer (worker) **doesn't change**. It pulls one
`ingestion_job` at a time. Its only awareness of bulk: when an
ingestion job's row carries `bulk_job_id`, the worker writes the
terminal status back to `bulk_job_files` on completion (a single
extra `UPDATE` per file). The bulk job's aggregate counts then update
via a transaction at the end of each per-file ingest.

This is the entire architectural delta. The bulk model is a
**spreadsheet of single-file ingests with one configuration row at
the top.**

## 5. Per-surface design

### 5.1 API

#### Endpoints

```
POST   /v1/ingest/bulk                       Submit manifest. Returns bulk_job_id + presigned URLs.
POST   /v1/ingest/bulk/{job_id}/finalize     Mark all uploads complete, kick off processing.
GET    /v1/ingest/bulk/{job_id}              Aggregate + per-file state.
GET    /v1/ingest/bulk/{job_id}/files        Paginated per-file rows (for large jobs).
DELETE /v1/ingest/bulk/{job_id}              Cancel. Refuses if any file is `succeeded`.
POST   /v1/ingest/bulk/{job_id}/retry        Retry only `failed` files (re-enqueues, no re-upload).
GET    /v1/ingest/bulk?namespace=…&state=…   List recent bulk jobs.
```

#### Request — `POST /v1/ingest/bulk`

```jsonc
{
  "namespace": "alexandria",
  "client_request_id": "cli_2026-05-08T10:30:00Z_a3f9",   // optional, tenant-scoped dedupe
  "config": {                                              // shared by every file
    "embedding": {
      "provider": "openai",
      "model": "text-embedding-3-large",
      "dimensions": 1536,
      "provider_key_ref": "default"
    },
    "chunking": { "profile": "generic", "target_tokens": 600, "overlap_tokens": 80 },
    "indexing": { "artifact_types": ["passage"] },
    "mode": "full"
  },
  "files": [
    { "ordinal": 0, "filename": "alexandria.md",  "size_bytes": 47213, "content_type": "text/markdown", "client_request_id": "..." },
    { "ordinal": 1, "filename": "lighthouse.pdf", "size_bytes": 184201, "content_type": "application/pdf" }
    // ...
  ],
  "on_existing": "skip_if_unchanged",                      // skip_if_unchanged | new_version | replace_current
  "auto_finalize": true                                    // server flips state once all uploads land — see below
}
```

`auto_finalize: true` (default) means the caller doesn't need to
poll-and-finalize; once R2 confirms all files uploaded, the server
auto-transitions to `finalizing → processing`. `auto_finalize: false`
gives the caller an explicit gate (useful for large jobs you want to
inspect before kicking off paid work).

#### Response

```jsonc
{
  "bulk_job_id": "bjk_01KR4P…",
  "state": "accepted",
  "total_files": 47,
  "uploads": [
    {
      "ordinal": 0,
      "upload_url": "https://r2-presigned…",
      "upload_id": "ulp_…",
      "expires_at": 1715179200,
      "method": "PUT",
      "headers": { "Content-Type": "text/markdown" }
    }
    // … one per file, in `ordinal` order
  ],
  "expires_at": 1715784000                                 // 7-day TTL on un-finalized job
}
```

#### Limits (v1 — tunable per tenant later)

| Limit | Value | Why |
|---|---|---|
| Files per bulk job | 1000 | D1 row throughput; predictable Workers CPU budget on `submit` |
| Bytes per file | 25 MB | Existing per-file cap, unchanged |
| Bytes per bulk job | 5 GB | R2 + queue throughput sanity bound |
| Concurrent bulk jobs per tenant | 10 | Prevents one tenant saturating the embedding queue |
| Un-finalized job TTL | 7 days | Presigned URLs and tmp R2 keys auto-expire |
| Retention of completed jobs | 90 days | Audit query window |

Exceeding any of these returns a structured error before any
presigned URLs are issued — no half-state.

#### Errors (canonical catalog refs — see `textral://error-catalog`)

- `BULK_TOO_MANY_FILES`
- `BULK_BYTES_EXCEEDED`
- `BULK_DUPLICATE_FILENAMES_IN_JOB` *(filenames within one job must be unique to make idempotency clean — UI ergonomics, not a hard architectural need; reconsider if it bites)*
- `BULK_DIMENSION_LOCK_MISMATCH` *(namespace dim-lock conflicts with the embedding config — fail fast at submit, not file-by-file)*
- `BULK_NAMESPACE_NOT_FOUND`
- `BULK_PROVIDER_KEY_NOT_FOUND`
- `BULK_QUOTA_EXCEEDED`
- (per-file) `BULK_FILE_HASH_MISMATCH`, `BULK_FILE_UPLOAD_EXPIRED`,
  `BULK_FILE_FORMAT_UNSUPPORTED`, plus the existing single-file
  ingest error vocabulary.

#### Idempotency

- **Job-level.** `client_request_id` on the request body. If a row
  exists in `bulk_jobs` with the same `(tenant_id, client_request_id)`
  pair within 24h, return the existing job's response instead of
  creating a new one.
- **File-level.** `client_request_id` on each file entry. The bulk
  job retries only re-issue presigned URLs for files whose
  `client_request_id` doesn't already have a `succeeded` row.
- **Hash-level.** Existing dedupe at finalize time stays unchanged.
  A file with the same `(document_id, content_hash)` as a live
  version becomes `skipped` per `on_existing: skip_if_unchanged`.

#### Aggregate status — `GET /v1/ingest/bulk/{job_id}`

```jsonc
{
  "bulk_job_id": "bjk_…",
  "state": "processing",
  "namespace": "alexandria",
  "total_files": 47,
  "counts": {
    "pending": 0, "uploaded": 0, "finalized": 0,
    "enqueued": 12, "processing": 6,
    "succeeded": 27, "failed": 2, "skipped": 0
  },
  "progress_pct": 57,
  "first_failure": {
    "ordinal": 14,
    "filename": "scholars.pdf",
    "error_code": "BULK_FILE_FORMAT_UNSUPPORTED",
    "error_detail": "PDF appears to be encrypted (page 1 streams unreadable)"
  },
  "started_at": 1715170000,
  "finalized_at": 1715170120,
  "completed_at": null,
  "audit_query_event_filter": "bulk_job_id:bjk_…"          // ready-to-paste filter
}
```

Per-file rows fetched via `/files` to keep the aggregate response
bounded for 1000-file jobs.

### 5.2 MCP

The MCP-side problem is comprehensively analyzed in
`LARGE_INGEST_ISSUE.md`. That doc's **§3 proposed solution stands as
written** — we adopt it. This section is the bridge between that
solution and the bulk-job model in §4 above.

#### Tool surface

Three tools, all stdio-only:

| Tool | Purpose | Input |
|---|---|---|
| `ingest_local_paths` | Bulk ingest from local FS. The flagship. | `{ mode: "files" \| "glob", namespace, files? \| root+patterns, defaults, on_existing, dry_run, response_detail }` |
| `get_bulk_ingest_job` | Poll an in-flight or completed bulk job. | `{ bulk_job_id, files_page?: number, files_page_size?: number, only_failures?: boolean }` |
| `cancel_bulk_ingest_job` | Abort a running bulk. | `{ bulk_job_id }` |

The single-file `ingest_file` stays. It remains correct for the
remote-MCP / agent-sees-bytes case. It is **not** the bulk path.

The existing `register_provider_key` / `register_infra_key` tools
remain unchanged.

#### Why `ingest_local_paths` does not place bytes in agent context

This is the core fix for the failure mode in `LARGE_INGEST_ISSUE.md`:

1. The MCP server runs **on the user's machine** via `npx` over
   stdio. It already has process-level filesystem access.
2. The tool input is paths or globs — never bytes. Tool description
   explicitly forbids the agent from base64-ing files. (Description
   shape forces compliance: there is no `bytes` param to fill.)
3. The MCP server reads each file from disk into its own process
   memory, streams it to a presigned R2 URL via fetch, then discards.
   Memory footprint is bounded by `concurrency` (default 4) ×
   25 MB max-per-file = ~100 MB worst case. Negligible.
4. The agent's tool-call payload is constant-size regardless of file
   count: a path string, a glob, a config object. ~1 KB.
5. The agent's tool-result is a compact summary by default
   (`response_detail: "summary"`). For 1000 files, a summary is
   ~150 bytes. The agent gets a `bulk_job_id` to poll for follow-up.

This is the explicit design contract. If at any point a future
revision adds a `bytes`/`content` field to `ingest_local_paths`, that
is the moment we have re-introduced the bug.

#### Mapping `ingest_local_paths` → bulk API

```
ingest_local_paths({ mode: "glob", root, patterns, defaults, ... })
  │
  ├─ resolve realpaths + allowlist + size + extension checks
  ├─ stat all matched files
  │
  ├─ POST /v1/ingest/bulk                  ← single call, manifest from stat results
  │     body: { namespace, config: defaults, files: [...],
  │             on_existing, auto_finalize: true,
  │             client_request_id: <hash of (root, patterns, defaults)> }
  │
  ├─ for each upload URL in response (concurrency-limited):
  │     read bytes from disk
  │     PUT bytes to upload_url
  │     (no further API call — server auto-finalizes via R2 event)
  │
  └─ if wait=true:
       poll GET /v1/ingest/bulk/{id} until terminal state
       return summary per response_detail
     else:
       return { bulk_job_id, total_files, "Use get_bulk_ingest_job to poll." }
```

The MCP tool becomes a 100-line orchestrator. Everything important
lives in the bulk API.

#### `dry_run` is non-negotiable

For the agent UX path of "ingest every md file under ./docs", the
agent's first call should be `dry_run: true` to confirm the glob
matched what it expected, then a confirmed call. This is in
`LARGE_INGEST_ISSUE.md` §3.6 and remains correct.

### 5.3 Sandbox

#### UX rule: one input, two behaviours

The existing ingest page has a single drop zone / file picker. We
keep it. The `multiple` attribute goes on the `<input>`. Behaviour
branches purely on file count after the user's drop or selection:

| File count | Behaviour |
|---|---|
| 1 | Existing single-file flow. Unchanged. |
| 2+ | Bulk flow. Switches the inline form to "Bulk ingest (47 files)" with the same shared-config form. |

No separate "bulk ingest" tab. No mode toggle. Auto-routing.

#### The shared-config form

For 2+ files, the form looks identical to the single-file form
except:

- The "filename" / "title" field becomes a per-file row in the table
  below (auto-populated from the file name; user can edit each).
- A small banner above the form: "47 files queued. Same embedding
  provider, model, and chunking applied to all. Per-file overrides
  not supported in v1."
- The submit button reads "Start bulk ingest" and pulses with the
  total bytes ("12.4 MB").

#### Progress UI

After submit:

```
┌───────────────────────────────────────────────────────────────┐
│  Bulk job  bjk_01KR…   ▸  alexandria   ▸  47 files            │
│                                                               │
│  ████████████████████░░░░░░░░░░░░░░░░░░░░░  46 % (22 / 47)    │
│                                                               │
│  ✓ 22 succeeded     ⏳ 12 processing     ✗ 2 failed           │
│                                                               │
│  ┌─ scholars.pdf                            ✗ format unsupp.  │
│  ├─ founding.md                             ✓ v_01KR…         │
│  ├─ decline.md                              ⏳ embedding…      │
│  └─ … (+44 more)                                              │
│                                                               │
│  [Retry failed files]   [Cancel]   [Copy bulk_job_id]         │
└───────────────────────────────────────────────────────────────┘
```

State source: `GET /v1/ingest/bulk/{job_id}` polled every 1.5s while
the user is on the page. Polling stops when `state` is terminal.
**Survives refresh** — `bulk_job_id` is in the URL hash, so refreshing
the page re-attaches to the in-flight job.

#### File table column behaviour

- **Filename column** is editable until upload starts (row state
  goes from `pending` → `uploaded`).
- **Status column** color-codes against the existing palette:
  `accent-success` for ✓, `accent-amber` for in-flight, `accent-coral`
  for ✗, `text-tertiary` for `skipped`.
- **Click a failed row** → drawer opens with `error_code`,
  `error_detail`, the `query_event_id` it would have produced, and
  a "retry just this file" action.

#### Concurrency control

The Sandbox uploads files **sequentially in chunks of 6**, not all
1000 in parallel. The browser's HTTP/2 multiplexing handles this
gracefully; mid-tier laptops on consumer networks don't.

#### Drag-drop affordances

- Visual drop-target lights up teal on `dragenter`.
- Folder drop is supported (using `webkitGetAsEntry`) — recursive
  walk to flatten files. Honors a 1000-file cap, surfacing
  "Folder contains 2,341 files; first 1000 will be queued. Submit
  the rest as a separate job." Not a hard refusal — accept what fits.

## 6. Constraints

### 6.1 Homogeneous config (v1)

A single bulk job applies the same:

- Embedding provider + model + dimensions
- Provider-key reference (or ID)
- Chunking profile + target_tokens + overlap_tokens
- Enrichment config
- Indexing config
- `mode` (full / embed_only / enrichment_only)
- `on_existing` policy

…to every file in the job. This is intentional. Agents and humans
both think about "ingest this corpus" as a single decision; the
moment we offer per-file overrides we re-introduce the kind of
configuration sprawl that makes single-file ingestion painful.

If the user genuinely has heterogeneous corpora, they submit two
bulk jobs.

See §10 open question 1 for how we'd grow into heterogeneity later.

### 6.2 Dim-lock + namespace contract

Per `1-DESIGN.md`, namespaces dim-lock on first ingest. Bulk
amplifies the failure cost: a 500-file batch into a wrong-dimension
namespace is 500 wasted embeddings if we don't fail fast.

The submit endpoint **resolves the embedding profile and verifies
dimension compatibility against the namespace's lock before issuing
any presigned URLs**. If the lock conflicts, return
`BULK_DIMENSION_LOCK_MISMATCH` with the existing dim and the
attempted dim. No bytes uploaded, no money spent.

If the namespace has no lock yet (first ingest into it), the bulk
job *creates* the lock atomically on `finalize` — the first file's
dimension config wins, and any heterogeneous-dim files in the same
job (which v1 doesn't allow anyway) fail with a clear error.

### 6.3 Failure isolation

A single file's failure does not abort the bulk. Per-file states are
independent. The bulk's terminal state is derived:

```
all succeeded                                   → complete
some succeeded, some failed/skipped/no-data    → partial
all failed                                     → failed
caller cancelled                               → cancelled
```

The retry endpoint operates only on `failed` rows. It re-issues
presigned URLs for those rows (existing R2 keys, if still valid,
are reused — files don't need re-upload unless the upload itself
failed). The bulk job state transitions back to `processing` and
follows the same path.

## 7. Audit integration

Every per-file ingestion already produces a full audit chain
(document → version → ingestion_job → query events later). The bulk
layer adds one cross-cutting handle:

- Each `ingestion_jobs` row carries a `bulk_job_id` foreign key
  when it was enqueued via bulk.
- A new audit query: "show every document, version, and ingestion
  outcome from bulk job X" becomes a single SQL join.
- The MCP `get_query_event` tool gains an optional `bulk_job_id`
  filter for retrieval-side queries that hit chunks from a known
  bulk job. Useful for "are my freshly-bulk-ingested docs being
  retrieved?" sanity-checking.

The single-file ingestion path is unchanged. Files ingested without
a bulk job have `bulk_job_id = NULL` — the audit story for those
remains exactly what it is today.

## 8. Failure modes (and how the design handles them)

| Failure | Handling |
|---|---|
| Network drops mid-upload | Per-file. Re-issuing the presigned URL on retry resumes that single file. |
| Browser closes mid-bulk | `bulk_job_id` in URL hash → refresh re-attaches; un-uploaded files still have valid presigned URLs (until `expires_at`) and the user resumes. |
| Embedding provider rate-limits | Existing queue back-pressure handles it. Per-file states surface `BULK_FILE_PROVIDER_THROTTLED` if it exceeds retry budget; user retries those files. |
| One PDF is encrypted | That file becomes `failed` with `BULK_FILE_FORMAT_UNSUPPORTED`. Other 999 unaffected. |
| Wrong namespace dim-lock | Fail at submit, no presigned URLs issued, no money spent. |
| Tenant exceeds quota mid-job | Existing single-file quota check fires per file. The bulk job becomes `partial`; subsequent files queue or fail per quota. |
| Caller submits the same manifest twice | Job-level `client_request_id` dedupes; second call returns the first job's response. |
| Agent restarts conversation while bulk is running | `bulk_job_id` was returned to the agent on submit; it can call `get_bulk_ingest_job` after restart. |
| Agent submits 50,000-file glob via MCP | `BULK_TOO_MANY_FILES` at submit. The MCP `dry_run` would have caught this earlier. |
| Half the files succeed, agent wants to ingest the other half differently | They were probably trying to do per-file heterogeneity; not supported in v1 (§6.1). They submit a second bulk for the remaining files. |

## 9. Implementation phases

A reasonable sequencing — not committed.

**Phase 1: API + sandbox (the workhorses)**

- D1 migrations for `bulk_jobs`, `bulk_job_files`, FK on `ingestion_jobs`.
- API endpoints in §5.1.
- Queue consumer write-back to `bulk_job_files` on per-file
  completion.
- Sandbox UX in §5.3.
- SDK helper: `client.ingest.bulk({ files, config, ... })` that
  hides the manifest + presigned URL choreography.

**Phase 2: MCP tool**

- `ingest_local_paths` per `LARGE_INGEST_ISSUE.md` §3, wired to the
  bulk API from Phase 1.
- `get_bulk_ingest_job`, `cancel_bulk_ingest_job` MCP tools.
- Existing `ingest_file` keeps working.

**Phase 3: Polish**

- Retry-only-failed endpoint and sandbox button.
- Webhook events on bulk job state transitions (depends on
  `WEBHOOKS.md`).
- Cost attribution rollup per bulk job (depends on
  `COST_ATTRIBUTION.md`).
- MCP streaming progress notifications during `wait=true` runs
  (per `LARGE_INGEST_ISSUE.md` §3.10).

## 10. Open questions

1. **Per-file heterogeneity.** v1 enforces homogeneous config. The
   natural growth path: allow a `per_file_overrides` field where
   individual `ordinal`s can override `chunking` and `doc_type` only
   (never embedding — that's dim-lock-fatal). Worth doing? Worth
   waiting until a customer asks?
   Answer: Wait on this for now
2. **Auto-finalize default.** v1 default is `auto_finalize: true`
   (server flips to `processing` once R2 confirms last upload).
   Should the Sandbox use that, or always set `false` so the user
   can review before "Start ingest"? Recommend the Sandbox uses
   `false` and shows a confirm step; SDK and MCP use `true`.
   Answer: I defer to your recommendation
3. **Folder upload via the Sandbox.** Already specified in §5.3 as
   a 1000-file cap. Should we add server-side support for >1000-file
   jobs by chunking into multiple bulk jobs and tying them together
   with a `bulk_job_group_id`? Probably deferrable until someone
   needs >1000.
   Answer: Defer for now, but make a note of it for later roadmap.
4. **Bulk-from-URL.** Out of scope for v1 (§2). When we do it,
   should it be a third `mode` on `ingest_local_paths`
   (`mode: "urls"`) or a separate tool `ingest_urls`? I lean
   separate tool — different failure surface, different rate
   semantics.
   Answer: Likely bulk from a URL will be an integration.  We talked about slack integrations, S3 integrations, Confluence integrations. I think bulk from a URL would apply in that category?
5. **Re-ingest of already-known documents in bulk.** Useful: "my
   chunking profile changed, re-embed all 500 docs in this
   namespace." Out of v1 (§2). Future tool: `bulk_reingest` that
   takes `document_id`s, not paths or files. Reuses bulk infra,
   skips the upload phase entirely.
   Answer: Skip for now.
6. **Bulk job webhook events.** Once `WEBHOOKS.md` lands, what's
   the minimum useful set? Recommend: `bulk_job.completed`,
   `bulk_job.failed`, `bulk_job.partial`. Not per-file — those would
   spam.
   Answer: I defer to your judgement here.
7. **Job-level retry vs file-level retry.** v1 supports retrying
   only failed files. Should we also support a "redo the whole job
   with different config" button on the Sandbox? Probably no; it's
   just a new bulk job. Resist feature creep.
   Answer: Probably no. Resist feature creep.
8. **MCP progress streaming.** Currently MCP `wait=true` returns
   one big response when terminal. `LARGE_INGEST_ISSUE.md` §3.10
   suggests streaming progress notifications. The MCP SDK does
   support these. Decision: ship without streaming in Phase 2,
   add in Phase 3 if it materially improves the agent UX.
   Answer: Let's go for a strong agent UX. I defer to your judgement here, but our MCP is a first class citizen in Textral, so the more ergonomic the better.

## 11. Acceptance criteria

The design is correctly implemented when:

1. **Sandbox.** Drop 47 mixed `.md` and `.pdf` files into the
   existing ingest page. The form auto-switches to bulk mode. One
   submit. Progress UI shows live per-file status. A page refresh
   keeps showing progress for the same job. One file fails; the
   other 46 succeed. The bulk job becomes `partial`; the failed
   file shows `error_code` + `error_detail`; clicking "retry"
   re-runs only that file.
2. **API.** A `curl` script can submit a 100-file manifest, get
   100 presigned URLs back, `PUT` each, and poll `GET .../{id}`
   until terminal. No SDK required. Total wall-clock time bounded
   only by R2 + embedding queue, not by the bulk endpoint itself.
3. **MCP.** The literal prompt from `LARGE_INGEST_ISSUE.md` §1.3
   ("Ingest the PDFs in `./contracts` into a `vendor-contracts`
   namespace") works in a single tool call from the agent. The
   tool-call payload is one path + one config object. The
   tool-result is a one-line summary plus a `bulk_job_id`. No file
   bytes appear anywhere in the conversation transcript. Re-running
   the same prompt after editing two files only does work for those
   two files.
4. **Audit.** A query `bulk_job_id:bjk_01KR…` returns every
   document, version, and ingestion job from that bulk in one go,
   with full lineage intact.
5. **Idempotency.** Submitting the same manifest with the same
   `client_request_id` twice within 24h returns the same `bulk_job_id`
   both times. No duplicate ingestion.
6. **Limits.** Submitting 1001 files returns `BULK_TOO_MANY_FILES`
   before any presigned URLs are issued.
7. **Dim-lock.** Submitting against a 1024-d namespace with a
   1536-d embedding config returns `BULK_DIMENSION_LOCK_MISMATCH`
   before any presigned URLs are issued.

If any of those still requires bespoke per-tenant code, ad-hoc
shell loops, or agents base64-encoding files into context, the
implementation isn't done.

---

## Related

- `BULK_UPLOAD_SANDBOX.md` — original problem statement.
  Superseded by this doc.
- `LARGE_INGEST_ISSUE.md` — deep MCP-side analysis. Still load-bearing
  for §5.2 above; do not delete.
- `INTEGRATIONS.md` / `CONNECTOR_MARKETPLACE.md` — bulk-from-source
  (Notion / Drive / Confluence). Different ingestion surface, but
  reuses the bulk job model proposed here on the inside.
- `WEBHOOKS.md` — event subscription for bulk-job state transitions.
- `COST_ATTRIBUTION.md` — per-bulk cost rollup.
