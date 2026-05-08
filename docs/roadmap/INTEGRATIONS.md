# Integrations

> **Status:** exploratory design draft. Authored 2026-05-06. Not yet
> a delivery commitment. Owns the question of how Textral pulls
> content *from* source-of-truth systems (Confluence, Jira, GitHub,
> Notion, Slack, Drive) into namespaces — natively, with agents
> driving the flow.

---

## 1. The pitch in one paragraph

Textral today owns ingest *after* documents are in a normalized form
— you hand it bytes, it chunks, embeds, indexes. Integrations make
Textral a first-class consumer of *external systems* with their own
auth, identity, and update semantics. An operator registers a
Confluence connection once; from then on agents and humans can
browse Confluence spaces through Textral's surface, ingest selected
content into namespaces, and re-sync incrementally as those external
documents change. Same idea as BYOK provider-keys but for *content
sources* instead of *model providers*.

The flow the seed doc described:

> "Hey Claude, ingest all tickets from the last 48 hours in my
> Quote-To-Order project on Jira. Put them in a new namespace in my
> Pinecone."

> "What work is mission-critical here? Look at the Jira tickets,
> and look at the Future Initiatives namespace also and compare."

…both work end-to-end with one new abstraction (the integration)
and a handful of new tools. The second flow is *already* possible
today — it's just two `query` calls plus the agent's synthesis.
What unlocks the first is what this doc is about.

---

## 2. Why now

Three signals converge:

1. **The MCP surface stabilized in Phase 1.** Agents can drive
   namespaces, ingest, and query through 16 named tools. The
   ergonomic gap between "the model knows OpenAPI" and "the model
   knows tools" is closed. Adding integration-shaped tools extends
   that surface naturally.
2. **Pinecone-style customers want this story.** Most Pinecone
   deployments end up wired to Confluence/Jira/Notion via custom
   loaders that drift. "Textral is the loader, the indexer, *and*
   the retrieval surface" is a stronger pitch than "Textral handles
   the embed step, you write the loader."
3. **The connector-loader market is fragmented.** LlamaIndex
   connectors, LangChain document loaders, Cohere Connect — every
   framework has its take. None of them sit upstream of a robust
   audit + citation + namespace + eval surface. Textral's
   differentiation is the loop those connectors feed *into*.

---

## 3. Mental model

### 3.1 What an Integration *is*

An **Integration** is a credentialed, stateful connection to a
single external system, scoped to a tenant.

| | Provider Key | Integration |
|---|---|---|
| Credentials | API key | API key, OAuth tokens (with refresh), service account JWT |
| State | None — stateless lookup | Has state — sync cursors, watermarks, resource bindings |
| Capabilities | Embed / inference / rerank | Browse, fetch, watch (Phase 2) |
| Multiplicity | One per (provider, label) | One per (connector_type, label) |
| Read-write | Write-only (raw key not re-emitted) | Read-only (Textral never writes back to the source) |

### 3.2 What a Connector *is*

A **Connector** is the implementation behind an integration type —
the code that knows how to talk to Confluence, or Jira, or GitHub.
One connector class per source system. Mirrors the `VectorStore`
adapter pattern: an interface, several implementations, a selector
that picks the right one given a config.

```ts
export interface Connector {
  /** What this connector can do. Used by the sandbox + MCP layers
   *  to surface only the operations that are valid. */
  capabilities(): ConnectorCapabilities;

  /** Validate credentials. Mirrors /provider-keys/{id}/test. */
  validate(): Promise<ValidationResult>;

  /** Discovery half. Drill from workspace → space → page (or
   *  workspace → project → ticket, etc.). The agent uses this to
   *  resolve human-typed names ("Quote-To-Order") to foreign IDs. */
  listResources(parent?: ResourceRef): Promise<ResourceListing>;

  /** Fetch a single resource as a normalized document — markdown
   *  body + metadata (source URL, author, modified-at, foreign-system
   *  labels). Connector knows its own format conversion (Confluence
   *  storage format → markdown, Jira ADF → markdown, etc.). */
  fetchResource(ref: ResourceRef): Promise<NormalizedDocument>;

  /** Phase 2 — emit change events. Either polled (default) or push
   *  (webhook receiver). */
  watch?(opts: WatchOptions): AsyncIterable<ChangeEvent>;
}
```

