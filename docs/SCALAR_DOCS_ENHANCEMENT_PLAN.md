# Scalar Docs Enhancement Plan

> Plan for elevating `/docs` (Scalar-rendered) and `/openapi.json`
> from a serviceable spec dump into a self-serve developer surface
> a stranger can land on, understand in ~60 seconds, and ship
> working code from in ~10 minutes — without forcing all of
> Textral's parameterization on them at once.
>
> **Revised** to integrate `SCALAR_DOCS_ENHANCEMENT_PLAN_FEEDBACK.md`.
> Eight changes folded in: bootstrap is *not* normal onboarding;
> the canonical flow starts at "you have an API key"; the landing
> page targets 400–600 words; minimal-RAG path leads, advanced
> controls follow; demo auth uses a placeholder, not a real key;
> error catalog is stretch (D5), not landing-page material;
> Common Recipes + Choosing a Strategy added as first-class
> sections; visual polish deferred behind content.

---

## 1. Current state + gap

`apps/api/src/routes/docs.ts` mounts an OpenAPI 3.1 spec at
`/openapi.json` and Scalar UI at `/docs`. Today:

- `info.description` is one sentence.
- 8 tags in use (`Admin`, `Documents`, `Eval`, `Ingestion`, `Meta`,
  `Namespaces`, `Query`, `Tenancy`) — flat sidebar.
- Per-operation `summary`+`description` quality varies; no
  `x-codeSamples`, no multiple examples, no badges.
- No auth preset; the Try-It button starts empty every time.
- No theming beyond the Scalar `default` theme.
- Internal HMAC back-channel is correctly excluded (separate Hono
  app), but `/v1/admin/bootstrap` is in the public spec where it
  shouldn't be.

A reader landing on `/docs` today sees a tagged, undifferentiated
list of 50+ endpoints with no narrative. The reader has to derive
the integration story from operation names alone.

## 2. Target state

A consumer can:

1. Land on `/docs`, read 400-ish words, understand what Textral is
   and the canonical flow.
2. Hit "Try It" on `GET /v1/me` 30 seconds later as a sanity check
   (the auth field is pre-filled with a placeholder; they paste
   their key once and it persists).
3. Find "I want to do X" by intent — via a **Common Recipes** card
   that links to the operations and the realistic code samples.
4. Pick the **right ingestion strategy** before they call `/ingest`,
   because there's a "Choosing a Strategy" section that tells them
   when to use generic vs narrative vs legal, when `embed_only`
   beats `full`, when to skip enrichment.
5. See a code sample in the language they actually use — curl,
   TypeScript, or Python.
6. Recognize that `Admin` endpoints are operator-only, not part of
   their day-one integration work.

---

## 3. Audiences (3 personas)

### Persona A — First-time evaluator

Considering Textral for a real project. Spends ≤5 min deciding
whether to keep reading. Needs the product framed before any
endpoint appears.

### Persona B — Implementer (highest priority for execution)

Has an API key, wants working code today. Walks the canonical
flow. Cares about code samples + recipes + strategy guidance.

### Persona C — Operator

Has a runbook in another tab. Wants the precise endpoint /
request shape / error code. Cares about the endpoint reference
and the error catalog.

The plan optimizes for B without breaking A or C.

---

## 4. The canonical flow — "you have an API key"

> **Feedback change #1 + #2:** bootstrap is *not* part of the
> public flow. The reader's first step is "you received a Textral
> API key from your workspace admin or operator." Tenant
> bootstrap, API-key creation/rotation, and admin recovery are
> **operator/admin** activities that live in a separate, badged
> section.

Implementer flow, surfaced as the **Quickstart** in the landing
page and as the spine of the per-tag descriptions:

```text
1. Start with your Textral API key.
2. Sanity-check: GET /v1/me (proves the key works).
3. Register a provider key (BYOK), unless you're using the
   Workers AI no-key tier for smoke tests.
4. Create a namespace (pick a corpus profile).
5. Register a document → upload → finalize.
6. Trigger ingestion (mode='full'), poll the job to completion.
7. Query the namespace.
8. Inspect the audit (citations, degradation level, latency).
```

