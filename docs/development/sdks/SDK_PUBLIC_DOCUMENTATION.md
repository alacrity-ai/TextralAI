# SDK Public Documentation Plan

> Where and how the `@textral/sdk` (Node) and `textral` (Python)
> SDKs are documented for outside consumers. Frames the decision
> "Scalar code-sample tabs vs dedicated SDK docs site"; recommends
> a hybrid that keeps Scalar as the single front door.

**Status:** draft — pending review. Targets pre-1.0 release of
`@textral/sdk@0.2.0` + `textral==0.2.0`.

---

## 1. The question

We have two production SDKs at version 0.2.0:

- `@textral/sdk` — TypeScript, ships on npm
- `textral` — Python, ships on PyPI (account pending)

We have one public API documentation surface today: Scalar at
`/docs` (mounted in `apps/api/src/routes/docs.ts`), rendering an
OpenAPI 3.1 spec auto-generated from `@textral/contracts`.

The question: **where do the SDKs live in our documentation
story?**

Two extremes. Each makes some sense in isolation.

**Extreme A — "SDKs are first-class inside Scalar."** Every API
reference operation grows an `x-codeSamples` tab for Node and
Python. The user reading "POST /v1/query" sees curl, Node SDK,
and Python SDK side-by-side without leaving the endpoint page.
The README content gets surfaced alongside the reference as
prose pages.

**Extreme B — "SDKs get their own docs site."** Like Stripe.
Separate domain, separate IA, separate brand surface for the
SDKs. Scalar stays focused on the wire-level reference.

The right answer is a hybrid that leans hard toward A. This
document lays out why and the concrete plan.

---

## 2. The funnel — where do consumers actually land?

A consumer looking at Textral has two distinct journeys:

**Journey 1 — Evaluator → integrator.** Lands on
`textral.alacrity.ai`, clicks "API docs," ends up on `/docs`,
explores endpoints, decides whether to integrate. The CTA from
the marketing site already points to Scalar. Adding a separate
docs URL fragments the journey.

**Journey 2 — Already integrating.** Looks up "how do I do X
with the Textral SDK?" via Google. The result has to be
indexable, deep-linkable, and resolve fast. Either Scalar or a
separate site can do this; what matters is that one URL is
canonical (no SEO competition between two sources).

**Journey 3 — Already integrated, hits a problem.** Knows the
SDK has retry / profiles / streaming / etc.; needs the precise
shape of the relevant API. The README on npm/PyPI is enough for
~80% of these; the Scalar reference covers the rest.

The failure mode we need to avoid: the user lands on Scalar,
sees only curl examples, leaves to find SDK docs elsewhere, and
doesn't come back. Or — worse — finds two pieces of conflicting
information across two doc surfaces and stops trusting either.

**One front door. Scalar.** This is the recommendation.

---

## 3. Two genres of SDK content (and where each belongs)

Critically, "SDK documentation" is not one thing. There are two
genres, and they want different homes:

### Genre A — Per-endpoint invocation samples

> "How do I call POST /v1/query from Node?"

These belong **inside the API reference, as another tab next to
curl.** Today's `apps/api/src/openapi/code-samples.ts` has 13
flagship endpoints with curl + TS-fetch + Python-requests
samples. We replace the raw-`fetch` and raw-`requests` samples
with **idiomatic SDK calls**, keeping curl as the no-deps option.

Tabs for every operation that has a sample today:

```
[ curl ]  [ Node (@textral/sdk) ]  [ Python (textral) ]
```

This is the Scalar pattern Stripe / Linear / OpenAI / Vercel
/ Anthropic all use. Users exploring the API never leave the
endpoint page; they pick their language and see idiomatic code.

### Genre B — Cross-cutting SDK concepts

> "How does the retry policy work? How does ~/.textral/profiles.toml
> resolve? How do I cancel a streaming query? What's in the
> `bulk_ingest_orchestrate` helper?"

