Your plan is strong and directionally correct. It has the right core insight: **Scalar should remain the endpoint reference, but the OpenAPI description/tag/operation metadata should teach the product model and integration flows.** The stated target is exactly right: a stranger lands on `/docs`, understands Textral in about a minute, and can ship working code quickly. 

I would keep the plan, but tighten it in a few places so it does not become a large docs-site project disguised as OpenAPI polish.

## Biggest strengths

Your persona model is useful. The three readers — evaluator, implementer, operator — map cleanly to what the docs need to do: frame the product, walk the integration path, and expose precise operational/reference material. 

The information architecture is also right. Grouping `Tenancy`, `ApiKey`, and `ProviderKey` under onboarding/core; putting namespaces/documents/ingestion under the data plane; and separating query/eval from operations makes the sidebar follow the integration lifecycle rather than the codebase layout. 

The staged rollout is sensible: IA/landing page first, then tag prose/operation cleanup, then code samples/auth preset, then theming/polish, then error catalog as stretch. That sequencing avoids spending time on polish before the conceptual docs exist. 

## Main changes I would make

### 1. Do not hide bootstrap too aggressively if it is part of onboarding

You list `POST /v1/admin/bootstrap` as something to mark `x-internal: true`, but your onboarding persona also needs to understand how tenant/API-key bootstrap works. 

I would distinguish:

```text
public consumer docs:
  explain bootstrap conceptually, but do not encourage normal users to call it

OpenAPI reference:
  hide /v1/admin/bootstrap if it is operator-only

getting-started flow:
  assume the consumer already has a Textral tenant API key
```

If bootstrap is not a customer-facing API, do **not** make it part of the flagship flow. The consumer’s first step should be:

```text
You receive a Textral API key from your workspace/admin/operator.
Then you register provider keys and create namespaces.
```

That keeps the public docs cleaner and avoids exposing deployment/setup machinery as normal onboarding.

### 2. Rephrase “register key → register namespace” flow

Your target flow says “register key → register namespace → upload → ingest → query.” But a consumer typically cannot create their first API key without already being authenticated somehow. 

Better flow:

```text
1. Start with your Textral API key.
2. Register a provider key, unless using Workers AI/no-key defaults.
3. Create a namespace.
4. Register and upload a document.
5. Start ingestion and poll the job.
6. Query the namespace/document.
7. Inspect audit/citations.
```

Then separately:

```text
Admin/operator flow:
  tenant bootstrap
  API key creation/rotation
  admin recovery endpoints
```

This avoids confusing implementers with the control-plane bootstrapping problem.

### 3. Keep `info.description` shorter than 600–800 words if possible

Scalar can render a rich description, but a very long landing page can bury the endpoint reference. Your instinct is correct, but I would aim for **400–600 words** plus two compact code blocks, not 800+ plus two large flagship request bodies.

The docs should frame the product and route the reader, not become the entire guide. Suggested structure:

```text
Hero
Mental model diagram
5-minute quickstart
Core concepts table
Flagship query request
Where to go next
```

Move the full ingest/query mega-bodies to tag descriptions or operation examples. On the landing page, show the smallest useful version.

### 4. Add a “minimal path” and an “advanced path”

Your docs need to avoid making Textral look more complicated than it is. You have a very parameterized API; that is powerful, but intimidating.

Use two tracks:

```text
Minimal RAG path:
  namespace + generic profile
  upload document
  ingest with defaults
  query with defaults

Advanced controlled path:
  BYOK
  corpus profiles
  enrichment passes
  structured output schema
  reranking
  evals
```

This is important. If the first examples all include BYOK, enrichment config, reranking, prompt overrides, and structured output, the service will feel heavy.

### 5. Be careful with auto-populated demo API keys

You say Try-It should work because a demo API key auto-populates. That is attractive, but risky operationally. 

For public docs, I would default to:

```text
placeholder key:
  tx_demo_paste_yours_here

persistAuth:
  true

optional internal/dev docs:
  real read-only demo key
```

A real demo key is fine for a private dev deployment, but I would not ship a write-capable demo key into public docs. If you ever do real demo auth, make it:

```text
read-only
strictly rate-limited
fixture namespace only
no provider-key registration
no ingestion
expires/rotates automatically
```

### 6. Consider moving error catalog out of `info.description`

An error catalog of ~40 codes inside `info.description` will make the landing page huge. Your own plan lists it as D5/stretch; I agree with stretch. 

For MVP docs, include:

```text
Error envelope shape
Top 8 common errors
Link/anchor to full error catalog
```

Then generate the full catalog later.