Operator flow, surfaced separately and badged:

```text
- Tenant bootstrap (one-shot, `/v1/admin/bootstrap`, hidden from
  the public spec via `x-internal`)
- API-key creation/rotation
- DLQ inspection + retry
- Bulk enrichment-only runs
```

---

## 5. Minimal vs Advanced — two tracks

> **Feedback change #4:** lead with the minimal RAG path. The
> advanced controls are real and powerful but should never be the
> *first* example a new reader sees, or Textral feels like a
> 50-knob device when 5 knobs would have done.

Both tracks live on the landing page (or as side-by-side examples
on `/v1/query`). The minimal path is the visual default.

### Minimal RAG path (default)

```text
namespace: corpus_profile=generic (passages-only)
document: register + upload + finalize
ingest:   mode='full', defaults
query:    POST /v1/query with the canonical body shape
```

Five fields in the request body. No BYOK if Workers AI is enough.
No reranking. No structured output. No streaming. Just retrieval
+ synthesis with citations.

### Advanced controlled path (when you need it)

```text
namespace: pick a non-generic corpus profile (narrative / legal /
           support / technical) — enables enrichment passes
ingest:   per-pass model overrides, oversize_strategy,
          enrichment_only mode for backfills
query:    rerank.enabled, structured output schema, streaming
          (?stream=sse), per-layer context budgets
operate:  DLQ retry, bulk enrichment-only admin endpoint, eval
          sets for regression gating
```

Each advanced feature gets a one-paragraph mention in the relevant
tag description, *not* the landing page.

---

## 6. Information architecture

### Sidebar groups (`x-tagGroups`)

| Group | Tags | Audience |
|-------|------|----------|
| **Get started** | `Meta` (health, /me only) | Anyone |
| **Core integration** | `ProviderKey`, `Namespaces`, `Documents`, `Ingestion`, `Query`, `Eval` | Persona B (the spine) |
| **Operations** | `Admin` | Persona C (badged, not day-one) |
| **Tenancy & keys** | `Tenancy`, `ApiKey` | Persona C (operator/admin only) |

`tagsSorter: 'alpha'` within each group; the group order itself is
the integration order.

### Tag display rename via `x-displayName`

| Internal | Public name |
|----------|-------------|
| `ApiKey` | API Keys (admin) |
| `ProviderKey` | Provider Keys (BYOK) |
| `Eval` | Evaluations |
| `Meta` | Reference & Debug |
| `Tenancy` | Tenancy (admin) |

### Hidden surfaces

- `POST /v1/admin/bootstrap` → `x-internal: true` (not normal
  onboarding; explained conceptually in tag description for
  operators only).
- `GET /__redaction_check` (dev-only, already 404s in prod) →
  `x-internal: true`.
- `/internal/*` (HMAC back-channel) → already on a non-OpenAPI
  Hono sub-app; stays excluded.

---

## 7. Landing page — `info.description`

> **Feedback change #3:** target 400–600 words + small code
> blocks, not 800+ with mega-bodies. Move long examples to per-tag
> descriptions and operation `examples`.

### Section outline

```text
1. Hero (≤2 sentences; what Textral is)
2. Mental model (1 paragraph: tenant → namespace → docs → query)
3. 5-minute Quickstart (4 short curl commands)
4. Core concepts (compact table; 5 rows)
5. Common Recipes (links by intent)         ← feedback #7
6. Choosing a Strategy (compact tables)     ← feedback #8
7. Failure semantics (compact table)
8. Error envelope + top 8 errors (link to full catalog as D5)
9. Where to go next (links)
```

Total target: ~500 words + small fenced blocks.

### Section 7.5 — Common Recipes (links by intent)

A bulleted list, each item is "I want to ..." → operation pointer.