These don't map to one endpoint. They describe the SDK as
software: shape of the client, error hierarchy, async patterns,
config precedence. Today they live in the package READMEs
(`packages/sdk/README.md` ~250 lines, `packages/sdk-python/README.md`
~270 lines). Those READMEs are the canonical source — they're
what npm and PyPI display, they're what `pip install -e . && python -c
"import textral; help(textral)"`-style discovery surfaces.

These belong **alongside the API reference in Scalar, as
dedicated SDK pages**, *not* inside individual operation
descriptions.

Scalar supports this via `x-tagGroups` + tag descriptions: an
"SDKs" tag group with two members ("Node SDK" and "Python SDK"),
each rendered from a markdown description that matches the
README. No separate site, no second IA to maintain, no brand
divergence.

---

## 4. The recommendation

**Single docs surface: Scalar at `/docs`.** Extend it along two
axes:

1. **Idiomatic SDK code samples on every operation that has
   samples today.** Replace the raw-`fetch` / raw-`requests`
   samples with `@textral/sdk` and `textral` calls. Keep curl.
   ~13 flagship ops × 2 SDK tabs = 26 new sample blocks.

2. **An "SDKs" tag group with two pages: Node SDK and Python
   SDK.** Each page is a Scalar-rendered version of the
   package's README, plus links to the cookbook scripts. No
   duplication: the README is the source; the Scalar page is a
   rendering of it.

The repo READMEs remain canonical (npm/PyPI display them, repo
visitors read them, the `view source` button on Scalar's SDK
pages links back to them). Scalar pages and READMEs are kept in
sync via a build step (§7).

### Why not a separate docs site?

- **One product to maintain.** A second site means a second
  hostname, a second deploy pipeline, a second analytics
  property, a second SEO surface. We're a small team; that
  overhead doesn't pay back at our scale.
- **No content gap.** Scalar already supports rich markdown for
  tag descriptions, the operation reference is auto-generated
  from contracts, and the `x-codeSamples` slot is purpose-built
  for what we want. There's no feature missing that a separate
  site would unlock.
- **Cohesion.** A dev exploring `POST /v1/query` and a dev
  reading "how does retry work" are often the same person 30
  seconds apart. One URL, one search bar, one auth field.
- **The case for a separate site reappears later** — see §10.

### Why not just READMEs and skip Scalar SDK pages?

- READMEs are great but they only show up to readers who
  already navigated to the package on npm/PyPI. Scalar visitors
  arrive via `/docs`; they need to discover the SDKs as part of
  the API exploration story.
- An "SDKs" tag group makes the SDKs visible to journey-1
  evaluators ("does this product have a real SDK or just curl?")
  in the same scan as the rest of the API.
- Per-endpoint samples (which are the bulk of the value) need
  the Scalar-side machinery anyway — adding the SDK pages on top
  is incremental.

### Why not just Scalar samples and skip dedicated SDK pages?

- Per-endpoint samples can't carry cross-cutting concepts. The
  retry policy, profile resolution, streaming patterns, and
  bulk orchestrator span multiple endpoints by design; they need
  prose alongside the reference.
- Without dedicated pages, the user sees `client.query(...)` in a
  Scalar tab and has nowhere on `/docs` to learn what `client` is,
  how `RetryPolicy` works, or how to set up profiles.

The hybrid is genuinely the right shape.

---

## 5. What changes — concrete deliverables

### 5.1 `code-samples.ts` upgrade

For every entry in `apps/api/src/openapi/code-samples.ts`, replace:

```ts
{ lang: 'js',     label: 'TypeScript (fetch)',     source: '...' },
{ lang: 'python', label: 'Python (requests)',      source: '...' },
```

with:

```ts
{ lang: 'js',     label: 'Node (@textral/sdk)',    source: '...' },
{ lang: 'python', label: 'Python (textral)',       source: '...' },
```

Keep curl unchanged. Estimated effort: ~4 hours to rewrite all
13 flagship samples. Sample for `POST /v1/query`:

```ts
// Node
import { TextralClient } from '@textral/sdk';

const client = new TextralClient({ profile: 'hosted-prod' });
const r = await client.query({
  namespace: 'docs',
  query: 'What survived the Library of Alexandria?',
  embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536 },
  inference:  { provider: 'openai', model: 'gpt-4o-mini' },
});
console.log(r.answer);
```

```python
# Python
from textral import Client

with Client(profile="hosted-prod") as client:
    r = client.query(
        namespace="docs",
        query="What survived the Library of Alexandria?",
        embedding={"provider": "openai", "model": "text-embedding-3-large", "dimensions": 1536},
        inference={"provider": "openai", "model": "gpt-4o-mini"},
    )
    print(r["answer"])
