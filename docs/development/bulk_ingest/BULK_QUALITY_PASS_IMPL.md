# Bulk Ingest — Quality Pass (Implementation)

> Companion to
> [`BULK_QUALITY_PASS_FIXES.md`](./BULK_QUALITY_PASS_FIXES.md). Lists
> the file-by-file changes needed, ordering, and verification.

---

## 1. Server fixes

### 1.1 `apps/api/src/ingestion/bulk-finalize.ts`

Restructure `doFinalize`:

```
[ unchanged: HEAD + hash + lookup-by-title + lookup-by-hash ]

let reuseVersion: boolean;
let versionId: string;
let canonicalKey: string;
let documentId: string;
let isNewDocument = false;

if (document) {
  documentId = document.id;
  if (existingVersion) {
    if (policy === 'skip_if_unchanged') {
      [ unchanged: clean tmp, mark skipped, return ]
    }
    // new_version | replace_current — reuse the version
    reuseVersion = true;
    versionId    = existingVersion.id;
    canonicalKey = existingVersion.source_r2_key;
  } else {
    reuseVersion = false;
    versionId    = newId('ver');
    canonicalKey = canonicalSourceKey(tenantId, namespaceId, documentId, versionId, ext);
  }
} else {
  documentId   = newId('doc');
  isNewDocument = true;
  // INSERT happens after the R2 copy succeeds (defer DB writes)
  reuseVersion = false;
  versionId    = newId('ver');
  canonicalKey = canonicalSourceKey(tenantId, namespaceId, documentId, versionId, ext);
}

// 1. R2 copy tmp → canonical (idempotent — overwrites if reusing)
const re = await env.blobs.get(tmpKey);
if (!re) throw ...;
await env.blobs.put(canonicalKey, re.body, { contentType: fileRow.content_type });

// 2. DB writes — only now that R2 is durable
if (isNewDocument) {
  await insertDocument(env.db, tenantId, {
    id: documentId,
    namespace_id: namespaceId,
    title: fileRow.filename,
    doc_type: config.doc_type ?? null,
    metadata: null,
  });
}
if (!reuseVersion) {
  await insertDocumentVersion(env.db, tenantId, {
    id: versionId,
    document_id: documentId,
    content_hash: contentHash,
    source_r2_key: canonicalKey,
    content_type: fileRow.content_type,
    size_bytes: fileRow.size_bytes,
  });
}

await safeDelete(env, tmpKey);

// 3. Enqueue with force_rebuild when reusing the version
const dispatchResult = await dispatchIngestion(env, tenantId, documentId, {
  version_id: versionId,
  doc_type: config.doc_type,
  embedding: config.embedding,
  chunking: config.chunking,
  enrichment: config.enrichment,
  indexing: config.indexing,
  mode: config.mode,
  force_rebuild: reuseVersion,
});

[ unchanged: tag bulk_job_id, update bulk_job_files row ]
```

The structural moves:
- R2 copy now happens before `insertDocument` and
  `insertDocumentVersion`. If the R2 PUT fails, no DB rows were
  created, so a retry runs cleanly.
- `insertDocument` is gated on `isNewDocument` (skipped when we
  found an orphan from a previous failed run).
- `insertDocumentVersion` is gated on `!reuseVersion` (skipped
  when bytes match an existing version).
- `force_rebuild: reuseVersion` is the signal to
  `dispatchIngestion` that the existing `version_index` (if any)
  should be rebuilt, not 409'd.

### 1.2 No new error codes, no contract changes

The fix doesn't add a new error code or change any wire format.
The 12 existing `BULK_*` codes still apply.

### 1.3 No migration

No schema change. The fix is purely in the finalize logic.

### 1.4 Test additions

Two new unit tests in `apps/api/test/bulk-finalize.test.ts` (or a
new file):

1. **Retry after partial failure.** Pre-create a `documents`
   row + `document_versions` row + the canonical R2 object for a
   given filename + content_hash (mirrors the orphan state from a
   failed first attempt). Run finalize with `policy='new_version'`.
   Assert: no INSERT crashes; `dispatchIngestion` invoked with
   `force_rebuild: true`; `bulk_job_files.state='enqueued'`.
