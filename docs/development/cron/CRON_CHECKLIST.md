# Cron Checklist

> **Purpose.** Single-glance status of every cron we've identified,
> grouped by priority. Update on every PR that adds, removes, or
> changes a runner.
>
> **Architecture + how-to-add:** see
> [`CRON_SCAFFOLD.md`](./CRON_SCAFFOLD.md).
>
> **Last reviewed:** 2026-05-08.

---

## Live (deployed and running)

These are the crons CF is actively firing on `textral-api` (prod)
and `textral-api-dev` (dev). Update after every deploy that
touches the schedule.

- [x] **`bulk-job-expire`** — daily `0 3 * * *`
  - Source: [`scheduled/bulk-job-expire.ts`](../../../apps/api/src/scheduled/bulk-job-expire.ts)
  - Sweep un-finalized `bulk_jobs` past their 7-day TTL; delete
    each job's tmp R2 keys (`tmp/bulk/{id}/*`); mark the row
    `expired`.
  - Shipped: 2026-05-08, prod version `23afc1c2`.
- [x] **`ingestion-job-lease-recovery`** — every 5 min `*/5 * * * *`
  - Source: [`scheduled/ingestion-job-lease-recovery.ts`](../../../apps/api/src/scheduled/ingestion-job-lease-recovery.ts)
  - Recover `ingestion_jobs` whose lease expired without the
    Container writing terminal state. Increments `attempt_count`;
    below 3 auto-retries, resets lease fields and re-publishes the
    queue message; at 3, dead-letters with
    `INGEST_LEASE_RECOVERY_EXHAUSTED` for operator triage.
  - Shipped: 2026-05-08, prod version `73c8e6f9`.

---

## Next up — high priority

Stale-data scenarios with concrete cost or reliability impact. PR
order is the recommended sequencing; each can ship independently.

- [ ] **`upload-intent-cleanup`** — daily, mirrors
  `bulk-job-expire`'s shape against the single-file path.
  - Trigger: `upload_intents` rows with `expires_at < now() - 24h
    AND consumed_at IS NULL`. Each row's `upload_r2_key` (under
    `tmp/.../{upload_id}/source.*`) leaks bytes the same way bulk
    does.
  - Effort: ~1 day. Reuses the row-iteration + R2-delete pattern
    from `bulk-job-expire`.
  - Risk if absent: slow cost leak. R2 storage and D1 row count
    grow proportionally to abandoned single-file uploads. Mostly
    bites at scale.
  - Implementation notes: 24h grace (vs upload-intent's 15-min
    TTL) gives the user time to retry a failed upload before the
    cleanup runs.

---

## Medium priority — retention / hygiene

These are the "growing without bound" concerns. Not urgent —
we're nowhere near a watermark today — but the schedule is the
right place to handle them when they matter.

- [ ] **`bulk-job-retention`** — weekly `0 4 * * 0`
  - Trigger: `bulk_jobs` rows with `state IN ('complete','partial','failed','cancelled')
    AND completed_at < now() - 90d`.
  - Why deferred: audit value > storage cost for the foreseeable
    future.
  - Pairs with: a future `bulk_jobs.archived` flag if we ever want
    to keep the row but not the per-file detail.
- [ ] **`dlq-job-retention`** — weekly `0 4 * * 0`
  - Trigger: `ingestion_jobs` with `dead_lettered=1 AND created_at
    < now() - 30d`.
  - Why deferred: ops-team triage cadence is the bottleneck, not
    storage.
  - Note: when `INGEST_LEASE_RECOVERY_EXHAUSTED` becomes a common
    cause of DLQ entries, revisit — that's the canary for a
    flaky Container that needs root-causing.

---

## Low priority — explicit opt-out today

Documented for completeness. **Do not implement** unless the
underlying reasoning changes.

- [ ] **`email-verification-cleanup`** — n/a
  - The `0013_email_verifications.sql` migration explicitly
    notes "no background cleanup task" by design — the partial
    unique index on `(email, purpose) WHERE consumed_at IS NULL`
    keeps the active-token lookup fast even with accumulated
    expired rows.
  - Revisit only if a tenant ever crosses a watermark (millions
    of rows). Until then, accumulating expired tokens is cheaper
    than the cron + the cron's own consistency-bug surface.

---

## Out of scope — would need a new design

These are real concerns but the cron pattern isn't the right tool.
Listed so we don't accidentally implement them as crons in a
moment of zeal.

- **Orphan vectors in Vectorize / Pinecone.** Detecting orphans
  requires a full namespace scan against the D1 chunk inventory
  and per-chunk index lookups — minutes-long even on small
  namespaces. Better fix: enforce delete-on-cascade through the
  existing routes when a `document_versions` row is removed
  (so vectors are deleted at the moment of intent, not on a
  janitor schedule).
- **`query_events` retention.** Audit-only retention policy is
  TBD. Cron can't be specified until the policy is. When the
  policy lands, this becomes a candidate.
- **`usage_records` rollup compaction.** Different shape: daily
  aggregation, not stale-data cleanup. May warrant its own
  scaffold (`docs/development/aggregation/`) when it lands;
  shouldn't share `scheduled/` directory naming with cleanup
  crons.

---

## How to update this doc

When you add a new cron:

1. The runner ships in `apps/api/src/scheduled/{name}.ts`.
2. The registration goes in `apps/api/src/scheduled/index.ts`.
3. The schedule goes in both `[env.dev.triggers]` and
   `[env.prod.triggers]` in `apps/api/wrangler.toml`.
4. **Move its row from "Next up" or "Medium priority" up to
   "Live" in this doc**, with the deploy version ID.
5. Add a row in [`CRON_SCAFFOLD.md`](./CRON_SCAFFOLD.md) §4 (the
   inventory table — terser, scaffold-doc style).
6. If you added an error code, document it in
   `apps/api/src/openapi/error-catalog.ts` so Scalar `/docs` and
   the MCP `textral://error-catalog` resource pick it up.

When you retire a cron:

1. Remove from `wrangler.toml`, `SCHEDULES`, and the runner file.
2. Move the entry in this doc to a new "## Retired" section
   (don't delete — keep the audit trail of why we had it).

---

## Related

- [`CRON_SCAFFOLD.md`](./CRON_SCAFFOLD.md) — architecture, dispatcher, recipe.
- [`docs/development/bulk_ingest/BULK_UPLOADS_DESIGN.md`](../bulk_ingest/BULK_UPLOADS_DESIGN.md) — origin of the first two crons.
- `apps/api/src/scheduled/` — runner source.
- `apps/api/wrangler.toml` `[env.{dev,prod}.triggers]` — schedule
  registration.