```text
- Basic document QA → POST /v1/namespaces (corpus_profile=generic)
                      + POST /v1/query
- Streaming answer → POST /v1/query?stream=sse
- Structured JSON answer → POST /v1/query (output.mode='structured')
- Re-run enrichment after a profile change →
    POST /v1/admin/namespaces/:slug/enrichment-runs (admin)
- Run an eval set → POST /v1/namespaces/:slug/eval-sets/:id/runs
- Recover a dead-lettered ingestion job →
    GET /v1/admin/ingestion-jobs?dead_lettered=1
    POST /v1/ingestion-jobs/:id/retry
- Inspect a query post-hoc → GET /v1/query-events/:id
- Re-embed under a new model → POST /v1/documents/:id/ingest
                                with mode='embed_only'
```

### Section 7.6 — Choosing a Strategy (3 compact tables)

**Ingestion**

| Goal | Choice |
|------|--------|
| Fastest, passages only | `corpus_profile=generic`, `mode='full'` |
| Narrative documents (characters, themes) | `narrative` profile, `mode='full'` |
| Legal documents (clauses, obligations) | `legal` profile, `mode='full'` |
| Backfill enrichment without re-uploading | existing version, `mode='enrichment_only'` |
| Re-index under a new embedding model | new version_index, `mode='embed_only'` |

**Query**

| Need | Choice |
|------|--------|
| Normal QA | `POST /v1/query` |
| Interactive UX (token-by-token) | append `?stream=sse` |
| Programmatic JSON output | `output.mode='structured'` + schema |
| Higher precision (more cost / latency) | `retrieval.rerank.enabled=true` |
| Citation grounded by default | already on; `audit.citation_integrity` |

**Model**

| Need | Choice |
|------|--------|
| Cheap smoke test | Workers AI no-key tier |
| Production quality | OpenAI / Anthropic BYOK |
| Smaller model for enrichment passes | per-pass `model:` override in profile YAML or request |
| Stronger model for synthesis | `inference.model` in `/v1/query` body |

These are exactly the strategy decisions a new reader cannot infer
from the OpenAPI alone. Three short tables earn their landing-page
real estate.

---

## 8. Per-tag descriptions

Each tag in scope gets a markdown block (~150–250 words) above the
operation list. Priority order matches the canonical-flow spine.

### D2 priority (ship first)

| Tag | Tag description covers |
|-----|------------------------|
| `ProviderKey` | Supported providers + capabilities table; the `label` convention; `provider_key_ref` resolution; what happens when a key is revoked upstream |
| `Namespaces` | What a namespace is; the five corpus profiles + when to pick each; request-override merge rules (arrays replace, scalars override) |
| `Documents` | Lifecycle: register → upload → finalize → ingest; content-hash dedup; version semantics; the R2 layout convention |
| `Ingestion` | The 6 stages; what `mode` selects; how to poll a job; per-stage attempts + idempotency contract |
| `Query` | Hybrid retrieval (Vectorize + FTS5 + RRF); reranker enable flag; structured output mode; streaming variant; citation grounding rules; the `audit` field guarantees |
| `Eval` | Golden sets; three built-in judges; pass-threshold semantics; eval-cli pointer |

### D4 priority (defer)

| Tag | Tag description covers |
|-----|------------------------|
| `ApiKey` | Scopes (`*` / `admin` / `read`); 60-second KV-TTL on revocation; rotation without downtime |
| `Tenancy` | What tenants are; bootstrap-token flow as **operator-only**; rate limits |
| `Admin` | Who has access (admin scope); rate-limit (10/min); when to use DLQ retry vs re-ingest. **Explicitly:** "Operator/admin only — not needed for standard integration." |
| `Meta` | Health endpoint contract; OpenAPI download; dev-only routes that 404 in prod |

---

## 9. Per-operation enrichment

Every operation should carry, populated from Zod schemas where
possible:

- **`summary`** — short imperative ("Register a provider key").
  Audit existing for consistency.
- **`description`** — 1–3 paragraphs of markdown:
  - When you'd call this.
  - Cross-references ("see also: GET /v1/provider-keys").
  - Idempotency notes if any.
  - Failure modes specific to this endpoint (e.g., "returns 409
    `NAMESPACE_ALREADY_EXISTS` if the slug is taken").
- **`examples`** — a realistic example body (the minimal-path
  shape — small) on flagship operations; multiple examples (basic
  + advanced) on `POST /v1/query` and `POST /v1/documents/:id/ingest`.
- **`x-badges`** — `Admin`, `Beta`, `BYOK required` per
  operation's reality.
- **`x-codeSamples`** — see §10 (D3 work).

---

## 10. Code samples — flagship flows

> **Feedback change #2 + the auth-sanity-check:** the canonical
> first sample is `GET /v1/me`, not `POST /v1/api-keys`. API-key
> creation is admin work and gets a sample only as part of the
> admin section.

The hand-crafted set, in priority order:

| # | Operation | Why |
|---|-----------|-----|
| 1 | `GET /v1/me` | Auth sanity check — first thing a new user runs |
| 2 | `POST /v1/provider-keys` | First real action |
| 3 | `POST /v1/namespaces` | Picking a corpus_profile is non-obvious |
| 4 | `POST /v1/namespaces/:slug/documents` | Doc registration |
| 5 | `POST /v1/documents/:id/uploads` | Upload (presign sequence) |
| 6 | `POST /v1/documents/:id/uploads/:upload_id/finalize` | Finalize |
| 7 | `POST /v1/documents/:id/ingest` | Most complex body |
| 8 | `GET /v1/ingestion-jobs/:id` | Poll loop |
| 9 | `POST /v1/query` | Sync query (the flagship) |
| 10 | `POST /v1/query?stream=sse` | Streaming consumer pattern |
| 11 | `POST /v1/query` (structured-output) | The advanced-track variant |
| 12 | `POST /v1/namespaces/:slug/eval-sets` | Eval registration |
| 13 | `POST /v1/namespaces/:slug/eval-sets/:id/runs` | Eval kick-off |
| 14 | `POST /v1/ingestion-jobs/:id/retry` | DLQ recovery (admin section) |

**Languages:** curl (always), TypeScript using `fetch`, Python
using `requests`. Each sample uses `{{TENANT_API_KEY}}` and
`{{WORKER_URL}}` placeholders.

**Storage:** centralized in `apps/api/src/openapi/code-samples.ts`
(a TS map keyed by operationId). A `withCodeSamples(operationId,
config)` helper attaches them at route-registration time. Single
file to update; no markdown sprinkled across 50 routes.

**Future:** when a real `@textral/sdk` ships, demote the raw
`fetch` sample and add an SDK sample.

---

## 11. Authentication & Try-It UX

> **Feedback change #5:** placeholder, not a real demo key. A real
> read-only / fixture-namespace / rate-limited demo key is fine
> for an internal/dev deploy. Public docs ship a placeholder.

```ts
authentication: {
  preferredSecurityScheme: 'ApiKeyAuth',
  securitySchemes: {
    ApiKeyAuth: { value: 'tx_demo_paste_yours_here' },
  },
},
persistAuth: true,
```

The placeholder is visible in the auth field. The user replaces
it once; `persistAuth: true` writes to localStorage so subsequent
visits don't repeat the work. No write-capable demo key in public
docs.

If an internal/dev deploy wants a real demo key, it goes through
its own deploy config; the public-docs build never sees it. (Out
of scope for this plan; flagged for the deploy runbook.)

`servers` array adds env switching: dev / prod / `localhost:8787`
for local wrangler. Try-It sends to whichever the user picks.

---

## 12. Theming & visual polish

> **Feedback change #9:** defer. Ship metadata + favicon + hidden
> clients + server list. Defer OG image / brand palette / custom
> CSS beyond minor variable nudges.

**Ship in D5:**

- `metaData: { title: 'Textral API', description: <short pitch> }`
- `favicon` — inline SVG data URI; placeholder geometric mark.
- `hiddenClients: { csharp: true, java: true, php: true, ruby: true, go: true }`
  — keep curl / fetch / Node / Python.
- `documentDownloadType: 'json'`.
- `searchHotKey: 'k'`.
- `layout: 'modern'`.
- `defaultOpenFirstTag: false`.

**Defer:**

- OG image (needs design input).
- Brand palette / custom CSS (needs a design system to be worth
  doing — the default Scalar `default` theme is already good).
- Per-tenant theming (server-side rendering work; out of scope).

---

## 13. Phased rollout

> **Feedback change:** revised phase shape per feedback's
> "Suggested final plan." Conceptual usability before appearance.

### D1 — IA + concise landing page

- Extend `mountDocs(...)` to accept a richer config (description
  markdown, tagGroups, securitySchemes auth preset, hidden
  clients, server list).
- Author `info.description` markdown (~500 words) per §7.
- `x-tagGroups` per §6.
- `x-displayName` renames per §6.
- Hide bootstrap + dev routes via `x-internal`.
- `authentication.securitySchemes` placeholder + `persistAuth`.

**Acceptance:** an outside reader can land on `/docs`, read the
landing page, and articulate (a) what Textral is and (b) which
endpoint they should call first.

### D2 — Core flow tag descriptions

Tag descriptions for the integration spine only:

```text
ProviderKey, Namespaces, Documents, Ingestion, Query, Eval
```

Plus operation `description` enrichment for those tags' flagship
operations.

**Acceptance:** an outside reader can navigate from the landing
page into the tag they need next, read the tag description, and
know which operation to call without guessing from operation
names.

### D3 — Code samples for flagship flows

- Build `apps/api/src/openapi/code-samples.ts` registry +
  `withCodeSamples()` helper.
- Author 14 samples × 3 languages = 42 hand-crafted snippets per
  §10.
- Verify Try-It auth preset works with samples (the same
  placeholder header).

**Acceptance:** an outside reader can copy a sample, replace the
two placeholder strings, and get a 200 response on the first try
for every flagship endpoint.

### D4 — Operation sweep + admin labeling

- Sweep remaining tags (`ApiKey`, `Tenancy`, `Admin`, `Meta`).
- Tag descriptions per §8 D4 priority.
- Audit `summary` consistency across all 50 ops.
- Add multiple `examples` to `POST /v1/query` and
  `POST /v1/documents/:id/ingest`.
- Explicit "operator/admin only — not needed for standard
  integration" prose in the `Admin` tag description.
- `x-badges` on admin operations.

**Acceptance:** the operation list is complete; no operation is
missing a description; admin endpoints are clearly labeled and
sectioned.

### D5 — Polish + error catalog + regression test

- Light theming polish per §12.
- Generate an error-catalog markdown table from
  `packages/contracts/src/error.ts` — every code, the HTTP status,
  when it fires, the recovery action. Embed as a separate block
  *referenced from* the landing page (top 8 in the landing, full
  table in a follow-on prose section or a separate `/docs/errors`
  pseudo-section).
- **Docs regression test** (per feedback): a vitest test that
  pins:
  - `info.description` length > N chars
  - `x-tagGroups` is present
  - every public operation has a non-empty `operationId`
  - every public operation has a non-empty `summary`
  - flagship operations (the 14 from §10) have `x-codeSamples`
  - no `x-internal: true` operation appears in the output spec
  - every tag in `x-tagGroups` has a non-empty description

This test runs on every PR; the spec can't drift back to the
current state without breaking.

**Acceptance:** an outside reader walking Persona B's flagship
flow against the deployed dev finishes in ≤10 minutes using only
`/docs`.

---

## 14. Out of scope (explicit)

- **Versioned multi-spec switcher.** Add when `/v2` is real.
- **MDX guides system / multi-page docs site.** Scalar's OSS
  component is API-reference only. If the marketing site grows,
  it's a separate Astro/Nextra project mounted at `/guides/*`.
- **AI chat / MCP integration.** Pre-product-market-fit complexity.
- **SEO / SSR.** Scalar renders client-side. If indexable docs
  matter post-launch, add a static-snapshot pipeline.
- **Per-tenant docs branding.** Server-side rendering work.
- **A real TypeScript SDK.** Code samples use `fetch` for now;
  the SDK is its own scoped initiative.
- **OG images / brand palette.** Need design input first.
- **Real demo API key in public docs.** Placeholder only; if a
  read-only demo key is wanted, it's per-deploy config.

---

## 15. Acceptance criteria (summary)

- [ ] An outside reader can land on `/docs` and articulate what
      Textral is in 60 seconds.
- [ ] An outside reader can complete the canonical flow
      (auth-sanity → provider key → namespace → upload → ingest
      → query) in under 10 minutes using only `/docs`.
- [ ] The Try-It button works on first click after the user
      pastes their key once (placeholder + persistAuth verified).
- [ ] All 14 flagship endpoints have hand-crafted code samples
      in curl + TS + Python.
- [ ] `Admin` endpoints are visible-but-badged with explicit
      "operator/admin only" prose; `__redaction_check` and
      `bootstrap` are hidden via `x-internal`.
- [ ] Common Recipes + Choosing a Strategy sections are present
      and copy-perfect.
- [ ] Docs regression test passes (D5) and is wired into CI.
- [ ] No regression on `/openapi.json` consumers — every existing
      operationId still resolves, every existing schema still
      shape-compatible.
- [ ] Visual polish has been touched (metadata + favicon +
      hidden clients) but no time spent on bespoke design.

---

## Appendix — source-of-truth references

- Scalar config surface: `node_modules/.pnpm/@scalar+hono-api-reference@0.10.13_*/dist/types.d.ts`.
- Scalar OpenAPI extensions: `https://github.com/scalar/scalar/blob/main/documentation/openapi.md`.
- `info.description` markdown: GitHub-flavored CommonMark, ~50KB
  practical limit. We're targeting ~5 KB.
- Auth preset persistence: `persistAuth: true` writes to
  localStorage. API-key auth path is reliable; Bearer has known
  issues in 0.10.x (out of scope here).
- `x-codeSamples` wire format: `{ lang, label?, source }[]`.
- `hiddenClients: true` swallows `x-codeSamples` (#3689) — use
  the object form `{ <lang>: true }` to preserve custom samples.

## Appendix — feedback integration log

Eight changes from `SCALAR_DOCS_ENHANCEMENT_PLAN_FEEDBACK.md`:

1. **Bootstrap is not normal onboarding** → `x-internal` on
   `/v1/admin/bootstrap`; explained conceptually in `Tenancy`
   tag description for operators only.
2. **"You have an API key" canonical flow** → `GET /v1/me` is the
   first sample, not `POST /v1/api-keys`. API-key creation is
   admin work.
3. **Compact landing page (400–600 words)** → §7 outline targets
   ~500 words. Mega-bodies move to per-tag descriptions and
   `examples`.
4. **Minimal vs Advanced tracks** → §5; minimal-RAG path leads,
   advanced controls follow.
5. **Placeholder demo key** → `tx_demo_paste_yours_here` +
   `persistAuth`. Real demo keys are per-deploy, not in public
   docs.
6. **Error catalog deferred to D5** → top 8 on the landing page;
   full catalog generated in D5.
7. **Common Recipes section** → §7.5 list-by-intent.
8. **Choosing a Strategy section** → §7.6 three compact tables
   (ingestion / query / model).

Plus the revised phase shape (D1–D5), the docs regression test
(D5), the deferred visual polish, and the explicit admin-labeling
prose.
