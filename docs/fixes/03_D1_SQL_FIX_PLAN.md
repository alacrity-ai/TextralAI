# Fix Plan 03 — D1 SQL into `db/` helpers

> Resolves audit finding §3: 90 `c.env.DB`/`env.DB` references; 11
> raw SQL strings inside `routes/internal/ingest-write.ts` alone.
> The `apps/api/src/db/` directory has helpers but new code keeps
> bypassing them. Cross-tenant leak risk: tenant-scoping is enforced
> by hand at every call site.

## Goal

Every D1 read/write goes through a typed helper in
`apps/api/src/db/<entity>.ts`. Routes contain zero raw SQL strings.
A grep-based CI guard fails the build if `c.env.DB.prepare` shows up
outside `src/db/`.

## Inventory: top offenders today

```
src/routes/internal/ingest-write.ts   11 raw SQL strings
src/routes/documents.ts                8
src/routes/provider-keys.ts            6
src/routes/query.ts                    5
src/ingestion/dispatch.ts              5
src/audit/query-events.ts              3
src/auth/provider-keys.ts              2
src/routes/admin/bootstrap.ts          3
src/routes/api-keys.ts                 3
src/ingestion/lease.ts                 4   (acceptable: lease primitives)
```

## Files

**New:**
- `apps/api/src/db/chunks.ts` — insert batch, list by version, delete
  by filter, FTS5 search helper, update embedding status.
- `apps/api/src/db/ingestion-jobs.ts` — insert, get-by-id, list-by-
  document, find-active-for-version-index, transition-update,
  enrichment-status update.
- `apps/api/src/db/version-indexes.ts` — find-or-create, status
  update, get-by-id.
- `apps/api/src/db/upload-intents.ts` — insert, get-by-id, mark-consumed.
- `apps/api/src/db/query-events.ts` — already partly in
  `audit/query-events.ts`; consolidate the SQL there.
- `apps/api/src/db/provider-keys.ts` — get-by-id, get-by-label, list,
  insert, revoke.
- `apps/api/src/db/api-keys.ts` — extract from `routes/api-keys.ts`.
- `apps/api/src/db/stage-attempts.ts` — insert/upsert, list-by-job.
- `apps/api/src/db/README.md` — "all D1 SQL goes here, no exceptions"
  policy doc.

**Edit:**
- Every file in the inventory above. Each function call replaces an
  inline `.prepare(...)` invocation.

**Add to CI guard:**
- `tools/check-no-inline-d1.sh` — grep-based; fails if the regex
  `c\.env\.DB\.prepare|env\.DB\.prepare` finds a hit outside
  `src/db/`, `src/ingestion/lease.ts` (lease primitives are
  intentionally inline), and `src/routes/internal/ingest-write.ts`'s
  ownership-check helper (which uses `loadJobOrThrow` — that's
  already a helper, so should be fine).
- Hook into `make lint`.

## Tenant-scoping policy

Every helper takes `tenant_id` as a non-optional first argument
*after* `db: D1Database`. Examples:

```ts
export async function getChunkById(
  db: D1Database,
  tenant_id: string,
  chunk_id: string,
): Promise<ChunkRow | null>;

export async function insertChunksBatch(
  db: D1Database,
  tenant_id: string,
  rows: ChunkInsert[],
): Promise<{ inserted: number }>;
```

This is an existing pattern in `db/namespaces.ts` and `db/jobs.ts`;
extend it everywhere.

## What's NOT in scope

- Migrating to a query builder (Drizzle, Kysely). Phase 7 candidate.
- Renaming columns or indexes. Schema stays as-is.
- Migrating `src/ingestion/lease.ts` away from inline SQL — it's the
  CAS primitive; arguably belongs as-is.

## Tests

- Existing tests cover the route-level behavior; helper changes
  don't change observable behavior.
- New `apps/api/test/db-helpers.test.ts` with one round-trip per
  helper to catch typo-class bugs.
- Add a grep guard test that fails if any new inline SQL slips in.

## Acceptance

- `pnpm --filter @textral/api typecheck` clean.
- `pnpm --filter @textral/api test` green.
- Both live e2es green.
- `grep -rEcn 'env\.DB\.prepare' apps/api/src | grep -v ':0$'` shows
  hits only in `src/db/`, `src/ingestion/lease.ts`, and the existing
  `loadJobOrThrow` (or its replacement).
- `make lint` runs the new grep guard and passes.

## Sequencing

This is a prereq for §5 (query.ts pipeline split): the query stages
are much smaller when they call typed helpers vs build SQL inline.
Do this first.

The §2 (provider-key consolidation) fix benefits from it too: the
new resolver reaches `db/provider-keys.ts` instead of inline SQL.