2. **Skip-if-unchanged still skips.** Same setup as above, but
   `policy='skip_if_unchanged'`. Assert: `bulk_job_files.state=
   'skipped'`, `dispatchIngestion` NOT called.

---

## 2. Sandbox UX

### 2.1 Drop-zone copy (`apps/sandbox/src/pages/Ingest.tsx`)

Single inline-text edit. Find the empty-state block in the drop
zone (~line 293):

```tsx
<div>Drop a file here, or click to browse</div>
<div>markdown · plaintext · &lt; 25 MB</div>
```

Replace with:

```tsx
<div>Drop file(s) here, or click to browse</div>
<div>markdown · plaintext · pdf · &lt; 25 MB each · multi-select for bulk</div>
```

### 2.2 Bulk jobs list page (new — `apps/sandbox/src/pages/BulkJobs.tsx`)

New file. Layout:

```
┌─ Page ─────────────────────────────────────────────────┐
│ Bulk jobs                                              │
│ Multi-file ingest history for this namespace.          │
│                                                        │
│ ┌──────────────────────────────────────────────────┐   │
│ │ bjk_01KR…  ⏳ uploading      47 files   2 min ago│   │
│ │ bjk_01KR…  ✓  complete       12 files  1 hour ago│   │
│ │ bjk_01KR…  ✗  failed (1)      3 files   2d ago   │   │
│ └──────────────────────────────────────────────────┘   │
│                  [ load more ]                         │
└────────────────────────────────────────────────────────┘
```

Implementation:
- `useEffect` fetches `GET /v1/ingest/bulk?namespace=<slug>`.
- Renders a list of rows. Click → `navigate('/ingest/bulk/' + id)`.
- In-flight (state ∈ accepted, uploading, finalizing, processing)
  rows pulse via the existing `colors.primaryMuted` background.
- Pagination via `next_cursor`; the existing API supports it.
- Polls every 3 seconds while there's at least one in-flight job
  visible, otherwise no polling. Cleared on unmount.

### 2.3 Bulk job detail / resume page (new — `apps/sandbox/src/pages/BulkJobDetail.tsx`)

Route: `/ingest/bulk/:id`.

Implementation: a thin wrapper around a refactored
`BulkIngestPanel` that supports `mode: 'resume' | 'fresh'`.

In resume mode:
- Skip the configuring phase entirely.
- Read `bulk_job_id` from `useParams()`.
- Initial GET on `/v1/ingest/bulk/:id` to populate `status`
  + `perFile`.
- Determine display state from `status.state`:

```
state                action button
─────────────────    ──────────────
accepted             "Resume upload from /ingest" (link, since
                     we don't have File objects in this route)
uploading            same as above (uploads still pending)
                     OR if files_uploaded === total_files AND
                     auto_finalize === false:
                       "Confirm — start ingest"  +  "Cancel"
finalizing           "Cancel"
processing           "Cancel"
complete             "Done"
partial              "Retry failed"  +  "Done"
failed               "Retry failed"  +  "Done"
cancelled            "Done"
expired              "Done"
```

The "Resume upload from /ingest" link covers the rare case where
a user closed the tab before all PUTs completed. The remaining
PUTs need the `File` objects, which the server doesn't have. The
list page links them back to `/ingest` to re-pick the files; the
existing `client_request_id` job-level idempotency means
re-submitting the same manifest within 24h returns the same
bulk_job_id and only re-PUTs the files still in `pending`.

### 2.4 BulkIngestPanel refactor

Convert `BulkIngestPanel` to support both modes:

```tsx
interface Props {
  // Fresh-upload mode
  files?: File[];
  onClear?: () => void;
  // Resume mode
  resumeBulkJobId?: string;
  // Common
  namespaceSlug: string;
  namespaceDimensions: number;
}
```

- If `resumeBulkJobId` is set → enter polling mode immediately,
  skip configuring phase, no file table from `files`.
- The component initializes `bulkJobId` from
  `resumeBulkJobId ?? null`, sets `phase = 'polling'`, and lets
  the existing polling effect take over.
- The file table component (`BulkFileTable`) needs to handle the
  case where `files: File[]` is empty — it just renders the
  per-file rows from `perFile` instead of zipping with `File[]`.

### 2.5 Nav link

Add to `apps/sandbox/src/pages/Ingest.tsx`, next to the existing
"View ingest history →" link:

```tsx
<Link to="/ingest/bulk">View bulk jobs →</Link>
```

Same styling, same column.

### 2.6 Router wiring (`apps/sandbox/src/App.tsx`)

Add two routes:

```tsx
<Route path="/ingest/bulk"      element={<BulkJobs />} />
<Route path="/ingest/bulk/:id"  element={<BulkJobDetail />} />
```

The order matters: the `/:id` route must come after `/ingest/bulk`
to avoid matching `bulk` as an `:id`.

---

## 3. File-touch summary

| Action | File |
|---|---|
| Edit | `apps/api/src/ingestion/bulk-finalize.ts` (restructure as §1.1) |
| Edit | `apps/sandbox/src/pages/Ingest.tsx` (copy fix §2.1, nav link §2.5) |
| Add  | `apps/sandbox/src/pages/BulkJobs.tsx` (list page §2.2) |
| Add  | `apps/sandbox/src/pages/BulkJobDetail.tsx` (resume page §2.3) |
| Edit | `apps/sandbox/src/components/bulk/BulkIngestPanel.tsx` (resume-mode §2.4) |
| Edit | `apps/sandbox/src/App.tsx` (router §2.6) |
| Edit | `docs/development/bulk_ingest/BULK_UPLOADS_DESIGN.md` (link from §10 open question — `replace_current` retirement) |

---

## 4. Sequence

1. Server fix first (§1) — no client depends on it being shipped
   first, but it unblocks issue 2 immediately on prod.
2. Sandbox edits all batched in one commit:
   - Refactor `BulkIngestPanel` to support resume mode.
   - Add `BulkJobs` + `BulkJobDetail` pages.
   - Wire routes.
   - Edit `Ingest.tsx` copy + nav link.
3. Build + typecheck both packages.
4. Deploy API to dev + prod (Worker `make deploy-{dev,prod}`).
5. Build + deploy sandbox to dev + prod Pages projects.
6. Smoke-test on prod: upload bulk, navigate away, return via
   `/ingest/bulk`, click into the in-flight job.

---

## 5. Test plan (post-deploy smoke)

Against prod sandbox + prod API:

1. **Copy fix.** Open `/ingest`, drop two markdown files into the
   drop zone. Verify the new label reads "Drop file(s) here..."
   before the panel switches to bulk mode. Drop the files,
   bulk panel renders.
2. **Reuse-version retry.** Upload a single file via single-file
   flow with a deliberately-bad provider key (or leverage the
   real one and re-run) — actually for this we just want the
   second-attempt path. Re-upload the same file in a bulk with
   `new_version`. Assert: no `BULK_FILE_FINALIZE_FAILED`. Final
   state: `complete`.
3. **Navigation.** Start a bulk in `awaiting_confirm` state.
   Navigate to `/query`. Then navigate to `/ingest/bulk`. Click
   the in-flight row. Confirm the resume page shows
   "Confirm — start ingest". Click confirm. Assert: ingest
   completes successfully.
4. **Existing flow regression.** Upload a single file via the
   single-file path. Confirm it still works end-to-end (the copy
   change shouldn't affect logic).

---

## 6. Rollback

The server fix is purely behavioral — no schema change, no
contract change. Rollback is `git revert` + `make deploy-prod`.
No data migration required.

The sandbox change adds two new routes and a refactored
component. Rollback is `git revert` + the existing sandbox-deploy
workflow. The new D1 / R2 state created via the new routes is
all driven through the existing API, so a sandbox rollback
doesn't strand any state.

---

## 7. Done when

- [ ] Bulk finalize retry no longer crashes on UNIQUE constraint
      violations.
- [ ] Drop zone reads "Drop file(s) here, or click to browse"
      with the updated tagline.
- [ ] `/ingest/bulk` lists recent bulk jobs in the active
      namespace; in-flight jobs sort to the top and pulse.
- [ ] Clicking an in-flight job lands on `/ingest/bulk/:id`,
      which renders the appropriate action button for the job's
      state.
- [ ] An `awaiting_confirm` bulk is recoverable end-to-end via
      the list page → detail page → confirm.
- [ ] All existing API and MCP tests still pass.
- [ ] Both deployments (API + sandbox) live on dev and prod.