### 3.3 Resources are the new noun

A **Resource** is one fetchable thing inside an external system: a
Confluence page, a Jira ticket, a GitHub issue. Connectors expose
resources via discriminated kinds:

```ts
type ResourceRef =
  | { kind: 'confluence_space'; integration_id: string; space_key: string }
  | { kind: 'confluence_page'; integration_id: string; page_id: string }
  | { kind: 'jira_project'; integration_id: string; project_key: string }
  | { kind: 'jira_ticket'; integration_id: string; ticket_key: string }
  | { kind: 'gh_repo'; integration_id: string; owner: string; repo: string }
  | { kind: 'gh_issue'; integration_id: string; owner: string; repo: string; number: number }
  // etc.
```

Selectors let an agent ingest in bulk: "all tickets in project QTO
updated in the last 48 hours" is a `Selector`, which the connector
turns into one or more `ResourceRef`s.

```ts
type Selector =
  | { kind: 'jira_ticket'; project_key: string; updated_after?: string; jql?: string }
  | { kind: 'confluence_page'; space_key: string; modified_after?: string }
  | { kind: 'gh_issue'; owner: string; repo: string; state?: 'open' | 'closed'; updated_after?: string }
  // etc.
```

The selector → resource-list expansion is connector-defined and
runs server-side; the agent never sees the foreign API directly.

---

## 4. Architecture

### 4.1 Schema

```sql
CREATE TABLE integrations (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  connector_type      TEXT NOT NULL,         -- 'confluence_cloud', 'jira_cloud', 'github', ...
  label               TEXT NOT NULL,         -- e.g. 'main-confluence', 'oncall-jira'
  config_json         TEXT NOT NULL,         -- public connector config: host, workspace_id, region
  auth_type           TEXT NOT NULL,         -- 'api_token', 'oauth', 'service_account'
  auth_secret_ref     TEXT,                  -- → Secrets Store (CF) or encrypted_secrets (Node)
  oauth_refresh_ref   TEXT,                  -- separate; rotates independently
  scopes              TEXT,                  -- JSON array — operators audit what we asked for
  last_validated_at   INTEGER,
  last_validated_status TEXT,                -- 'ok', 'auth_expired', 'unauthorized', 'rate_limited'
  last_error_code     TEXT,
  created_at          INTEGER NOT NULL,
  revoked_at          INTEGER
);
CREATE UNIQUE INDEX integrations_active_unique
  ON integrations(tenant_id, connector_type, label)
  WHERE revoked_at IS NULL;

CREATE TABLE integration_resources (
  id                          TEXT PRIMARY KEY,
  tenant_id                   TEXT NOT NULL REFERENCES tenants(id),
  integration_id              TEXT NOT NULL REFERENCES integrations(id),
  resource_kind               TEXT NOT NULL,
  external_id                 TEXT NOT NULL,
  external_metadata_json      TEXT,           -- title, key, summary, URL, foreign-system labels
  document_id                 TEXT,           -- nullable; set after first ingest
  last_ingested_at            INTEGER,
  last_external_modified_at   INTEGER,
  ingest_cursor               TEXT,           -- opaque; connector-defined
  UNIQUE(tenant_id, integration_id, resource_kind, external_id)
);

CREATE TABLE integration_sync_jobs (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  integration_id      TEXT NOT NULL,
  namespace_id        TEXT NOT NULL REFERENCES namespaces(id),
  mode                TEXT NOT NULL,          -- 'full', 'incremental'
  selector_json       TEXT NOT NULL,          -- what the agent / operator asked for
  status              TEXT NOT NULL,          -- 'pending', 'running', 'completed', 'partial', 'failed'
  total_resources     INTEGER,
  ingested_count      INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  error_summary       TEXT,
  started_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
-- Per-document IngestionJob rows gain a parent reference:
ALTER TABLE ingestion_jobs ADD COLUMN parent_sync_job_id TEXT;
```

