# Bulk Ingest — Quality Pass (Design)

> **Status.** Design. Three issues observed in real usage of the
> shipped bulk pipeline. This doc walks each one to root cause,
> proposes a fix, and lists the design decisions taken.
> Implementation lives in
> [`BULK_QUALITY_PASS_IMPL.md`](./BULK_QUALITY_PASS_IMPL.md).
>
> **Last drafted:** 2026-05-08.

---

## 1. Issues observed

Three discrete issues from a real bulk run on prod:

1. **Drop-zone copy implies single-file.** The label reads
   "Drop a file here, or click to browse." There's no signal that
   multiple files work, even though `multiple` is set on the input
   and the bulk panel auto-routes when 2+ files are dropped.

2. **Retrying a failed bulk with `new_version` or `replace_current`
   fails with `BULK_FILE_FINALIZE_FAILED` →
   `D1_ERROR: UNIQUE constraint failed: document_versions.document_id, document_versions.content_hash`.**
   First bulk run failed mid-finalize (e.g., bad provider key). On
   retry, the finalize loop re-encounters an existing
   `document_versions` row whose `(document_id, content_hash)`
   matches the bytes in the new bulk, and `INSERT INTO
   document_versions ...` collides with the UNIQUE constraint.

3. **Navigating away mid-bulk loses the job.** A bulk in any
   non-terminal state (especially `awaiting_confirm`) is only
   reachable while the URL hash anchors `#bulk=<id>` on the ingest
   page. Click "Query" or any other nav link and the job is gone
   from the UI — the rows in `bulk_jobs` and `bulk_job_files`
   stay alive on the server (and the cron will sweep them in 7
   days) but the user has no path back to the in-flight session.

The fixes for these are independent of each other; they share this
doc only because they were observed in the same QA pass.

---

## 2. Issue 1 — drop-zone copy

### Root cause

Stale copy from before the bulk panel landed. The label was
written for the single-file flow and never revised when
`multiple` was added to the `<input>`.

### Fix

Change the drop-zone label from:

> Drop a file here, or click to browse
> markdown · plaintext · &lt; 25 MB

to:

> Drop file(s) here, or click to browse
> markdown · plaintext · pdf · &lt; 25 MB each · multi-select for bulk

Two changes:

1. **`a file` → `file(s)`**. Explicit plural marker. The smallest
   change that conveys multi-select.
2. **`multi-select for bulk`** as a third tagline below the size
   cap. Tells the user that dropping 2+ files routes through a
   different flow.

The third file extension (`pdf`) is already accepted by the
`accept=` attribute; the label just needs to match.

### Decision

Change copy. No structural change. Single PR-sized edit in
`apps/sandbox/src/pages/Ingest.tsx`.

---

## 3. Issue 2 — UNIQUE constraint on retry

### Root cause walkthrough

Trace the failure:

1. **First bulk run.** User submits 3 files. Each per-file
   `finalizeBulkJobFile()` runs through:
   1. HEAD R2 tmp, validate size — OK
   2. Stream + sha256 — OK
   3. `findDocumentByTitleInNamespace` — NULL (first time)
   4. `getVersionByContentHash` — NULL (no doc yet)
   5. **`insertDocument(...)` → success.** Row exists in `documents`.
   6. **`insertDocumentVersion(...)` → success.** Row exists in
      `document_versions`. `(document_id, content_hash)` is now
      claimed.
   7. R2 copy tmp → canonical — OK.
   8. **`dispatchIngestion(...)` → THROWS.** E.g., the provider
      key isn't registered, or the embedding-profile dim doesn't
      match the namespace lock.
   9. The catch in `finalizeBulkJobFile()` marks
      `bulk_job_files.state = 'failed'` — but **does not** roll
      back the `documents` and `document_versions` rows.

   Result: orphan `documents` + `document_versions` rows exist.
   `bulk_job_files.document_id` and `bulk_job_files.version_id`
   are NULL because we only set them after dispatch succeeds.

2. **User submits a NEW bulk** (same files, different config —
   say they registered the missing provider key). Or they hit
   the "Retry failed" button. Either way, finalize runs again:
   1. HEAD + hash → OK.
   2. `findDocumentByTitleInNamespace` → finds the orphan doc.
   3. `getVersionByContentHash(orphan_doc.id, hash)` → finds the
      orphan version.
   4. Code branches on `on_existing`:
      - `skip_if_unchanged`: returns `state='skipped'` — no
        crash, but the file isn't actually re-ingested. From the
        user's perspective looks fine but the failure isn't
        repaired.
      - `new_version` / `replace_current`: code "falls through"
        to `insertDocumentVersion(newVerId, doc_id, hash)` —
        **collides with the UNIQUE(`document_id`, `content_hash`)
        constraint.** Crash.

