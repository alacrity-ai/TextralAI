# Cost Attribution (per-query micro-cents)

`audit.total_cost_usd_micros` is currently always `null`. The primitive exists; it's just not populated.

Without per-query cost attribution we cannot:
- Bill customers
- Operate a marketplace where customers BYO provider keys but we take a cut
- Show customers their spend (table-stakes for any prosumer/enterprise tier)
- Enforce usage caps
- Make data-driven decisions about which models/providers/operations to optimize

## Why

- **Billing & monetization.** Whatever the eventual pricing model, we need to know what each query cost. Today we don't.
- **Customer trust.** Tenants want a per-namespace, per-day cost dashboard. Pinecone has it; Vectara has it; we don't.
- **Cost-aware features.** Users on a tight budget want a "warn me if estimated cost > $X" guard.
- **Eval-driven optimization.** "What's the cost/quality tradeoff of switching reranker A → B?" can't be answered without per-query cost.

## Scope

In:
- Per-provider, per-model, per-token price catalog (versioned, dated).
- Cost calculator at audit finalization: embedding tokens × rate, reranker tokens × rate, synthesis input/output × rates, query_rewrite generation cost.
- `audit.total_cost_usd_micros` populated on every query.
- Per-component breakdown: `audit.cost_breakdown: { embedding, retrieval, reranker, synthesis, query_rewrite }` in micros.
- Daily aggregate jobs: `tenant_usage_daily (tenant_id, date, namespace_id, query_count, ingest_count, total_cost_micros)`.
- Sandbox dashboards: tenant-level + namespace-level monthly spend.
- API endpoints: `GET /usage` with date range filtering.
- CSV export for finance teams.

Out (v1):
- Infra cost attribution (Worker CPU, D1 reads, Vectorize storage). These are real costs but require Cloudflare Analytics integration; defer to v2.
- Markup model. v1 just tracks raw provider cost; pricing/markup is a separate decision.
- Real-time spend alerts. Daily rollups are enough for v1.

## Sketch

- New file `apps/api/src/billing/price-catalog.ts` — versioned price tables for OpenAI, Voyage, Cohere, Anthropic, Workers AI.
- Helper `calculateQueryCost(audit) -> { components, total }` that runs at the end of `finalizeAudit`.
- Migration adds nullable `total_cost_usd_micros` to existing `query_events` rows; new rows always populated.
- Daily aggregate worker (CF cron) rolls up `query_events` → `tenant_usage_daily`.
- Sandbox: existing dashboards page gets a "Usage" tab.
- `@textral/contracts`: extend `QueryAudit` with `cost_breakdown`.

## Acceptance Criteria

- Every new query has `total_cost_usd_micros` populated; spot-check vs. provider invoices shows ±5%.
- Per-component breakdown sums to total.
- Sandbox usage tab shows monthly spend per tenant and per namespace.
- `GET /usage?from=...&to=...` returns daily granularity.
- CSV export from sandbox works.
- Price catalog versioned: changing OpenAI's price doesn't retroactively change historical query costs.

## Open Questions

- **Price catalog freshness.** Hand-maintained for v1; autoupdate from provider pricing pages is a nice-to-have but error-prone.
- **What about queries with errors?** Failed queries still cost money (embedding ran, retrieval ran). Charge or not? Recommend yes; track separately.
- **Customer-supplied keys** (BYO OpenAI key). Cost is technically zero to us; do we still report estimated cost to the customer for their own awareness? Recommend yes — the customer wants to see it even when we're not billing for it.
- **Currency handling.** Micros (USD * 1e6) is the right granularity. Document that everywhere.
- **Free-tier accounting.** How many free queries per tenant? Decision blocked on pricing strategy.

## Related

- [`WEBHOOKS.md`](./WEBHOOKS.md) — `usage.threshold_crossed` events are a useful v2 add.
- [`PLUGGABLE_RERANKER.md`](./PLUGGABLE_RERANKER.md) — different rerankers cost differently; the picker should show estimated cost delta.
- [`INFERENCE_PROVIDERS.md`](./INFERENCE_PROVIDERS.md) — same, more so.