The `integration_resources` table is the *bridge*: one row per
external resource, persistent across syncs, carrying the cursor that
makes incremental sync possible.

### 4.2 REST surface

Following the existing `/v1/provider-keys` pattern:

| Operation | Route |
|---|---|
| Register integration | `POST /v1/integrations` |
| List integrations | `GET /v1/integrations` |
| Get one | `GET /v1/integrations/{id}` |
| Test credentials | `POST /v1/integrations/{id}/test` |
| Soft-delete | `DELETE /v1/integrations/{id}` |
| Browse resources | `GET /v1/integrations/{id}/resources?parent=…&kind=…` |
| Trigger sync | `POST /v1/integrations/{id}/sync` |
| Sync job status | `GET /v1/integration-sync-jobs/{id}` |
| List sync jobs | `GET /v1/integration-sync-jobs?integration_id=…` |

OAuth-flavored connectors add:

| Operation | Route |
|---|---|
| Begin OAuth | `POST /v1/integrations/oauth/begin` (returns redirect URL) |
| OAuth callback | `GET /v1/integrations/oauth/callback` (registers integration) |

`POST /v1/integrations/{id}/sync` body:

```json
{
  "namespace_slug": "qto-recent",
  "mode": "incremental",
  "selector": {
    "kind": "jira_ticket",
    "project_key": "QTO",
    "updated_after": "2026-05-04T00:00:00Z"
  },
  "ingest_config": {
    "embedding": { "provider": "openai", "model": "text-embedding-3-large", "dimensions": 1024 },
    "chunking": { "profile": "support" }
  }
}
```

Returns `{ sync_job_id, total_resources, ingest_jobs: [{ resource_id, ingest_job_id }] }`.
Each child IngestionJob threads through the existing pipeline.

### 4.3 MCP tool surface

| Tool | Purpose |
|---|---|
| `register_integration` | Register a new integration (connector_type + creds + label). Auth-type-specific input shape. |
| `list_integrations` | List integrations on the tenant. Filter by connector_type + status. |
| `test_integration` | Re-validate creds. |
| `revoke_integration` | Soft-delete (Phase 2 — destructive, with elicitation). |
| `list_integration_resources` | Browse what's available. Parent-and-kind paginated. |
| `sync_integration` | Trigger a sync. Selector + namespace + mode + optional `wait`. |
| `get_sync_job` | Status of a parent sync job. |
| `list_sync_jobs` | Recent syncs, filter by integration / status. |

`sync_integration` is the headline — like `ingest_file` for individual
documents but bulk-shaped. Same `wait=true` polling + progress
notification model: progress events fire as each child ingest job
transitions stages, plus a parent-level "47/142 resources complete"
event.

Connector-specific browse shapes derive from a discriminated Zod
schema in `packages/contracts`, so MCP input schemas stay typesafe
and the agent gets per-connector hints in its tool list.

### 4.4 Sandbox surface

A new top-level **Integrations** page mirroring **Provider Keys**:

- **List view.** Table of integrations: label, connector_type
  (badge), status, last validated, actions (test / revoke).
- **Register form.** Connector-type dropdown drives the credential
  schema. Atlassian → "host + email + API token" inputs;
  GitHub → "PAT or device-flow"; Notion → "integration token";
  OAuth connectors → "begin OAuth" button.
- **Drill-down.** Click an integration → resource browser. Tree on
  the left (workspaces → spaces → pages, or accounts → projects →
  tickets), preview on the right.
- **Bulk-ingest panel.** Select resources, pick a namespace, pick
  ingest config (corpus profile, embedding) — submit. Live
  progress on the resulting sync job.