### 7. Add “Common recipes” as the missing middle layer

You have landing page, tag descriptions, per-operation enrichment, and code samples. I would add a small recipes section inside `info.description` or tag descriptions:

```text
Common recipes:
  Basic document QA
  Legal/lease analysis
  Streaming answer
  Structured JSON answer
  Re-run enrichment after profile changes
  Run an eval set
  Recover a dead-lettered ingestion job
```

These can simply be links to relevant operations/code samples. This helps consumers find flows by intent, not resource name.

### 8. Make “strategy guidance” explicit

Your stated goal includes “different strategies they can use for ingesting and inference,” but the plan mostly focuses on endpoint IA and samples. Add a short “Choosing a strategy” section.

Suggested content:

```text
Ingestion strategy:
  generic profile: fastest, passages only
  legal/support/technical/narrative: enrichment-enabled
  enrichment_only: regenerate artifacts without re-uploading
  embed_only: re-index with a new embedding profile

Query strategy:
  sync query: normal use
  SSE query: interactive UX
  structured output: app workflows
  rerank enabled: better precision, slightly higher latency/cost
  require_citations: default for grounded answers

Model strategy:
  Workers AI/no-key for cheap smoke tests
  BYOK OpenAI/Anthropic for production quality
  smaller models for enrichment passes
  stronger models for synthesis/eval
```

This is the kind of guidance a new consumer cannot infer from OpenAPI alone.

## Things I would remove or defer

### Defer visual polish until content is real

D4 theming is fine, but do not spend much time here. A clean default Scalar theme with better information architecture will beat custom colors with thin docs.

Keep:

```text
metadata title/description
favicon
hidden clients
server list
```

Defer:

```text
OG image
brand palette debates
custom CSS beyond small variables
```

### Defer API-key creation code samples unless the endpoint is truly consumer-facing

If API key creation is admin/operator-only, do not include it in the “top 10 flagship endpoints.” Replace it with:

```text
GET /v1/me or GET /v1/namespaces
```

as the auth sanity-check sample.

### Be cautious with “Admin tag visible”

Visible-but-badged admin endpoints are fine for an authenticated/admin-oriented docs surface. For a public developer docs surface, I would put admin at the bottom and clearly label:

```text
Operator/admin only
Requires admin scope
Not needed for standard integration
```

That matches your plan, but the prose should be explicit so a new user does not think DLQ and bulk enrichment are day-one integration work.

## Suggested final plan shape

I would revise your implementation plan to this:

### D1 — IA + concise landing page

Ship:

```text
x-tagGroups
tag display names
concise info.description
core concepts table
minimal quickstart
common recipes links
auth/security scheme
hide internal/dev-only routes
```

Acceptance: reader can explain Textral and identify the next endpoint.

### D2 — Core flow docs

Prioritize the flows over all routes:

```text
Provider keys
Namespaces
Documents
Ingestion
Query
Streaming query
Structured output
Eval
```

Add tag descriptions and operation descriptions only for these first.

### D3 — Code samples for flagship flows

Do fewer than 10 if necessary, but make them excellent:

```text
auth sanity check
register provider key
create namespace
register/upload/ingest document
poll ingestion job
sync query
streaming query
structured-output query
eval set + run
DLQ retry
```

Curl + TypeScript + Python is the right language set. 

### D4 — Operation sweep

Now clean up the rest:

```text
summary consistency
descriptions
examples
badges
admin labeling
error examples
```

### D5 — Polish + error catalog

```text
theme
metadata
hidden clients
OG preview
generated error catalog
outside-reader smoke test
```

This puts conceptual usability before appearance.

## One practical addition: docs regression test

Add a small test that protects the docs from drifting:

```text
/openapi.json contains:
  non-empty info.description > N chars
  x-tagGroups present
  every public operation has operationId
  every public operation has summary
  top flagship operations have x-codeSamples
  no x-internal operation appears in public spec
  every tag has description
```

This is cheap and valuable. You already care about spec completeness; now enforce docs completeness.

## Final assessment

This is a good plan. The most important improvement is to make the docs less “all capabilities at once” and more “minimal path first, advanced controls second.”

I would revise around these principles:

```text
Do not expose bootstrap as normal onboarding.
Start from “you have an API key.”
Show the minimal RAG flow first.
Then show BYOK, enrichment, reranking, structured output, evals.
Keep the landing page compact.
Move exhaustive material into tag descriptions and examples.
Treat strategy guidance as first-class.
```

Once those changes are made, this plan should get you to the “canonical docs” you want: not just Scalar endpoint coverage, but a self-serve integration guide for real consumers.