The root cause is that the finalize loop assumes "existing
version row + non-skip policy" means the user wants a brand-new
version row even when the bytes are unchanged. But the schema
(correctly!) says **same bytes = same version row**. Forcing a
second row with the same content_hash is structurally wrong.

### What `new_version` / `replace_current` actually means

Re-reading the design intent:

- **`skip_if_unchanged`** (default): if a version with the same
  content_hash already exists for the same document, skip the
  ingest entirely. No new chunks, no new vectors, no new audit
  events.
- **`new_version`**: the user wants a fresh ingestion *event*,
  even if the bytes are unchanged. They're not asking for two
  rows of identical bytes — they're asking for the chunking +
  embedding pipeline to *re-run* (e.g., because the chunking
  profile or the embedding model is different from last time, and
  they want fresh vectors against the same bytes).
- **`replace_current`**: same as new_version, plus retire the
  previous current version's vectors (so retrieval no longer
  surfaces stale chunks).

Under that reading, **the natural shape is:**

- Find existing version by `(doc_id, content_hash)`.
- If found AND policy is non-skip:
  - **Reuse the existing version_id.**
  - Do not insert a second `document_versions` row.
  - Re-run the ingestion against that version with
    `force_rebuild: true` so `dispatchIngestion` rebuilds the
    `version_index` even when one already exists with
    `status='ready'`.
  - For `replace_current`, additionally TODO retire the previous
    current's vectors (out of scope for this fix — see §6).

The version table stays a one-row-per-(doc, content_hash)
invariant. The "newness" of `new_version` lives in the freshly
enqueued ingestion job, not in a duplicate row.

### Fix

Restructure `finalizeBulkJobFile`:

```
1.  HEAD R2 tmp + validate size
2.  Stream + sha256
3.  findDocumentByTitleInNamespace
4.  Branch:
    a. document exists, version with same content_hash exists:
       - if policy === 'skip_if_unchanged':
           clean tmp; mark skipped; return
       - else (new_version | replace_current):
           reuseVersion = true
           versionId    = existingVersion.id
           canonicalKey = existingVersion.source_r2_key
    b. document exists, version with same content_hash does NOT
       exist:
           reuseVersion = false
           versionId    = newId('ver')
           canonicalKey = canonicalSourceKey(...)
    c. document does not exist:
           insertDocument
           reuseVersion = false
           versionId    = newId('ver')
           canonicalKey = canonicalSourceKey(...)
5.  R2 copy tmp → canonical (idempotent overwrite — safe whether
    canonicalKey is fresh or reused)
6.  Clean tmp.
7.  if (!reuseVersion) insertDocumentVersion(versionId, ...)
8.  dispatchIngestion({
       version_id: versionId,
       force_rebuild: reuseVersion,    // existing index gets rebuilt
       ...
    })
9.  Tag ingestion_jobs.bulk_job_id.
10. Update bulk_job_files state='enqueued', document_id, version_id.
```

Two structural changes from today:

- **R2 copy moved before `insertDocumentVersion`.** Today it
  happens after; if R2 fails, version row already exists. Moving
  the copy first means a failed copy leaves no version row, so a
  retry is clean. Idempotent overwrite keeps it safe to re-run.
- **Reuse path that doesn't insert a new version row.** This is
  the actual bug fix.

### Sub-issue: the orphan rows from the first failed run

After the fix, an orphan `documents` row from a previous failed
run will be picked up by `findDocumentByTitleInNamespace` on
retry, and the `document_versions` row will be picked up by
`getVersionByContentHash`. Reuse-and-rebuild then runs against
the orphans, which is exactly what the user wants — same logical
document, finally getting embedded.

We deliberately **do not** clean up orphan rows on failure (i.e.,
no rollback in the catch). Reasons:

- Orphans are useful: the next retry uses them.
- Cross-tenant correctness is easier: nothing to roll back means
  no partial-failure inconsistencies.
- The `documents` and `document_versions` rows are tenant-scoped
  and visible via `GET /v1/namespaces/{slug}/documents` even
  before successful ingestion, so the user has visibility.

### Decision

Restructure finalize to reuse-existing-version when bytes match
and policy is non-skip. Move R2 copy ahead of version insert.
`replace_current` semantics-around-vector-retirement deferred to
a separate item (see §6).

---

## 4. Issue 3 — navigation away loses the bulk

### Root cause

Two separate sub-problems:

1. **No persistent navigation back to in-flight bulks.** The
   bulk panel only renders inline on `/ingest` when one of two
   conditions is true:
   - The user just uploaded files (state held in
     `bulkFiles: File[]`), or
   - The URL hash anchors `#bulk=<id>` and the bulk panel reads
     it on mount.
   Both die the moment the user navigates away. Even returning
   to `/ingest` doesn't restore — the URL hash is empty unless
   they have the link.