- **Sync history.** Past syncs per integration, drill into per-resource
  outcomes.

The sandbox leans heavily on existing primitives — the resource browser
reuses the same audit / progress / error-envelope conventions.

---

## 5. Authentication

Auth is where the work concentrates. Three patterns:

### 5.1 API token / PAT (Phase 1)

Simplest. Operator pastes a token, Textral encrypts at rest, every
connector call attaches it to the request. Same shape as
provider-keys — direct port of that storage path.

Connectors in this tier: **Confluence Cloud, Jira Cloud, GitHub,
Notion, Linear, Zendesk**. One Atlassian API token covers both
Confluence + Jira (separate integration rows so labels stay
clean).

### 5.2 OAuth 2.0 with refresh (Phase 2)

OAuth connectors require:

- A registered OAuth client per connector type (Confluence app,
  Slack app, Google client). Operator-side or hosted-by-Textral —
  we'd ship Textral-hosted clients for the common cases.
- Redirect URI on the API: `/v1/integrations/oauth/callback`.
- Access + refresh token storage (encrypted, separate refs so
  refresh rotation doesn't invalidate the access).
- Pre-flight refresh on every connector call where access expiry
  is < 60s away.
- Refresh-token-rotation handling — newer providers rotate the
  refresh-token on every refresh; we update the stored ref atomically.

Connectors in this tier: **Slack, Google Drive, OneDrive, Salesforce**.

### 5.3 Device flow (deferred — Phase 3)

For headless agents on machines without browsers. Aligns with the
MCP 2025-11-25 OAuth-device-flow spec. Lower priority.

### 5.4 What we don't do

- Never store unencrypted credentials. Same redaction bar as
  provider-keys: tokens never re-emitted, never logged.
- Never read connector data we don't have explicit scope for.
  Operators see exactly what scopes were granted on the integration
  detail page — if an agent later asks for content outside scope,
  the connector returns the foreign system's auth error verbatim.
- Never write back. Read-only ingest. If a customer wants
  bidirectional sync ("agent updates Jira ticket from Textral
  citation"), that's a different surface — agents already have
  per-system MCP servers (Atlassian's own MCP) for the write path.

---

## 6. Connector roster

### 6.1 Phase 1 — API-token connectors

| Connector | Auth | Resource shapes | Notes |
|---|---|---|---|
| **Confluence Cloud** | Atlassian basic (email + API token) | `space`, `page`, `blogpost` | Storage-format → markdown via existing converter |
| **Jira Cloud** | Atlassian basic (same token) | `project`, `ticket` (issue), `comment-thread` | ADF → markdown; Description + comments treated as one document or split per profile |
| **GitHub** | PAT (or GitHub App as Phase 2) | `repo`, `issue`, `pull_request`, `discussion`, `wiki_page`, `tree_file` (markdown only) | Most leverage for technical-corpus profiles |
| **Linear** | API token | `team`, `project`, `issue`, `cycle` | Tight Jira-equivalent; cleaner API |
| **Zendesk** | API token | `help_center_article`, `ticket` | Strong demo for the `support` corpus profile |

This is the Phase 1 ship list. Each costs ~300 LoC for the
connector + ~80 LoC for the MCP tool input wiring.

### 6.2 Phase 2 — OAuth connectors

| Connector | Why later | Resource shapes |
|---|---|---|
| Slack | OAuth + scope-heavy | `workspace`, `channel`, `thread` |
| Google Drive | OAuth + complex scopes | `folder`, `doc`, `sheet`, `pdf` |
| Notion | Token works; OAuth is nicer for revocation | `database`, `page`, `block_tree` |
| Microsoft 365 | OAuth + tenant-scoped | `sharepoint_site`, `sharepoint_doc`, `outlook_thread` |

### 6.3 Deferred / out-of-scope

- **Salesforce** — high effort, low overlap with the typical Pinecone customer.
- **Email (IMAP/Gmail)** — content is messy, PII-dense, hard to do well.
- **File systems / S3 buckets / FTP** — those should be operator-side
  scripts hitting the existing `ingest_file` flow; not enough
  Textral-specific value-add.
- **Database connectors** — different abstraction altogether.

---

## 7. Demo workflows

### 7.1 The seed flow — "ingest from Jira into Pinecone"

Agent transcript (Claude Code, MCP, all live):

```
USER: Ingest all tickets from the last 48 hours in my Quote-To-Order
project on Jira. Put them in a new namespace in my Pinecone.

CLAUDE: [calls textral.list_integrations(connector_type='jira_cloud')]
        → finds one labeled 'main-jira', tenant token id pkey_…
        [calls textral.list_integration_resources(integration_id, kind='project')]
        → resolves "Quote-To-Order" → project_key='QTO'
        [calls textral.create_namespace(slug='qto-recent', vector_backend='pinecone',
                                         vector_index_name=…, vector_namespace='qto-recent',
                                         corpus_profile='support')]
        [calls textral.sync_integration(integration_id,
                                        namespace='qto-recent',
                                        selector={ kind: 'jira_ticket',
                                                   project_key: 'QTO',
                                                   updated_after: '2026-05-04T00:00:00Z' },
                                        mode='incremental',
                                        wait=true)]
        → 87 tickets ingested, 0 failed, 5.4s end-to-end.

CLAUDE → USER: "Ingested 87 Jira tickets from QTO updated in the last
48 hours into the new `qto-recent` namespace (Pinecone). All 87
ingested cleanly. The namespace shares your existing Pinecone index
`textral-index` via Pinecone-namespace partitioning, so no new index
provisioning was needed."
```

Single agent turn, four tool calls, zero glue code.

### 7.2 The follow-up — cross-namespace synthesis

```
USER: What work is mission-critical here? Look at the Jira tickets,
and look at the Future Initiatives namespace also and compare.

CLAUDE: [calls textral.query(namespace='qto-recent',
                             query='which tickets describe mission-critical or
                                    customer-blocking work?',
                             …)]
        → 14 citations across 9 tickets
        [calls textral.query(namespace='future-initiatives',
                             query='which initiatives are flagged as P0 or
                                    customer-critical?',
                             …)]
        → 6 citations across 4 initiative docs

CLAUDE → USER: "Three threads jump out as mission-critical:
1. Ticket QTO-1844 — checkout latency regression (cited 3x, P0).
   Aligns with the 'Reduce conversion friction' initiative
   (future-initiatives:init-cf3, cited 2x).
2. Ticket QTO-1851 — currency-conversion bug for non-USD enterprise
   accounts. Maps to the 'Global enterprise expansion' initiative.
3. Tickets QTO-1832, QTO-1838 — both about the new tax-validation
   service flapping. No matching initiative — possible coverage gap.

The Pinecone audit shows native namespace isolation: the QTO query
returned only the 87 Jira ticket vectors, while the Future
Initiatives query hit the separate qdrant collection. Citations
[QTO-1844], [init-cf3], etc., link directly to the source records."
```

This flow needs *no* new tools — it's just two `query` calls
against differently-backed namespaces, plus the agent's synthesis.
But it's the *result* of having Integration-driven ingest + the
multi-tenancy fix from Plan 08 working together. The demo lands
because the source-of-truth content (Jira) and the strategic
content (Future Initiatives) cleanly co-locate in Textral, even
though one came from an external system and one was hand-written.

### 7.3 Other workflow ideas

- **Notion design doc → narrative profile.** Ingest a Notion
  page tree as a `narrative` corpus, run section-summary +
  character-dossier (here: "stakeholder-dossier") enrichment passes,
  query for "who has accountability for X?"
- **GitHub issues → eval set.** Ingest closed issues with the
  "feature-request" label, use them as a baseline for the
  `evaluate_namespace` workflow against your product docs.
- **Confluence runbooks → support profile.** Operator ingests a
  Confluence space of internal runbooks, exposes via MCP — first-line
  support agent asks Claude "how do I rotate the staging DB?", gets
  a citation-grounded answer with a link straight to the runbook.

---

## 8. Cross-cutting design questions

### 8.1 Pull vs push

Phase 1 is pull. Operator or agent triggers a sync; connector
fetches; ingest happens. Phase 2 could add webhook receivers
(Confluence space-update events, Jira ticket-update events) for
near-real-time sync. Webhooks introduce a separate auth surface
(signature verification per provider) and a different operational
profile (idempotent receivers, retry on transient failure).

Until Phase 2: scheduled syncs via a cron-style operator config.
Operators can hit `POST /v1/integrations/{id}/sync` from an external
scheduler if they want minute-grained polling.

### 8.2 Incremental sync semantics

Each connector defines what "since cursor X" means:

| Connector | Cursor primitive |
|---|---|
| Confluence | `lastModified > cursor` (millis since epoch) |
| Jira | JQL `updated > "<cursor>"` |
| GitHub | Events API `?since=<ISO>` for issues; `If-Modified-Since` headers for files |
| Notion | `last_edited_time > cursor` |
| Linear | `updatedAt > cursor` |

The cursor stays opaque to Textral — the connector marshals it to
its native type. `integration_resources.ingest_cursor` is a TEXT
column for that reason; no schema commitment to a specific shape.

### 8.3 Deletion handling

External systems delete; what should Textral do?

Three options:
1. **Soft-delete the document** (mirror Textral's existing soft-delete).
   Document stays in the DB but excluded from queries.
2. **Tombstone** — mark `external_deleted_at`, keep vectors but
   filter at query time. Useful for audit (still queryable
   historically) but doubles state.
3. **Hard-delete + chunk delete** — full removal.

Default: **soft-delete**, mirrors namespace soft-delete. Optionally
a `purge_after_days` per integration for compliance ("delete
external-deleted Jira tickets after 90 days").

### 8.4 Document identity & idempotency

When a Confluence page is re-ingested:

- `integration_resources.(integration_id, resource_kind, external_id)`
  resolves to the existing row.
- The existing `document_id` is reused.
- A new `document_version` is created (the existing v3 versioning
  semantics handle this).
- Re-embedding only happens if the content hash changed — same dedup
  the existing ingest pipeline does.

This means an agent re-ingesting "all QTO tickets" is cheap when
nothing changed — a no-op at the chunk level, even if the connector
re-fetched.

### 8.5 Citation back-links

Citations should link back to the source of truth. The
`Document.metadata` field already accepts arbitrary JSON; integration
ingest writes:

```json
{
  "source_url": "https://acme.atlassian.net/browse/QTO-1844",
  "external_kind": "jira_ticket",
  "external_id": "QTO-1844",
  "external_modified_at": 1778090100000,
  "labels": ["P0", "checkout"],
  "author": "..."
}
```

The Sandbox citation renderer reads `source_url` if present and
renders it as a hyperlink. The MCP `query` response surfaces it on
each citation. Closes the loop: agent answers → citation → click →
the Jira ticket itself.

### 8.6 Per-connector enrichment

Different connectors carry different metadata. The corpus profile
system can branch on `doc_type`:

- A `jira_ticket` doc_type unlocks a `jira_priority_classification`
  enrichment pass that tags chunks with `priority`, `state`, `assignee`.
- A `confluence_page` doc_type unlocks `confluence_label_extraction`.
- Extends the existing per-profile enrichment pipeline; no new
  primitive.

### 8.7 Rate limiting + circuit breakers

External APIs throttle. Each connector wraps its `fetch` with:

- Honor 429 with `Retry-After` parsing.
- Circuit breaker around persistent 401/403 — the integration's
  `last_validated_status` flips to `auth_expired` and the sandbox
  surfaces a "re-auth" CTA.
- Exponential backoff with jitter on transient 5xx.

Same shape we already use for provider-keys.

### 8.8 Field-level redaction

Source content can be PII-dense (Jira tickets reference customer
emails; Slack threads reference internal IDs). Operators should be
able to declare a redaction policy at the integration level —
pre-storage, applied to the normalized markdown body before
chunking. Hooks into the existing `tenants.audit_mode` policy where
possible; integration-level overrides for the connector-specific
fields.

Phase 1 ships a coarse "strip emails, mask account IDs" preset.
Phase 2 lets operators pass a regex set or a declarative redaction
config.

---

## 9. Anti-goals

- **Not a generic ETL pipeline.** Airbyte and Fivetran cover that
  market; we're not competing. Textral connectors are scoped to the
  ingest path and integrated with the audit + namespace + corpus-profile
  surface.
- **Not bidirectional sync.** Textral pulls; never pushes back.
  Agents that want to update Jira tickets call Atlassian's own MCP
  server.
- **Not real-time CDC.** Phase 1 is on-demand or scheduled. Phase 2
  can add webhooks for soft-real-time. Continuous-sync semantics
  (subscriptions, persistent watchers) are out of scope.
- **Not a generic webhook receiver.** If we add webhooks (Phase 2),
  they're per-connector, signed, narrowly scoped.
- **Not a credential broker for non-Textral consumers.** Integrations
  exist to feed Textral's ingest path; we don't expose raw connector
  APIs to external callers.

---

## 10. Phasing

| Phase | Scope | Connectors | Effort estimate |
|---|---|---|---|
| **Phase 1 — MVP** | Schema (3 tables) + REST surface + 8 MCP tools + sandbox basic UI + sync-job model + parent-job tracking + connector interface + 3 connectors | Confluence Cloud, Jira Cloud, GitHub PAT | ~2 weeks |
| **Phase 1.5** | Add 2 more API-token connectors + per-doc-type enrichment hooks + citation back-link rendering | Linear, Zendesk | ~3 days |
| **Phase 2 — OAuth + scheduled** | OAuth flow, refresh handling, scheduled sync via cron, Notion + Slack | Notion, Slack | ~1 week |
| **Phase 3 — Webhooks + redaction** | Webhook receiver per connector, field-level redaction config, enrichment-pass per-resource-kind library | (no new connectors) | ~1 week |
| **Phase 4 — Long tail** | Google Drive, M365, Salesforce, custom-connector SDK | OAuth-heavy connectors | open-ended |

Phase 1 is the minimum that makes the seed-doc flow real. Each
later phase is independently shippable.

---

## 11. Demo upside (Pinecone-PE-call angle)

For a Pinecone PE specifically:

- **Most Pinecone deployments today have a brittle loader layer.**
  Operators write Python scripts pulling from Confluence/Jira/Notion,
  embed via OpenAI, upsert to Pinecone. Drift is constant. Textral
  collapsing that stack into one auditable surface — with native
  Pinecone namespacing for tenant isolation — is a strong fit.
- **Agent-driven multi-namespace ingest is the demo punchline.**
  Today's flow is ingest-once / query-many. The integrations story
  turns it into ingest-as-needed: the agent provisions a namespace,
  pulls fresh data, queries it, and synthesizes against existing
  long-lived corpora — all in one turn.
- **Per-source-system corpus profiles + Pinecone shows depth.**
  A `support` profile on a Zendesk-sourced namespace uses
  troubleshooting-step extraction. A `narrative` profile on a Notion
  PRD namespace uses stakeholder-dossier extraction. A `legal`
  profile on a Confluence space of contracts uses clause extraction.
  Same Pinecone index, different Pinecone namespaces, different
  enrichment pipelines per source — that's the kind of texture
  that's hard to bolt on after the fact.

---

## 12. Open questions

1. **Connector-specific defaults vs operator-supplied.** Should
   each connector ship with a sensible default `corpus_profile` for
   its content (Zendesk → `support`, Confluence → `narrative`)?
   Yes, but always overrideable. The agent-driven flow benefits
   from "ingest from Confluence" Just Working without forcing the
   agent to reason about profile choice.

2. **Per-tenant vs hosted OAuth client.** Phase 2 OAuth — do we
   ship a single Textral-hosted Confluence app, or do operators
   register their own? Hosted is friction-free for self-serve; own
   client is mandatory for some enterprise deployments. Probably
   ship both: hosted as the default, operator-client as an
   advanced option in the registration form.

3. **Should we own scheduled-sync infrastructure?** Phase 2 needs
   scheduled syncs. Three options: (a) Textral runs its own
   scheduler (cron table + worker), (b) operators hit
   `POST /v1/integrations/{id}/sync` from an external scheduler
   they already run, (c) MCP exposes a `schedule_sync` tool that
   Claude Code's own cron mechanism manages. Default to (b) for
   Phase 2, layer (a) on later.

4. **What happens when the same external resource is in two
   integrations?** E.g., two Jira integrations (different
   permissions) both able to read ticket QTO-1844. Should the
   document be shared, or one per integration? Default: one per
   integration (`integration_resources.UNIQUE` includes
   `integration_id`). Operators who want shared behavior can
   choose which integration to ingest from.

5. **Partial-failure semantics on bulk sync.** When 142 resources
   are requested and 87 succeed, 55 fail — is the sync job `partial`
   or `failed`? Probably `partial`, with `failed_count` populated and
   per-resource errors retrievable. Mirrors the existing
   `degradation_level` pattern from query.

6. **How does `delete_integration` cascade?** Soft-deleting an
   integration: do the documents it created get soft-deleted too?
   Probably no — operators may still want the historical content
   in Textral even after disconnecting the source. Tombstone the
   resources but keep the documents. Make purge an explicit
   `purge_documents=true` flag.

---

## 13. Out of scope but worth noting

- **Custom-connector SDK.** Eventually let customers ship their own
  connectors (their internal CRM, their proprietary doc system).
  Phase 4+. Requires connector sandboxing — runtime can't crash
  Textral on bad connector code.
- **Multi-source documents.** A "document" that spans content from
  multiple integrations (a runbook with embedded Jira ticket
  context). Probably a higher-level abstraction (a *bundle*
  document); orthogonal to integrations themselves.
- **Pinecone Inference / Pinecone Connect.** Pinecone offers
  hosted ingest pipelines — competitive surface. Worth tracking
  but separate design.
- **Re-ingest economics.** Bulk re-embed of a 10k-ticket Jira
  history is expensive. We need per-tenant cost controls (already
  partially in place via `usage_records`); integrations exacerbate
  the pressure.

---

## 14. Suggested next moves

If the seed idea lands:

1. **Spike: build the Jira connector end-to-end** as a 1-day proof.
   Schema + connector + one MCP tool (`sync_integration`) + manual
   sandbox call (no UI yet). Validates the abstractions before we
   commit to the full Phase 1 surface.
2. **Pin the connector interface** in `packages/contracts` — both
   the runtime interface and the discriminated union of resource /
   selector types.
3. **Decide on the Phase 1 ship list.** Confluence + Jira (both via
   Atlassian) is the obvious first pair; GitHub PAT is the cheap
   third; Linear + Zendesk fill out the ergonomic-ask list. Past
   five connectors, value per-additional-connector drops fast.
4. **Sandbox UX sketch.** Even a low-fi wireframe of the resource
   browser unblocks the design conversation — the table-of-tables
   pattern (workspaces → spaces → pages) needs to feel right
   before code lands.

---

End of design exploration. The seed instinct — that integrations
are the natural complement to provider-keys — is correct. The
abstraction shape, the schema, the MCP surface, and the Pinecone-PE
demo upside all hold up under scrutiny. The decision to make is
*when*, not *whether*.
