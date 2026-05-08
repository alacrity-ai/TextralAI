# Cron Scaffold

> **Status.** Active. Documents the cron architecture, the registry
> pattern, the addition recipe, and the inventory of identified
> stale-data scenarios.
>
> **Last reviewed:** 2026-05-08.

---

## 1. Why this exists

Several Textral tables and R2 prefixes accumulate state that nothing
cleans up on its own. Today the immediate concern is bulk-ingest
job TTL — un-finalized jobs leave behind rows in `bulk_jobs`,
rows in `bulk_job_files`, and bytes in `r2://blobs/tmp/bulk/{id}/`.
The single-file ingest path has the same shape (`upload_intents`
expires after 15 minutes; rows stay forever; R2 tmp keys never
get deleted).

Cloudflare Workers solve this with `[triggers] crons` and a
`scheduled` handler. We need:

1. **One scheduled handler** in the entrypoint. CF only invokes
   `scheduled` once per cron firing, regardless of how many cron
   patterns are registered, so multiple crons share the entrypoint.
2. **A way to dispatch** by `event.cron` to per-job runners so each
   stale-data scenario lives in its own file.
3. **A registry** that pairs each runner with its schedule + a
   short identifier, so the docs and the wrangler config and the
   logs all stay aligned.
4. **Structured telemetry** so a failing cron is visible in logs
   (and eventually metrics) without paging on every blip.

This doc is the contract for adding new crons. Implementation lives
in `apps/api/src/scheduled/`.

---

## 2. Architecture

```
              CF schedule fires (per cron pattern)
                              │
                              ▼
          apps/api/src/index.ts  →  scheduled(event, env, ctx)
                              │
                              │ ctx.waitUntil(dispatchCron(event.cron, bindings))
                              ▼
          apps/api/src/scheduled/index.ts
            ├── SCHEDULES: CronJob[]
            ├── exact-string lookup of event.cron
            ├── log "cron_started"
            ├── try { await job.run(bindings) } catch { log "cron_failed" }
            └── log "cron_completed" with duration_ms + result
                              │
                              ▼
          apps/api/src/scheduled/{name}.ts
            ├── one runner per stale-data scenario
            ├── takes Bindings, returns a JSON-serializable summary
            └── idempotent — CF can deliver the same cron firing twice
```

### Why a registry, not a switch

Three reasons:

1. **One source of truth.** The `wrangler.toml` `crons = [...]`,
   the `SCHEDULES` array, and this doc's table all key on the cron
   pattern. A registry catches drift at code-review time
   (TypeScript balks if you reference a runner without registering
   it; the dispatcher logs `cron_no_handler` for a wrangler-only
   pattern that has no code).
2. **Telemetry consistency.** Every cron gets the same structured
   log envelope with the same fields (`name`, `cron`, `duration_ms`,
   `result` / `error`). Dashboards stay simple.
3. **Self-documenting.** The doc table below is generated from
   `SCHEDULES` mentally — not literally yet, but the registry's
   one-liner descriptions are the source the doc copies.

### What the runner is responsible for

- **Idempotency.** CF retries cron deliveries on Worker errors. A
  cleanup that double-runs must be a no-op the second time. Use
  WHERE clauses that filter the rows already cleaned (most natural
  approach: filter by `state = 'expired'` only when the row hasn't
  already been transitioned).
- **Partial-failure tolerance.** Don't throw mid-run. Catch
  per-row errors, accumulate counts, return the summary. The
  dispatcher catches anything that does throw, but losing a
  half-finished sweep to one bad row is needlessly destructive.