```

Streaming gets a fourth tab on `POST /v1/query?stream=sse` because
the SDK call shape is different (`AsyncClient.query.stream(...)`
in Python; `client.query.stream(...)` in TS).

### 5.2 SDK tag group in Scalar

Add to the OpenAPI spec at registration time:

```ts
spec['x-tagGroups'] = [
  { name: 'Get started', tags: ['Meta'] },
  { name: 'Core flow',   tags: ['Namespaces', 'Documents', 'Ingestion', 'Query'] },
  { name: 'Eval',        tags: ['Eval'] },
  { name: 'Admin',       tags: ['Admin', 'Tenancy'] },
  { name: 'SDKs',        tags: ['SDK · Node', 'SDK · Python'] },  // new
];
```

Each new tag has a `description` that's the README content piped
through. Tag rendering in Scalar gives the README a 100% width
prose page in the sidebar, deep-linkable, with the `info`-style
chrome. (Validated: Scalar renders tag-level markdown
descriptions; the Recipes section in the existing enhancement
plan uses the same mechanism.)

### 5.3 SDK pages (one per language)

Each page is the README, mostly. With three additions specific
to the docs context:

- **Top-of-page Try-It nudge** — link to the operation reference
  for the most common starting point (`POST /v1/query`), so the
  reader can click into the API ref one tab over without leaving.
- **Cookbook callout** — link to the 7 examples in
  `packages/sdk/examples/` (Node) or `packages/sdk-python/examples/`
  (Python). The cookbook scripts are runnable code; the docs
  page describes what each one demonstrates.
- **Versioning callout** — current version + lockstep with
  contracts. Auto-injected from the package version at build
  time so it stays current.

### 5.4 Build pipeline

The Scalar pages should not drift from the READMEs. Two options:

**Option A (preferred): one source of truth — repo README; build
step transcludes into the OpenAPI spec at render time.**

```ts
// apps/api/src/openapi/sdk-pages.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function buildSdkTagDescriptions() {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  return {
    'SDK · Node':   readFileSync(`${root}/packages/sdk/README.md`, 'utf8'),
    'SDK · Python': readFileSync(`${root}/packages/sdk-python/README.md`, 'utf8'),
  };
}
```

The `applyTagDescriptions()` helper merges these into the spec at
render time. README updates → next deploy → docs reflect them.
No duplication, no sync drift.

**Option B: copy via CI.** Cron job + commit on README change.
Worse: extra moving parts for a problem option A solves with one
read.

Going with A.

### 5.5 Scalar-side adjustments

The current `hiddenClients` config in `apps/api/src/routes/docs.ts`
hides csharp/java/php/ruby/go but keeps curl, JS, Python visible
in the Try-It panel. This is fine — `hiddenClients` controls the
generic Try-It client snippets; `x-codeSamples` is a separate
mechanism that shows whatever we provide. Both can coexist.

Confirm in testing: the SDK code-sample tabs render alongside
Scalar's auto-generated curl/JS/Python try-it snippets, not in
place of them. (The plan already flags Scalar issue #3689 as a
known gotcha for full-`hiddenClients: true`; we don't use that
shape.)

---

## 6. What does NOT change

- Repo READMEs stay where they are; they remain the canonical
  long-form SDK docs.
- `examples/` directories stay where they are — runnable code,
  not prose.
- `docs/development/sdks/*.md` stay internal — implementation
  plans, design docs, cookbook outline are for us, not consumers.
- The OpenAPI generation pipeline (Zod contracts → spec) is
  untouched.

---

## 7. Implementation plan

Phased so each phase ships value independently. Total effort
estimate: ~2 days of focused work.

### Phase 1 — Code samples (4–6 hours)

- [ ] Rewrite all entries in `code-samples.ts` to use SDK calls
- [ ] Add streaming sample for `POST /v1/query?stream=sse`
- [ ] Add bulk-orchestrator sample for `POST /v1/ingest/bulk`
  (showing the helper, not the raw three-step dance)
- [ ] Verify rendering in dev — every flagship op shows
  `[ curl ] [ Node ] [ Python ]` tabs

### Phase 2 — SDK pages (4–6 hours)

- [ ] `apps/api/src/openapi/sdk-pages.ts` — README transclusion
  helper
- [ ] Add `SDK · Node` and `SDK · Python` tags to the spec with
  README content as descriptions
- [ ] Add the `SDKs` tag group to `x-tagGroups`
- [ ] Test that markdown renders correctly (code blocks, tables,
  links, anchors) — Scalar's markdown parser is stricter than
  GitHub's in a few spots

### Phase 3 — Polish (2–4 hours)

- [ ] Top-of-page Try-It nudge in each SDK page
- [ ] Cookbook callout linking to examples (relative paths to
  GitHub blobs work — the README already has these)
- [ ] Auto-injected version from `package.json` / `_version.py`
- [ ] Update `SCALAR_DOCS_ENHANCEMENT_PLAN.md` to mark §10 (code
  samples future work) as done

### Phase 4 — Discovery (2 hours)

- [ ] Marketing site CTA: add SDK install commands above the
  fold or near "API docs" link
- [ ] Add `npm install @textral/sdk` and `pip install textral`
  to the docs landing page (`info.description`)
- [ ] Update tag descriptions for `Query`, `Documents`,
  `Ingestion` to mention "see also: SDK pages"

### Phase 5 (optional, post-launch)

- [ ] Per-language search filtering — Scalar's search supports
  facets; consider scoping search to one SDK
- [ ] Type signatures inline in operation reference for the
  request/response when the SDK exposes typed shapes
- [ ] Migration-guide pages for 1.0 release (separate from this
  plan)

---

## 8. README ↔ Scalar drift policy

Single source of truth: the package READMEs (`packages/sdk/README.md`,
`packages/sdk-python/README.md`). The Scalar build reads them at
render time; no copy in a third place.

Implications:

- README updates surface in `/docs` on next deploy
- README format is constrained by what Scalar renders (a small
  subset of CommonMark differences exist; verified at Phase 2)
- README tone targets npm/PyPI consumers; Scalar pages inherit
  that tone — no need to rewrite for a different audience

Tradeoff: README sections that don't make sense in `/docs` (e.g.
"Versioning" referring to the GitHub plan link) still appear.
Acceptable; the cost of a sync mechanism outweighs the cost of
those sections.

---

## 9. Cookbook treatment

Per Outline §1, each SDK has 7 cookbook scripts (`01-quick-start`
through `07-paginate-events`). These are runnable code, not
prose. We do **not** lift them into Scalar pages.

Instead:

- Each SDK page in Scalar has a "Cookbook" section with a list
  of the 7 scripts and one-line descriptions (already present in
  `examples/README.md` of each package)
- Each list entry links to the GitHub source
  (`https://github.com/.../packages/sdk/examples/01-quick-start.ts`)

Why not lift them in?

- They evolve with the SDK; embedding stale snapshots in docs is
  worse than linking to the source of truth
- They're often >50 lines each; that's not docs-page material
- Reading them in their natural form (a `.ts` or `.py` file with
  syntax highlighting on GitHub) is the right rendering

If a particular cookbook script becomes a tutorial-grade
walkthrough later (e.g. "build a RAG-powered Discord bot in 50
lines"), that warrants its own Scalar page — but treat it as a
case-by-case promotion, not a default.

---

## 10. When to reconsider — the "separate site" trigger conditions

The recommendation here is "stay in Scalar" for the next 12
months. We move to a separate docs site when ≥2 of the
following are true:

- **More than 2 SDKs** (Go, Ruby, .NET, etc.). The "[ curl ] [
  Node ] [ Python ]" tab pattern stays clean at 2; gets cluttered
  at 4+.
- **Migration guides for breaking releases.** A 1.x → 2.x guide
  is dozens of pages; cluttering Scalar with that content
  drowns the API reference.
- **A developer relations team or full-time docs writer.** They
  need a stack that supports versioning, drafts, review
  workflows — Scalar's strength is API ref, not CMS.
- **Versioned docs** (e.g. "docs for SDK 1.x" vs "docs for SDK
  2.x"). Scalar can sort-of do this via multiple specs, but a
  real docs framework (Mintlify / Docusaurus / Vercel docs) is
  built for it.

Until then, Scalar is the right answer. Lower marginal cost per
new SDK, higher cohesion for users, no second product to staff.

---

## 11. Open questions

1. **Scalar markdown fidelity.** Tables and code blocks render
   well; admonitions / callouts / collapsible sections may not.
   Phase 2 should validate; if there are gaps, tighten the
   READMEs to a smaller markdown subset that renders identically
   on GitHub, npm, PyPI, AND Scalar.
2. **Per-page SEO.** Scalar generates anchors for tag headings;
   it's not clear whether `?api=POST-v1-query` style deep-links
   are search-indexable. Worth measuring at Phase 4. If not,
   consider rendering the SDK pages as static HTML alongside
   Scalar (Mintlify-style) — that's a small extra build step.
3. **API docs domain.** Is `/docs` on the API host
   (`api.textral.alacrity.ai/docs`) the long-term home, or do we
   want `docs.textral.alacrity.ai` as a separate hostname for
   marketing-site cohesion? (Out of scope here; flag for the
   deploy runbook.)
4. **Lockstep version display.** When `@textral/contracts` bumps
   minor, all four packages bump in lockstep. Scalar should
   show all four versions on the SDK pages; auto-injected from
   the package files. Whose version is "the version" in the
   header — contracts or the SDK itself? Recommend: SDK's own
   version in the SDK page header; contracts shown as a
   "depends on" line.

---

## 12. TL;DR

- **Make Scalar at `/docs` the single doc surface for now.**
  Don't build a separate site.
- **Replace raw-`fetch` / raw-`requests` samples with
  `@textral/sdk` / `textral` calls** on every flagship endpoint.
  Curl stays as the no-deps tab.
- **Add an "SDKs" tag group** with a Node page and Python page,
  each transcluded from the package README at render time.
- **Repo READMEs stay canonical.** No copy in a third place; no
  sync mechanism.
- **Cookbooks link to GitHub source**, not embedded.
- **Revisit "separate site" when we have more SDKs, migration
  guides, or a dedicated docs hire.**

Implementation: ~2 days. Phases 1–4 ship independently and
deliver value at each step.
