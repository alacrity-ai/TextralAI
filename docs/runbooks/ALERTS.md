# Alerts Runbook

Phase 6.6 deliverable. The four MVP alerts from `1-DESIGN.md` §15.3 plus
notification routing and "manual fire" recipes.

## MVP alert set

| ID | Trigger | Window | Severity | Action |
|----|---------|--------|----------|--------|
| `provider_fatal_error_rate` | `provider_calls` AE rows where `outcome='fatal_error'` exceed 1% of total in 5 min, per provider | 5 min | P1 | Investigate provider-side issue (key, quota, schema). |
| `query_cannot_answer_rate` | `query_executions` AE rows where `degradation_level='cannot_answer'` exceed 5% in 5 min, per tenant | 5 min | P2 | Triage: was upstream down, or did a tenant ingest the wrong corpus? |
| `dlq_depth_nonzero` | Any `ingestion_jobs.dead_lettered=1` row not yet retried | continuous | P2 | Inspect via `GET /v1/admin/ingestion-jobs?dead_lettered=1`; retry post-fix. |
| `embedding_profile_mismatch_rate` | `EMBEDDING_PROFILE_MISMATCH` 4xx errors > 0.1% of `/v1/query` traffic | 15 min | P3 | Tenant config drift; reach out + correct namespace `default_embedding_profile`. |

## Notification routing

For MVP, point all four alerts at a single Slack channel
(`#textral-alerts`). The runbook author's email address goes on every
alert as a fallback if Slack delivery fails.

PagerDuty wiring is post-MVP; document the recommended escalation:

- P1 → page primary on-call.
- P2 → Slack-only with @here.
- P3 → Slack-only without @-mention.

## Wiring an alert in Cloudflare

The four MVP alerts are configured by hand in the Cloudflare dashboard
because:

1. The Workers Analytics Engine SQL surface isn't yet exposed via API,
   only via the dashboard.
2. The number of alerts is small enough that Pulumi/Terraform isn't
   warranted (less than 30 lines of click-ops).

For each alert:

1. **Cloudflare → Notifications → Add → Workers — Custom Analytics Alert.**
2. **Dataset:** `AE_METRICS` (or whatever binding name the prod
   environment uses).
3. **SQL filter:** see "SQL recipes" below.
4. **Threshold:** rate ≥ X% over Y minutes.
5. **Destination:** the Slack webhook URL stored in the
   `SLACK_ALERTS_WEBHOOK` Worker secret.

### SQL recipes

The dataset rows are written by `apps/api/src/observability/metrics.ts`:

- `query_executions` — `blobs[0]='query_executions'`, `blobs[3]` is the
  degradation level, `blobs[4]` is the synthesis_status, `indexes[0]`
  is the tenant_id.
- `ingestion_stage_outcomes` — `blobs[1]` is the stage, `blobs[2]` is
  the outcome.
- `provider_calls` — when wired (the http-client telemetry path) —
  `blobs[1]` is the provider id, `blobs[2]` is the outcome.

Sketch SQL for the four alerts (pseudocode; AE SQL syntax is not
identical to PostgreSQL):

```sql
-- provider_fatal_error_rate (per provider, last 5 min)
SELECT blob1 AS provider,
       sum(case when blob2 = 'fatal_error' then 1 else 0 end) * 1.0
       / count(*) AS fatal_rate
FROM dataset
WHERE timestamp >= now() - interval '5 minute'
  AND blob0 = 'provider_calls'
GROUP BY provider
HAVING fatal_rate > 0.01;

-- query_cannot_answer_rate (per tenant, last 5 min)
SELECT index1 AS tenant_id,
       sum(case when blob3 = 'cannot_answer' then 1 else 0 end) * 1.0
       / count(*) AS unanswerable_rate
FROM dataset
WHERE timestamp >= now() - interval '5 minute'
  AND blob0 = 'query_executions'
GROUP BY tenant_id
HAVING unanswerable_rate > 0.05;
```

The `dlq_depth_nonzero` alert is D1-not-AE; configure it as a Cron
Trigger that runs `SELECT count(*) FROM ingestion_jobs WHERE
dead_lettered = 1` and posts to Slack on `count > 0`.

The `embedding_profile_mismatch_rate` alert reads from the AIG
dashboard (which already aggregates 4xx by code) — no AE wiring
needed.

## Manual-fire recipes (verifying alerts)

Each alert needs a way to artificially fire it for verification. Run
these against deployed dev:

### `provider_fatal_error_rate`

Temporarily rotate an OpenAI provider key to a known-bad value, then
issue 50 queries in a loop. The first batch of fatal errors hits the
1%-of-5-min threshold. Restore the key after.

```bash
for i in $(seq 1 50); do
  curl -s -X POST $WORKER/v1/query \
    -H "x-textral-api-key: $LIVE_API_KEY" \
    -H 'content-type: application/json' \
    -d "$(cat tools/load/query-body.json)" > /dev/null
done
```

### `query_cannot_answer_rate`

Temporarily delete every chunk in a tenant's namespace (or use a
namespace with no documents), then run 50 queries. They all degrade to
`cannot_answer`. Re-ingest after.

### `dlq_depth_nonzero`

```sql
UPDATE ingestion_jobs
   SET dead_lettered = 1, status = 'failed',
       error_code = 'TEST_ALERT_FIRE'
 WHERE id = (SELECT id FROM ingestion_jobs LIMIT 1);
```

The next D1-cron poll fires the alert. Reset:

```sql
UPDATE ingestion_jobs SET dead_lettered = 0
 WHERE error_code = 'TEST_ALERT_FIRE';
```

### `embedding_profile_mismatch_rate`

Issue a query whose `embedding.model` doesn't match the namespace's
`default_embedding_profile`. The Worker returns 400
`EMBEDDING_PROFILE_MISMATCH`. Repeat 50 times in 15 min.

## Acknowledgement + post-mortem flow

P1 alert → page + Slack → on-call ack within 15 min → post-mortem
within 24 h in `docs/postmortems/YYYY-MM-DD-<short>.md`.

P2 / P3 → Slack-only → triage during business hours.

## Updating this runbook

When you add a new alert: append a row to the table, add the SQL
recipe, add the manual-fire instructions, and tag the PR with the
`alerts` label so the on-call rotation reads the diff.