- **Bounded work.** A nightly cron is fine for slow trickle. If
  the runner could ever process tens of thousands of rows in one
  shot (e.g., a large customer's first cleanup tick), batch the
  work — limit per-tick to a few hundred rows and rely on the next
  tick to pick up the rest. Workers `scheduled` has the same CPU
  budget as `fetch` (30s default; 5min on paid plans).
- **Observability.** Return a structured result. The dispatcher
  logs it. Future: feed into the same OTLP / cost-attribution
  surfaces as the rest of the API.

---

## 3. How to add a new cron — 4-step recipe

1. **Implement the runner** at `apps/api/src/scheduled/{name}.ts`:
   ```ts
   import type { Bindings } from '../runtime/shared/interfaces.js';

   export interface MyCronResult {
     scanned: number;
     cleaned: number;
     errors: number;
   }

   export async function runMyCron(
     env: Bindings,
     now = Date.now(),
   ): Promise<MyCronResult> {
     // Idempotent. Catch per-row errors, accumulate counts, return.
   }
   ```
   The runner takes `Bindings` (not `Env`) so it stays runtime-
   agnostic — same shape as the queue consumer in
   `runtime/cf/queue-consumer.ts`. The result is JSON-serializable
   so the dispatcher can log it.

2. **Register in the registry** at
   `apps/api/src/scheduled/index.ts`:
   ```ts
   import { runMyCron } from './my-cron.js';

   export const SCHEDULES: CronJob[] = [
     // ...existing entries...
     {
       cron: '*/15 * * * *',
       name: 'my-cron',
       description: 'One-line summary that goes in CRON_SCAFFOLD.md.',
       run: (bindings) => runMyCron(bindings),
     },
   ];
   ```

3. **Add the schedule** to both `[env.dev.triggers]` and
   `[env.prod.triggers]` in `apps/api/wrangler.toml`. Keep dev and
   prod in sync — this is how cleanup logic gets exercised against
   dev data before it hits prod.
   ```toml
   [env.prod.triggers]
   crons = [
     "0 3 * * *",       # bulk-job-expire
     "*/15 * * * *",    # my-cron
   ]
   ```

4. **Add a row to §4 of this doc** so the inventory stays current.

After deploy (`make deploy-{dev,prod}`), `wrangler` prints the
registered schedule(s). CF runs them on UTC. Test locally with
`wrangler dev` + `curl http://localhost:8787/__scheduled?cron=<pattern>`.

---

## 4. Cron inventory

| name | schedule | scope | runner | description |
|---|---|---|---|---|
| `bulk-job-expire` | `0 3 * * *` | D1 + R2 | `scheduled/bulk-job-expire.ts` | Sweep un-finalized `bulk_jobs` past their 7-day TTL; delete each job's tmp R2 keys; mark the row `expired`. |

That's the entire registry today. The next column ("Future") covers
identified-but-not-yet-implemented candidates.

---

## 5. Future crons (identified stale-data scenarios)

In rough priority order. Each row has the same shape: cause,
proposed name, proposed schedule, scope, and a one-line note on
risk/value if we don't ship it.

### High priority — production reliability or cost

| name | schedule | tables / R2 | trigger | risk if absent |
|---|---|---|---|---|
| `ingestion-job-lease-recovery` | `*/5 * * * *` | `ingestion_jobs` | `status='running' AND lease_expires_at < now()` | A Container death mid-job leaves the row locked forever. New attempts can't claim the version_index. **Production reliability hit.** |
| `upload-intent-cleanup` | `0 3 * * *` | `upload_intents` + R2 `tmp/.../{upload_id}/source.*` | `expires_at < now() - 24h AND consumed_at IS NULL` | Single-file upload abandons leak D1 rows + R2 bytes. Same shape as bulk-job-expire; mirrors that runner. **Slow cost leak.** |

### Medium priority — retention / hygiene

| name | schedule | tables / R2 | trigger | risk if absent |
|---|---|---|---|---|
| `bulk-job-retention` | `0 4 * * 0` (weekly) | `bulk_jobs` (terminal states older than 90d) | `state IN ('complete','partial','failed','cancelled') AND completed_at < now() - 90d` | Audit table grows without bound. Per-tenant scan cost rises slowly. |
| `dlq-job-retention` | `0 4 * * 0` | `ingestion_jobs` (`dead_lettered=1` older than 30d) | `dead_lettered = 1 AND created_at < now() - 30d` | DLQ fills with old failures the operator never triaged. |

### Low priority — explicitly opted out today

| name | schedule | tables | trigger | why deferred |
|---|---|---|---|---|
| `email-verification-cleanup` | (not scheduled) | `email_verifications` | `expires_at < now() AND consumed_at IS NULL` | The 0013 schema explicitly notes "no background cleanup task" — the unique partial index on `(email, purpose) WHERE consumed_at IS NULL` keeps lookups fast even with accumulated expired rows. Revisit only if a tenant ever crosses a watermark. |

### Out of scope — would need a new design

| concern | why not a cron |
|---|---|
| Orphan vectors in Vectorize / Pinecone | Detecting orphans requires a full namespace scan against the D1 chunk inventory; expensive. Better fix: enforce delete-on-cascade through the existing routes when a `document_versions` row is removed. |
| Stale `query_events` retention | Audit-only retention policy. Not yet defined in the design. Cron can't be specified until the policy is. |
| `usage_records` rollup compaction | A different shape of background task — daily aggregation, not stale-data cleanup. May warrant its own scaffold (`docs/development/aggregation/`) when it lands. |

---

## 6. Operational notes

### Testing locally

`wrangler dev` exposes a debug endpoint at
`http://localhost:8787/__scheduled` that fires the `scheduled`
handler with a synthetic event. Pass the cron pattern as a query
param to dispatch the matching job:

```bash
curl 'http://localhost:8787/__scheduled?cron=0+3+*+*+*'
```

The runner runs against your local dev bindings (D1 dev, R2 dev,
etc.). Iterate freely.

### Manual invocation against deployed env

CF doesn't expose `__scheduled` on deployed Workers. To test a cron
runner against a real env without waiting for the schedule, the
options are:

1. **Local + remote bindings.** `wrangler dev --remote` + the
   `__scheduled` curl above runs the local handler against remote
   D1/R2/queue. Quick.
2. **Promote a temporary route.** Mount a one-time admin endpoint
   gated by `X-Admin-Bootstrap-Token` that calls `dispatchCron`
   directly. Pull the route after testing.

### Observability

Every cron firing emits three structured log lines:

```json
{ "event": "cron_started",   "name": "bulk-job-expire", "cron": "0 3 * * *" }
{ "event": "cron_completed", "name": "bulk-job-expire", "cron": "0 3 * * *",
  "duration_ms": 1247,
  "result": { "scanned": 42, "expired": 41, "errors": 1 } }
```

Or on failure:

```json
{ "event": "cron_failed", "name": "bulk-job-expire", "cron": "0 3 * * *",
  "duration_ms": 124, "error": "BlobStore.delete timeout" }
```

These are deliberately searchable: pin alerts on
`event="cron_failed"`, dashboard panels on `result.errors > 0`.

### Idempotency invariant

Every runner must satisfy: if the same logical job runs N times in
a row, the post-state of run #2 onwards equals the post-state of
run #1. Concretely: filter on the post-cleanup state in the WHERE
clause, not on a "cleanup pending" flag.

`bulk-job-expire` does this naturally — it filters
`state IN ('accepted','uploading')` and transitions to `'expired'`,
so a re-run finds nothing to do.

### When the registry and wrangler.toml diverge

If `wrangler.toml` has a cron pattern that isn't in `SCHEDULES`,
the dispatcher logs `cron_no_handler` and returns. Cheap. Catches a
PR that registered the schedule but forgot the runner.

If `SCHEDULES` has a runner whose cron pattern isn't in
`wrangler.toml`, CF never delivers the firing — the runner is dead
code. The release process catches this on review (the table in §4
of this doc must match).

---

## 7. Conventions reference

- **Cron patterns** are 5-field POSIX (no seconds field): `m h dom mon dow`.
  CF docs:
  https://developers.cloudflare.com/workers/configuration/cron-triggers/
- **All times UTC.** CF runs crons in UTC; treat the Worker as UTC
  by default and convert at display layer if needed.
- **Stable `name` field.** It's the log search key. Renaming a
  runner means a coordinated dashboard / alert update — avoid.
- **One-tick batching.** If a runner could exceed 30s of CPU, cap
  at 100–500 rows per tick and let the next tick pick up the rest.
- **Bindings, not Env.** Runners take `Bindings` so they stay
  runtime-agnostic. The dispatcher already builds bindings from
  the CF Env; runners shouldn't re-fork by runtime.

---

## 8. Open questions

1. **Should we add `cron-locks`?** CF cron is at-least-once — two
   simultaneous fires could theoretically race. Today none of our
   runners have a problem with this (they're all idempotent against
   the row state). If a future runner needs strict
   single-flight, add a `cron_locks(name, locked_at, locked_until)`
   table with a CAS pattern.
2. **Per-tenant cleanup vs global.** Today every cron is global.
   When the first tenant exceeds the 30s budget on a global sweep,
   shard by `tenant_id MOD N` over a tighter schedule.
3. **Cost-attributed cron telemetry.** Once `COST_ATTRIBUTION.md`
   lands, cron CPU + read units should appear in the same rollup as
   query/ingest. For now, log durations only.

---

> **Owner:** the codebase. This doc is updated as part of the same
> PR that adds a new cron — see §3 step 4.
