# Cost Reconciliation Runbook

Phase 8.6. Document for confirming `query_events.total_cost_usd_micros`
matches AI Gateway and the upstream provider's billing dashboard.

## Why

Customers don't trust opaque billing. The MVP records every billable
signal in `query_events` (synthesis tokens, embedding tokens) and
`usage_records` (daily rollup). Reconciliation pins those numbers to
the upstream's truth.

## When to run

- Once per release tag (sign-off prerequisite).
- After any change to `recordQueryUsage` / `recordIngestionUsage`.
- On any tenant report of "my bill is wrong."

## Inputs

For a given (tenant, day):

1. `query_events` totals — pull via `wrangler d1 execute`:
   ```sh
   wrangler d1 execute textral-dev --command \
     "SELECT SUM(total_cost_usd_micros) AS micros
        FROM query_events
       WHERE tenant_id = '<tenant>'
         AND created_at >= <day_start_ms>
         AND created_at <  <day_start_ms + 86_400_000>"
   ```
2. AI Gateway dashboard total — Cloudflare → AI Gateway → filter by
   `cf-aig-metadata.tenant_id == <tenant>` for the day.
3. Provider dashboard — for OpenAI: <https://platform.openai.com/usage>
   filtered to the API key associated with that tenant. (Tenants using
   their own BYOK manage this themselves.)

## Run the script

```sh
tsx tools/billing/reconcile.ts \
  --tenant ten_xxx \
  --date 2026-05-03 \
  --aig-total 1.234 \
  --provider-total 1.231
```

## Expected divergences (acceptable)

- < $0.01: tax precision, Cloudflare AIG rounding.
- Tax differences are excluded; we don't track tenant-specific tax in
  `usage_records`.
- Refunds / credits: out of scope.

## Failure cases (block sign-off)

- > $0.01 between any two of the three numbers without an explanation.
- Persistent monotonic drift over 7 days (suggests a counting bug).

## Day-1 baseline

| Date | Tenant | query_events ($) | AIG ($) | Provider ($) | Δ max | Notes |
|------|--------|------------------|---------|--------------|-------|-------|
| TBD  | TBD    | TBD              | TBD     | TBD          | TBD   | initial |

(Add a row each time reconcile runs.)

## 90-day prune query

`usage_records` accumulates indefinitely. Prune monthly via:

```sh
wrangler d1 execute textral-dev --command \
  "DELETE FROM usage_records
    WHERE period_start < $(($(date -u +%s) * 1000 - 90 * 86400000))"
```

A scheduled CF cron is post-MVP.
