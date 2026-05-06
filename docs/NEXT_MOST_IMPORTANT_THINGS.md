# Next Most Important Things

> Brainstorm. The MVP is API-complete and self-documenting. Now we
> need everything around it that turns "an API exists" into "tenants
> can find us, sign up, integrate, pay, and trust us." Items are
> ordered by "blocks customer acquisition / revenue" first, then
> "blocks scale and enterprise sales."
>
> Each item: what it is, why it matters, rough scope, and what
> existing piece in this repo or in `reference_repos/home-app` it
> can borrow from.

---

## 1. Customer-facing landing + self-serve onboarding

**What.** A marketing site at `textral.dev` (or `.com`). Hero +
features + pricing + docs link + a **Sign up** CTA that runs an
email-confirmation onboarding flow:

1. Email input → POST `/v1/public/signup` → mailgun sends a 6-digit
   OTP or magic link.
2. User clicks the link / enters the OTP → confirms → server runs a
   thin variant of `/v1/admin/bootstrap` that issues a tenant + a
   default namespace + a fresh API key.
3. User lands on the admin console (item #2) with their key shown
   once and copyable.

**Why it matters.** Today the only path to a working tenant is the
operator-only `make seed-dev` flow. Without self-serve, every
customer is a hand-held ops ticket. Self-serve onboarding is the
single highest-leverage thing for customer acquisition.

**Scope.** ~2 weeks for one engineer.

- New `apps/marketing/` (Astro or Next.js — Astro fits the repo's
  Cloudflare-native bias, deploys as a static Worker).
- New `apps/api/src/routes/public/signup.ts` — email verification +
  bootstrap orchestration. Rate-limited (1/email/hour).
- New `apps/api/src/services/mailgun.ts` — copy verbatim from
  `reference_repos/home-app/apps/api/src/services/mailgun.ts`.
- New `apps/api/src/email/templates.ts` — same pattern as
  `home-app`.
- 2 new D1 tables: `signup_intents` (email + token + expiry) and a
  `confirmed_at` column on `tenants`.
- SEO: real `<title>`/`<meta>`, OG cards, structured-data JSON-LD,
  sitemap.xml. CF Web Analytics on by default.

**Defers.** Stripe (item #4) doesn't have to land at the same time
— ship a "free tier — TBD" CTA and gate features in item #2 by a
hardcoded plan field for the first wave.

---

## 2. Admin console / tenant dashboard

**What.** A web UI tenants log into to:

- See / rotate / revoke their API keys (and create new ones with
  scopes).
- Register / list / revoke their BYOK provider keys.
- List / create / soft-delete namespaces.
- Browse documents and ingestion jobs (status, error_code, retry
  button, stage attempts).
- View a real-time **Usage** page reading from `usage_records`
  (queries, tokens, cost rollup; per-day chart).
- Browse `query_events` with the audit JSON viewer + jump to the
  R2-mirrored answer.
- Manage eval sets and view past run results.

**Why it matters.** Engineers will use the API directly; product
managers, analysts, ops will not. Without a UI, every non-engineer
in a tenant org is blocked. The admin console is also where
"value" is felt — the customer sees their dashboard, their usage,
their data — which drives renewals.

**Scope.** ~3 weeks for one engineer.

- New `apps/console/` (React + Vite + Tailwind, deployed as a
  Worker static site or Cloudflare Pages).
- Auth: short-lived session cookie issued on signup (item #1)
  confirmation. Reuse the API-key stack — the console's session is
  itself an API key with `*` scope, hidden from the user-visible
  list.
- Calls every endpoint we already ship. No new API surface.
- Talks to the same `/openapi.json` for type generation (gen-on-CI).

**Borrow from.**
`reference_repos/home-app/apps/web` for the Cloudflare-Worker-
hosted React deploy pattern + their session-cookie middleware
shape.

---

## 3. Production deploy, status page, on-call rotation

**What.** Promote dev → prod. Stand up:

- A real prod Cloudflare account (separate from dev for blast-radius).
- `api.textral.dev` (or `.com`) DNS + custom domain on the Worker.
- All Phase 8 sign-off items completed against the prod env.
- A status page at `status.textral.dev` (Cloudflare's managed
  Status Pages or `statuspage.io`). Wired to the four MVP alerts.
- External uptime probes (Uptime Robot or BetterStack on the
  free tier) hitting `/healthz` + a synthetic query path.
- A documented on-call rotation (even if it's one person to start)
  with PagerDuty / Slack alert routing.

**Why it matters.** No enterprise tenant signs without a status
page and an SLA conversation. "We have one, in dev" doesn't ship.

**Scope.** ~1 week.

**Borrow from.** Most of `docs/runbooks/DEPLOY.md` is already
written; this is execution.

---

## 4. Stripe metering + plan gating

**What.** Wire `usage_records` to Stripe metered billing:

- Free tier: N queries/month, M MB ingested.
- Paid tiers (`Starter`, `Pro`, `Enterprise`) with progressively
  higher caps and discounted per-call rates beyond the cap.
- A Stripe webhook handler that updates `tenants.plan` on
  subscription changes.
- A daily cron that posts metered usage to Stripe usage records
  (per Stripe's metered-billing API).
- Plan-aware rate limits at request time (today the only limit is
  on admin batch endpoints; need it on `/v1/query` and
  `/v1/documents/*/ingest` too).

**Why it matters.** Without billing wiring, you can't monetize.
Even free-tier customers need plan gating to prevent abuse.

**Scope.** ~2 weeks.

- New `apps/api/src/services/stripe.ts`.
- New `tenants.plan` + `tenants.stripe_customer_id` columns.
- New `webhooks/stripe.ts` route.
- New `tools/billing/post-usage.ts` cron (or a Cloudflare Worker
  scheduled handler).
- A docs page + admin-console section for "Manage subscription"
  redirecting to Stripe's customer portal.

**Borrow from.** Cost reconciliation script
(`tools/billing/reconcile.ts`) already pulls the numbers; this is
just pushing them to Stripe.

---

## 5. Reference applications

**What.** Two or three small, polished applications consuming
Textral end-to-end. Concrete suggestions:

- **"DocsBot"** — a chat widget tenants embed on their own static
  docs site. Indexes their docs nightly via Textral, answers
  visitor questions inline, with citations linked back. ~600
  lines.
- **"Lease Lens"** — a single-page web app where a user uploads a
  lease PDF, gets a structured extraction (rent, term, deposit,
  termination clauses, notice periods) via Textral's `legal`
  profile + structured-output mode. Shows the audit trail.
- **"Slack RAG"** — a Slack bot that ingests a configured set of
  Notion / Google Drive folders and answers questions in a
  designated channel.

Hosted live at `examples.textral.dev/docsbot`, etc., with the
source code on GitHub under `examples/` in this repo.

**Why it matters.** Concrete examples drive adoption far better
than feature lists. A first-time evaluator who sees "DocsBot in
one screenshot, deployed in 5 min" converts at a higher rate than
one reading docs cold.

**Scope.** ~1 week per example, ideally with a contract designer
for visual polish.

---

## 6. Document format support beyond markdown

**What.** Extend the `normalize` ingestion stage to handle:

- PDF (text extraction + table preservation; consider `pdf-parse`
  in the Container or Cloudflare's PDF API)
- DOCX / DOC (via `mammoth` in the Container)
- HTML (via `cheerio` + readability extraction)
- Plain text variants (.txt, .csv preview)
- Image OCR (Cloudflare Workers AI vision model — gated behind a
  per-tenant "OCR enabled" flag; expensive)

**Why it matters.** Today only `text/plain` and `text/markdown`
work cleanly. Most enterprise content is PDF + Office. Without
this, every prospect with a real corpus has to pre-process before
ingesting.

**Scope.** ~1.5 weeks. Each format is a new normalizer in
`apps/ingest/app/normalizers/`.

**Trap to avoid.** Don't try to do layout-preserving PDF parsing
yourself; either use a managed service (AWS Textract, Cloudflare
Workers AI) or accept that text extraction is sufficient for v1
of each format. Ship coverage, not perfection.

---

## 7. Official TypeScript + Python SDKs

**What.** Two real client libraries:

- `@textral/sdk` — npm-published, generated from `/openapi.json`
  via `openapi-typescript` + a thin retries/streaming/error-class
  wrapper. Full streaming SSE support typed end-to-end.
- `textral-sdk` (PyPI) — same surface in Python. Generated from
  the same OpenAPI spec via `openapi-python-client`.

Both publish on every API release with semver gates.

**Why it matters.** Code samples in docs are great for first
impressions but real integration uses an SDK. SDK availability is
a checkbox on every "should we use Textral?" comparison.

**Scope.** ~1 week for the TS SDK + ~3 days for the Python one.
The hard part is keeping them in sync; the OpenAPI generator does
the work if we keep the spec clean.

**Borrow from.** `packages/eval-cli/` already shows the
single-package layout; expand into a more polished SDK shape.

---

## 8. Webhooks for ingestion + eval lifecycle events

**What.** Tenants register a webhook URL + events of interest:

- `job.completed` / `job.failed` / `job.dead_lettered`
- `eval_run.completed`
- `version_index.ready`
- `usage.daily_rollup` (post-day)

Worker delivers HMAC-signed POSTs with retry policy (exp backoff,
dead-letter after N tries). Admin console shows recent deliveries
+ failures + replay button.

**Why it matters.** Today the only way to know an ingestion
finished is to poll. Real integrations want push semantics — the
tenant's pipeline reacts to events without N polling clients
hammering the API. Also, webhooks are the natural extension point
for downstream features (Slack notifications, Datadog events,
custom workflows).

**Scope.** ~1.5 weeks. New `tenant_webhooks` table; a fanout
publisher in the queue handler; a delivery worker; the admin
console page.

---

## 9. GDPR / SOC 2 readiness + tenant data-deletion

**What.** A bundle of compliance work that is not optional for
any B2B sale beyond ~30 employees:

- A tenant-facing **data deletion** endpoint (`DELETE /v1/tenants/me/data`)
  that wipes every D1 row, every R2 object, and every Vectorize
  vector for that tenant. Async (queue-driven), idempotent,
  audited.
- A **data export** endpoint that returns a downloadable archive
  of every record (GDPR Article 20 portability).
- Configurable **data-retention windows** per tenant (default
  unlimited; let enterprise tenants pin `query_events` /
  `ingest_stage_attempts` to a window).
- A SOC 2 Type 1 readiness checklist (encryption at rest, access
  logging, secret rotation policy, employee-access boundaries,
  vendor list). Don't pursue Type 2 yet — too expensive.
- A privacy policy and terms of service drafted by counsel.

**Why it matters.** Enterprise procurement asks for these on day
one. Without them, deals stall in legal review for months.

**Scope.** ~2 weeks engineering + an external audit consult.

---

## 10. Multi-region / data residency

**What.** Per-tenant region pinning for data-residency-sensitive
customers:

- A `tenants.region` column (`us`, `eu`, `apac`).
- Region-pinned D1 databases (Cloudflare D1 supports
  primary-region selection at create time).
- Region-pinned R2 buckets (R2 jurisdiction is configurable).
- Region-pinned Vectorize indexes (one per region).
- Worker routes requests to the correct region based on the
  authenticated tenant.

**Why it matters.** EU customers cannot use US-only services
(GDPR). APAC customers care less but the differentiation matters
for enterprise sales. Cloudflare's edge fronts everything but the
data plane (D1, R2, Vectorize) is regional.

**Scope.** ~3 weeks. The hard part isn't the bindings — it's the
deploy story (one Worker that knows all three regions vs three
deploys with a routing Worker in front).

**Defer until.** First EU enterprise prospect asks. Until then,
a single `us` region is fine.

---

## Honorable mentions (not in top 10 but on the list)

- **Tenant-scoped corpus profile overrides.** Phase 5 deferral.
  Ship a `tenant_corpus_overrides` D1 table when the first tenant
  asks. Lower priority than admin console.
- **Audit log endpoint** for who-did-what within a tenant
  (`/v1/audit-events`). Subset of compliance work.
- **Ecosystem corpus profiles.** Pre-built profiles for Notion /
  Slack / Confluence / Stripe-docs / GitHub-issues etc. Sells
  itself once you have a few.
- **Public eval benchmarks** comparing Textral to LangChain RAG +
  OpenAI Assistants + Pinecone Assistant. Drives evaluation-stage
  conversion.
- **Vector store portability** (Qdrant, Pinecone). Already 90%
  abstracted via `VectorStore` interface from the post-Phase-5
  audit.
- **Streaming + token-usage in admin console** for live debugging.
- **Cost-attribution per query** in `query_events` actually populated
  (today the `total_cost_usd_micros` column is `null`).
- **Workers AI-tier price math** — surface "what would this query
  cost on the no-key tier vs your BYOK?" in the admin console.

---

## Sequencing recommendation

If forced to pick a 6-month order:

1. **Month 1:** prod deploy (#3) + landing page MVP (#1) — get a
   public URL where strangers can sign up.
2. **Month 2:** admin console (#2) — give signups something to
   come back to.
3. **Month 3:** Stripe wiring (#4) — start charging.
4. **Month 4:** PDF + DOCX support (#6) + reference apps (#5) —
   widen the addressable market.
5. **Month 5:** SDKs (#7) + webhooks (#8) — make integrations
   land in days, not weeks.
6. **Month 6:** GDPR / compliance (#9) — unlock enterprise
   pipeline.

Multi-region (#10) waits for the first qualified EU prospect.

The first three months are the make-or-break period: customer
acquisition, retention, monetization. Everything else compounds
on those.
