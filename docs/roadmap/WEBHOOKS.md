# Webhooks (Tenant Event Subscriptions)

Today, knowing whether your ingest finished requires polling `list_failing_jobs` or `get_document`. That's wasteful, has poor UX, and blocks any real-time customer automation (e.g. "tell my Slack channel when this ingest completes").

Webhooks are how every other infra service solves this. Stripe, GitHub, Pinecone, Cloudflare itself — all webhooks.

## Why

- **Real-time customer automation.** Trigger pipelines on ingest completion without polling.
- **Operational visibility.** Slack/Teams/PagerDuty alerts on failed ingests for tenants running production workloads.
- **CI/CD.** "When my repo's docs ingest finishes, run my eval suite" — primary use case for the eval-as-a-service customer.
- **Marketplace prereq.** Connectors (Notion, GitHub, etc.) will need webhooks to drive their own state machines and to expose hooks to end users.

## Scope

In:
- Per-tenant webhook registration: URL, secret (HMAC signing key), event filter list.
- Initial event set: `ingest.queued`, `ingest.completed`, `ingest.failed`, `namespace.created`, `namespace.deleted`, `provider_key.registered`.
- HMAC signing on every payload (header `X-Textral-Signature: t=<ts>,v1=<hmac>`) with replay protection.
- At-least-once delivery; exponential backoff with N retries; dead-letter table after exhaustion.
- Sandbox UI to register/test/disable webhooks; webhook log view.
- API + MCP surfaces for managing webhooks.

Out (v1):
- `query.completed` and `query.failed` events. High-volume; opt-in only; consider for v2.
- Customer-side filter expressions (only-when-namespace-matches). Subscribe-by-event-type only for v1.
- Webhook delivery analytics dashboard. Basic log is enough.

## Sketch

- New table `webhooks (id, tenant_id, url, secret, events[], created_at, disabled_at)`.
- New table `webhook_deliveries (id, webhook_id, event_id, payload, status, attempts, last_attempt_at, last_response)`.
- Producer: domain code (ingest worker, namespace routes) emits `WebhookEvent` to a Cloudflare Queue.
- Consumer: queue worker fans out to subscribed webhooks, signs payload, POSTs, records result, retries with backoff.
- Signature verification documented in `docs/webhooks.md` with a Node and Python sample.
- Test endpoint: `POST /webhooks/{id}/test` sends a synthetic event for verification.

## Acceptance Criteria

- Tenant registers a webhook for `ingest.completed`; ingests a doc; webhook receives a signed POST within 5s p95.
- HMAC signature verifies with sample code from the docs.
- Failed deliveries (3xx/4xx/5xx/timeout) retry with backoff; after N attempts they land in dead-letter and the webhook is auto-disabled with notification email.
- Sandbox shows recent deliveries with status; can replay any delivery.
- Webhook disabled tenants cannot receive new events.

## Open Questions

- **At-least-once vs. exactly-once.** Exactly-once is hard; at-least-once is the industry standard. Document the idempotency expectation with `event_id` and let consumers dedupe.
- **Event payload contract location.** Live alongside other contracts in `@textral/contracts/webhooks` — same versioning lockstep.
- **Per-namespace subscriptions or tenant-only?** Tenant-only is simpler v1. Per-namespace is a nice add but not blocking.
- **Webhook delivery from CF Workers — concurrency limits?** Worth benchmarking before committing to the queue architecture vs. a Durable Object per webhook.

## Related

- [`CONNECTOR_MARKETPLACE.md`](./CONNECTOR_MARKETPLACE.md) — connectors are heavy consumers and producers of webhooks.
- [`COST_ATTRIBUTION.md`](./COST_ATTRIBUTION.md) — `usage.threshold_crossed` events are a likely v2 webhook.
