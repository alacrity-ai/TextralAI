# `apps/api/src/db/`

The single home for all D1 SQL in the Worker.

## The rule

**Every D1 read or write goes through a typed helper in this
directory.** Routes, middleware, and pipeline stages call the
helpers; they do not write `c.env.DB.prepare(...)` themselves.

Why: tenant scoping is enforced once per helper, not per call site.
Schema migrations touch one file per entity, not N. Mocking is one
helper, not a SQL string.

## How to add a new helper

1. Pick the entity file. If the entity is new, create
   `db/<entity>.ts`.
2. Every helper takes `db: D1Database` first and `tenant_id: string`
   second (when applicable). Helpers that intentionally don't scope
   by tenant (e.g. internal back-channel ownership lookups) are
   suffixed `*Any` (see `getJobByIdAny`).
3. Helpers return either a typed `<Entity>Row` (raw shape) or a
   contract type (mapped via `rowTo<Entity>`). Pick the latter when
   the value crosses an API boundary.
4. Add the helper to the appropriate test file under
   `apps/api/test/db-helpers.test.ts`.

## Exceptions

The CI guard (`tools/check-no-inline-d1.sh`, run by `make lint`)
allowlist:

- `src/db/**` — the helpers themselves.
- `src/ingestion/lease.ts` — the CAS lease primitive. Its SQL is
  the contract; pulling it into a helper would just rename the
  contract.

If a new exception is needed, add it to the allowlist in the script
**and** open an issue documenting why.

## Layout (current)

```
api-keys.ts          create / lookup-by-prefix / list / revoke
chunks.ts            insert-batch / hydrate-by-ids / sparse-search /
                     delete-by-version
documents.ts         get / find-by-content-hash / find/list version_index
ingestion-jobs.ts    insert / get-by-id / find-active / list-for-document /
                     latest-completed-stages
namespaces.ts        get-by-slug / list / insert / update / soft-delete
provider-keys.ts     get-by-id / get-by-label / insert / list / revoke
query-events.ts      insert / update / get-by-id / list
stage-attempts.ts    upsert / list-by-job
upload-intents.ts    insert / get-by-id / mark-consumed
version-indexes.ts   find-or-create / status update / get-by-id
```