2. **`awaiting_confirm` state is the worst case.** Files have
   already been uploaded to R2 (paying the bandwidth cost), the
   bulk_jobs row is in `state='uploading'` with all per-file rows
   `state='uploaded'`, but `auto_finalize: false` (Sandbox
   default) means the server is waiting for the user's explicit
   `POST .../finalize`. If the user navigates away here, those
   uploaded bytes sit in R2 tmp until the 7-day cron sweep —
   wasted upload AND no signal to the user that they have a
   pending action.

### Fix

Three additions to the Sandbox:

1. **Bulk jobs list page** at `/ingest/bulk`.
   - Renders a paginated list (newest first) of recent bulk jobs
     for the active namespace.
   - One row per bulk job with: short bulk_job_id, state badge,
     file count, progress %, age (relative).
   - Click → resumes the bulk panel for that job at
     `/ingest#bulk=<id>`.
   - In-flight jobs (state ∈ accepted, uploading, finalizing,
     processing) sort to the top with a pulsing indicator.
2. **Nav link "Bulk jobs"** alongside the existing "View ingest
   history →" link on `/ingest`. One click to the list page.
3. **Resume mode for the bulk panel.** Today the panel renders
   only when `bulkFiles.length > 0` *or* the URL hash is set
   AND the user is on `/ingest`. Extend it so:
   - `/ingest/bulk/:id` — dedicated route. The panel renders in
     read-only-plus-actions mode: shows progress, per-file
     table, and the appropriate action button for the current
     state (Confirm if `awaiting_confirm`, Cancel if in-flight,
     Retry-failed if `partial`/`failed`).
   - `bulkFiles.length === 0` is fine — the file picker isn't
     shown in resume mode. The files are already on the server.

### What `awaiting_confirm` looks like in the resume view

The hardest case. The user uploaded but never confirmed. Resume
view shows:

```
┌─────────────────────────────────────────────────────────┐
│  Bulk job  bjk_01KR…   ▸  default   ▸  47 files         │
│                                                         │
│  Awaiting your confirmation. Files are uploaded;        │
│  ingest hasn't started yet.                             │
│                                                         │
│  [ Confirm — start ingest ]  [ Cancel ]                 │
└─────────────────────────────────────────────────────────┘
```

The user gets an unmistakable next action. If they cancel, the
existing DELETE endpoint cleans tmp R2 + marks the job cancelled.
If they confirm, the existing finalize loop runs.

### Decision

Land all three: list page, nav link, resume-from-route panel.
Localstorage persistence (so the URL hash survives a tab close)
deferred — the list page covers it.

---

## 5. Decisions reference

| Issue | Decision |
|---|---|
| 1. Copy | `Drop file(s) here, or click to browse` + `multi-select for bulk` tagline. PDF added to the type list (already accepted by the input). |
| 2. Reuse-version-on-retry | Reuse existing `document_versions` row when bytes match and policy is non-skip. Pass `force_rebuild=true` to dispatchIngestion. R2 copy reordered ahead of version insert for idempotent retries. |
| 3. Navigation | New `/ingest/bulk` list page + new `/ingest/bulk/:id` resume page. Nav link added to ingest page. Resume panel handles all non-terminal states including `awaiting_confirm`. |
| `replace_current` retirement | Out of scope for this pass. Same as `new_version` for now (re-runs the index against the existing version). Tracked as future work — see §6. |
| Orphan-row rollback on finalize failure | **Not done.** Orphans are useful for retry; rollback complicates cross-tenant correctness. The reuse-version fix makes them productive. |
| localStorage persistence | **Not done.** The list page covers the discoverability need. localStorage adds a stale-state-after-page-close failure mode without a clear win over a server-backed list. |

---

## 6. Out of scope / future work

- **`replace_current` vector retirement.** Properly retiring the
  previous `version_index`'s vectors when ingesting a new version
  with `replace_current` policy. Today and after this pass,
  `replace_current` behaves as `new_version` (rebuild against
  same version, keep old vectors searchable). Likely future PR
  pairs with the metadata-filters work.
- **Bulk job nav badge in global header.** A "3 in-flight bulk
  jobs" pill near the global nav, click to list. Not yet —
  /ingest is the natural surface for now.
- **Cancel-on-tab-close prompt.** `beforeunload` warning when
  the user has an `awaiting_confirm` bulk to confirm. Considered;
  rejected because the list page makes it easy to come back.
- **File-by-file retry from the UI.** Today the UI offers
  "Retry failed" which retries all failed files in one bulk job.
  Selecting individual files would be a UX feature, not a
  correctness fix.

---

## Related

- [`BULK_UPLOADS_DESIGN.md`](./BULK_UPLOADS_DESIGN.md) — original
  design.
- [`BULK_UPLOADS_IMPLEMENTATION.md`](./BULK_UPLOADS_IMPLEMENTATION.md) — original implementation plan.
- [`BULK_QUALITY_PASS_IMPL.md`](./BULK_QUALITY_PASS_IMPL.md) — concrete
  implementation plan for this doc.
