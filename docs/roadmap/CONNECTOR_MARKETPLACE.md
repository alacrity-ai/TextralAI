# Connector Marketplace (Notion / GitHub / Slack / Drive / Confluence)

Manual ingestion via API/MCP/sandbox is fine for individual files. It does not scale to "ingest my entire Notion workspace and keep it fresh." Connectors are what makes RAG products viral and sticky — they're also the thing that lets `INTEGRATIONS.md` become a real product surface.

This is the highest-impact wedge for adoption. The product has nothing today; the gap to fill is large.

## Why

- **Distribution.** "Connect to Notion" is a one-click on-ramp. "Build a custom ingestion pipeline" is not.
- **Stickiness.** Once a customer connects their Notion workspace and Textral keeps it fresh, ripping it out is harder than swapping a vector DB.
- **Continuous value.** Static-ingest products go stale; live-connector products get more useful over time.
- **`INTEGRATIONS.md` already exists in the roadmap** — see that doc for product-level discussion. This doc is the framework that enables it.

## Scope

In:
- Connector framework: standardized contract for `auth`, `schedule`, `delta-fetch`, `chunk-mapping`.
- Per-tenant credential vault (extends `provider_keys` to support OAuth tokens with refresh).
- Initial connector set (in priority order):
  1. **GitHub** (issues, PRs, repo markdown/code) — easiest auth, biggest dev audience.
  2. **Notion** — broadest knowledge-base use case.
  3. **Google Drive** (Docs, PDFs in a folder).
  4. **Slack** — channel/thread ingestion.
  5. **Confluence** — enterprise wedge.
- Sandbox UI: connect/disconnect/configure each source per namespace.
- Auto-tag chunks with source metadata (`source: "notion", workspace_id: "...", page_id: "..."`).
- Webhook events on connector state transitions: `connector.synced`, `connector.failed`, `connector.auth_expired`.
- Delta-sync: only re-ingest changed/new content.

Out (v1):
- Customer-built connectors. v2 plugin SDK.
- Bidirectional sync (write-back to source). Read-only.
- Real-time sub-second freshness. Polling-based delta-fetch is fine for v1; webhooks where source supports them.

## Sketch

- New package `@textral/connectors-{github,notion,gdrive,slack,confluence}` (one per source).
- Common interface:
  ```typescript
  interface Connector {
    auth(): OAuth | APIKey;
    schedule(): "realtime" | "hourly" | "daily";
    listResources(cursor?: string): AsyncIterator<Resource>;
    fetchContent(resource: Resource): Promise<{ text, metadata, version }>;
    detectChanges(since: Timestamp): AsyncIterator<ResourceChange>;
  }
  ```
- Connector workers run as Cloudflare cron-driven jobs (`schedule: hourly`/`daily`) or webhook receivers (where source pushes).
- Delta engine: track `version` per resource; skip unchanged; deletes propagate as chunk-removal.
- New tables: `connectors (id, tenant_id, namespace_id, source, config, last_sync_at)`, `connector_resources (id, connector_id, source_resource_id, version, last_seen_at)`.
- OAuth flows in sandbox: standard 3-legged flow with refresh-token storage.

## Acceptance Criteria

- Tenant connects a GitHub repo to a namespace via sandbox OAuth flow.
- Within 1h, all repo markdown + open issues are ingested with `source: "github"` metadata.
- New issue → ingested within next sync cycle (1h default; 5min for paid).
- Deleted issue → chunk marked deleted; no longer returned in queries.
- Auth expiry → `connector.auth_expired` webhook fires; sandbox shows reconnect prompt.
- Chunks queryable with metadata filter `source: "github"`.

## Open Questions

- **Rate-limit handling per source.** Notion's API is generous; GitHub's depends on token type; Slack's is tight. Each connector needs source-aware backoff.
- **Backfill cost.** Connecting a 10k-page Notion workspace costs real $ in embeddings. Confirm with user before kicking off; show estimated cost upfront.
- **Per-source filtering UI.** Notion: which databases? Drive: which folders? GitHub: which paths? Each connector has a different filter model.
- **Conflict with manual ingest.** If a connector ingests `foo.md` and a customer also manually ingests `foo.md`, what wins? Recommend connector-tagged chunks live separately and don't conflict.
- **Connector framework as plugin SDK.** Eventually customers want to build their own. Designing the interface to be public-ready from v1 saves rework.

## Related

- [`docs/roadmap/INTEGRATIONS.md`](./INTEGRATIONS.md) — product-level discussion that motivated this.
- [`WEBHOOKS.md`](./WEBHOOKS.md) — connector state events ride this rail.
- [`METADATA_FILTERS.md`](./METADATA_FILTERS.md) — `source: "github"` filter is the v1 use case.
- [`COST_ATTRIBUTION.md`](./COST_ATTRIBUTION.md) — backfill cost reporting is essential UX.
