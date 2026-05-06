# Fix Plan 06 — R2 half-state cleanup

> Resolves audit finding §6: `presignPut`/`presignGet` return a
> sentinel `https://r2.local/...` URL because `R2Bucket.createPresignedUrl`
> isn't an actual API. Every consumer call site has a branch for
> "if it looks like a sentinel, rewrite to the Worker proxy." The
> sentinel branch is dead code in every deployment we have.

## Goal

Pick one path and stick with it. Per the audit, **option 2: commit
to the Worker-proxy as the only path**, dropping the presigned-URL
abstraction. Bandwidth-sensitive deploys can revisit later by
provisioning R2 access keys; doing so will be a focused additive
change rather than reviving dead code.

## Files

**Edit:**
- `apps/api/src/lib/r2-presign.ts` → rename to
  `apps/api/src/lib/r2-uploads.ts`. Drop `presignPut` /
  `presignGet`. Keep `uploadKey`, `canonicalSourceKey`,
  `extFromContentType`, `sha256OfStream`. Add a small helper that
  builds the Worker-proxy URL from a request `URL` (the existing
  `documents.ts` inlines this).
- `apps/api/src/routes/documents.ts` — drop the `isProxyFallback`
  branch; always use the Worker-proxy URL.
- `apps/api/src/routes/internal/ingest-write.ts` — drop the
  `presignGet` import + `r2/upload-url` route (it's already
  superseded by `r2/object`; the upload-url variant just returned
  the sentinel).

**Edit (Container):**
- `apps/ingest/app/clients/worker.py` — already only uses
  `post_bytes` for fetch; nothing to change here, but add a header
  comment noting the contract is "Worker proxies all R2 reads."
- `apps/ingest/app/stages/fetch.py` — already migrated in Phase 3+4;
  just confirm.

**Update:**
- `docs/development/PHASE_3_4_IMPLEMENTATION.md` Appendix C.1 — add
  a follow-up note: "Phase 5 cleanup committed to the proxy path;
  the URL-based fallback was deleted."
- `docs/1-DESIGN.md` §5.2 — same one-liner.

## What's NOT in scope

- Provisioning R2 S3-compatible access keys. Future work; the
  abstraction can come back if/when that lands.
- Multipart uploads. Still deferred to Phase 8.

## Tests

- Existing `documents-route.test.ts` cases that asserted the URL
  shape may need a one-line update if they checked for the sentinel.
- New `apps/api/test/r2-uploads.test.ts` covering `uploadKey`,
  `canonicalSourceKey`, `sha256OfStream` — these survived the
  refactor.
- Live e2es continue to exercise the proxy path; no change there.

## Acceptance

- `pnpm --filter @textral/api typecheck` clean.
- `pnpm --filter @textral/api test` green.
- Both live e2es green.
- `grep -rE 'r2\.local|presignPut|presignGet|isProxyFallback' apps/api/src/` returns zero hits.
- `grep -rE 'r2/upload-url' apps/api/src/` returns zero hits (route
  deleted; the Container only uses `r2/object`).

## Sequencing

Independent of the other refactors; safe to do anytime. Best done
after §3 (D1 helpers) since the documents route has SQL inline that
benefits from the helper-pass first.
