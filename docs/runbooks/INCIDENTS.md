# Incidents Runbook

Phase 8.7. Triage + mitigation steps for the four MVP alerts. Filled
in over time as actual incidents occur.

## Alert: `provider_fatal_error_rate > 1%`

**What it means:** more than 1% of provider calls in the last 5 min
returned `fatal_error`. Most common cause is an invalid or expired
provider key.

**Triage:**

1. Check AI Gateway dashboard, filter by tenant. Which provider is
   failing?
2. `wrangler tail --env prod | grep provider_call | grep fatal_error`
3. Look at the `error_type`. `invalid_api_key` → key rotated;
   `insufficient_quota` → tenant hit quota; otherwise upstream is
   broken.

**Mitigation:**

- For `invalid_api_key`: contact the tenant. Their key is rejected;
  no Worker-side fix.
- For `insufficient_quota`: same as above; tenant pays the bill.
- For provider 5xx: monitor; if the provider posted an outage,
  reference their status page in the post-mortem.

## Alert: `query_cannot_answer_rate > 5%`

**What it means:** > 5% of queries in the last 5 min returned
`degradation_level=cannot_answer`. Either retrieval is empty
(indexing problem) or synthesis is failing (provider problem).

**Triage:**

1. Check `query_events` for the tenant: are there embedded chunks?
2. `SELECT count(*) FROM chunks WHERE tenant_id = '<t>' AND
    embedding_status = 'embedded'` — if zero, ingestion is the
   problem.
3. Otherwise check provider_call logs: is synthesis failing?

**Mitigation:**

- If chunks are missing: kick off a re-ingest. Use the bulk
  enrichment-only admin endpoint if just enrichment failed.
- If synthesis is failing: see the `provider_fatal_error_rate`
  alert.

## Alert: `dlq_depth_nonzero`

**What it means:** at least one ingestion job is dead-lettered.

**Triage:**

```bash
curl "$WORKER/v1/admin/ingestion-jobs?dead_lettered=1" \
  -H "x-textral-api-key: $ADMIN_KEY"
```

Look at `error_code` per row.

**Mitigation:**

- Most common: `PROVIDER_KEY_INVALID` — tenant rotated their key.
  Update the BYOK, then retry: `POST /v1/ingestion-jobs/<id>/retry`.
- `INPUT_TOO_LARGE_FOR_PASS` — corpus profile mismatch (legal
  documents going through narrative profile). Re-create the namespace
  with the right `corpus_profile`, re-ingest.
- `PROVIDER_QUOTA_EXHAUSTED` — tenant hit their plan limit.

## Alert: `embedding_profile_mismatch_rate > 0.1%`

**What it means:** tenants are issuing queries with embedding params
that don't match the namespace's index. Usually config drift in
their SDK wrapper.

**Triage:**

1. Identify the tenant from the AIG dashboard.
2. Check the namespace's `default_embedding_profile`.
3. Compare to what the tenant is sending in `embedding.model` /
   `embedding.dimensions`.

**Mitigation:**

- Reach out to the tenant; they need to align their SDK config with
  the namespace.
- Or re-ingest under the new profile if that's their preferred
  direction.

## War stories

Add entries here as real incidents occur. Format:

```
### YYYY-MM-DD — short title

**Symptom:** what you saw.
**Root cause:** what was actually wrong.
**Fix:** what you did.
**Prevention:** what we changed to keep it from happening again.
```

(Empty until the first prod incident.)
