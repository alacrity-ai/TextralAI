# Textral Landing Page — High-Level Vision

> **Scope.** This is the planning document for the marketing landing
> page at `textral.alacrity.ai`. It describes audience, messaging,
> information architecture, design direction, SEO strategy, and tech
> stack — not the implementation. Sub-docs (copy deck, design spec,
> implementation guide) will live alongside this in `docs/landingpage/`.

---

## 1. Purpose

`textral.alacrity.ai` is the **product surface**. Today there is no
canonical place a prospective user can land and (a) understand what
Textral is, (b) decide if it solves their problem, and (c) take a
clear next action.

The page exists to do three things, in priority order:

1. **Convert qualified developers** into sandbox users — the closest
   thing we have today to a free trial. Sandbox lets them register a
   tenant and start ingesting in minutes.
2. **Communicate differentiation** so we don't get lost in the
   "managed RAG" noise. The audit-first / MCP-native / dual-deploy
   bundle is unique; the page must lead with it.
3. **Earn organic traffic** through SEO on high-intent keywords
   ("RAG API", "managed RAG", "MCP RAG", "RAG with citations",
   "self-hosted RAG", "vector search platform").

It is **not** a docs site, **not** a blog, **not** a sandbox. Each of
those is a separate surface that this page links to.

## 2. Audience

### Primary ICP — "the agent-era engineer"

- **Role.** Senior software engineer, ML engineer, or technical
  founder building AI-powered products.
- **Stack.** TypeScript or Python; using Claude Code / Cursor /
  similar agent tools; comfortable with REST APIs, MCP, Cloudflare or
  similar edge platforms.
- **Pain.** Building RAG glue is unprofitable plumbing — they want
  hybrid retrieval + reranking + citations + audit out of the box.
- **Decision criteria.** Hosted to start, self-hostable for
  compliance later. Real evals, not vibes. Will their LLM agent be
  able to call it without writing wrappers?

### Secondary — "the compliance-curious engineering lead"

- **Role.** Tech lead at a regulated company (legal, healthcare,
  finance, fintech).
- **Pain.** Wants the convenience of managed RAG but cannot send
  customer data to a single-vendor black box. Needs audit trails,
  needs self-host as a fallback.
- **Decision criteria.** Audit completeness; self-host parity; data
  residency story; vendor portability (dual backend).

### Tertiary — "the data scientist"

- **Role.** Data scientist or applied ML practitioner.
- **Pain.** Existing vector DBs are too low-level; existing managed
  RAG is too opaque. Wants to evaluate retrieval quality
  scientifically.
- **Decision criteria.** Reproducible evals, Python SDK
  (cf. `PYTHON_SDK.md` roadmap doc), retrieval-only mode, metrics.

> **De-prioritized for v1**: non-technical buyers (procurement,
> business analysts, marketing leaders). They read different sites; we
> reach them through a different surface later.

## 3. Hero / Primary Messaging

The hero gets one job: communicate what Textral is in under 4 seconds
and earn the scroll.

### Recommended hero direction (lead with MCP-native)

> **Hosted RAG your AI agent can actually use.**
>
> Hybrid retrieval, audit-first, MCP-native. Run it on Cloudflare or
> self-host on your own infra — same packages, same contracts.

**Why:** MCP-native is the most differentiated *and* most timely
angle. Every prospect using Claude Code / Cursor / agent IDEs in 2026
is wrestling with how to give their agent durable knowledge access.
"Your agent can call this directly" is the most concrete value prop
we can offer right now.

### Alternates to test

| Hook | Lean | When it wins |
|---|---|---|
| "Hosted RAG your AI agent can actually use." | MCP-native | Default — agent-era engineers are the largest segment |
| "RAG with receipts." | Audit-first | Compliance-curious / regulated buyers |
| "Run it yourself, or let us run it." | Self-host parity | Privacy-first / portability-first prospects |
| "The retrieval API your agent should be calling." | Provocative MCP-native | Bolder copy test |

Recommendation: **ship the MCP-native hero**, A/B test against
"RAG with receipts" within the first 30 days once we have traffic.

### Hero CTAs

- **Primary CTA:** "Try the sandbox" → `sandbox.textral.alacrity.ai`
  (or wherever the sandbox lives — TBD per the open questions
  below). Single-click to a working tenant.
- **Secondary CTA:** "View on GitHub" → repo URL. Outbound link with
  a star count if we want to flex social proof.

### Hero visual

The strongest hero visual would be a **live, animated audit trace** —
a real query → embedding → hybrid retrieval → rerank → synthesis with
citations, shown as a flowing pipeline. It demonstrates the product
*and* the audit-first wedge without saying "we have audit logs."

Fallback if that's too much for v1: a **stylized terminal** showing
the 3-line MCP install incantation followed by a Claude Code session
calling Textral. Concrete, copy-paste-able, immediately conveys the
agent-era fit.

## 4. Information Architecture

Single long-form page. Order matters; sections build the case.

```
1. Nav (sticky)
2. Hero  — one-line hook + 2 CTAs + visual
3. Pillars  — 3-4 pillar features, icon + headline + 1 sentence
4. The Audit Story  — the unique wedge, prominently placed
5. Code-First Proof  — real API + MCP examples (copy-paste-able)
6. How It Works  — architecture diagram, hosted+self-host
7. Hosted or Self-Hosted  — the dual-deployment story
8. Compared To…  — table vs. Pinecone Assistant, Vectara, OpenAI File Search
9. Roadmap Snapshot  — signal momentum, link to roadmap docs
10. Pricing Teaser  — see "Open Questions" — pricing strategy not yet decided
11. Final CTA  — sandbox + GitHub
12. Footer
```

### Section-by-section content briefs

#### 2. Hero
- Already covered above. The most important section on the page.

#### 3. Pillars (4 cards)

Each pillar is one icon, a five-word headline, and one
plain-English sentence.

1. **MCP-native by default.** "Your AI agent calls Textral directly,
   no glue code. Multi-profile addressing for stage and prod."
2. **Hybrid retrieval, in the box.** "Dense + BM25 + reranker, with
   per-namespace dim-locking that catches silent failures
   competitors hide."
3. **Audit-first.** "Every query is a forensically-replayable event
   with full retrieval lineage, citation integrity, and dropped-
   citation tracking."
4. **Run it your way.** "Hosted on Cloudflare's edge, or self-host
   on your own infra — same packages, same contracts."

#### 4. The Audit Story (featured section)

This is the section we're famous for if we tell it right.

Show, don't tell. Embed a real `query_event_id` audit object —
trimmed to the fields that matter — alongside narrative copy:

> "When your retrieval silently degrades, you usually find out from a
> user complaint. Textral surfaces it the second it happens. Every
> query returns a `query_event_id` you can replay, with retrieval
> status, citation integrity, dropped citations, and per-arm error
> messages. We built this because we needed it ourselves — and
> shipped a real production fix during onboarding because the audit
> caught a bug nothing else would have."

Real audit JSON snippet (truncated, syntax-highlighted) shown
alongside.

#### 5. Code-First Proof

Three tabs:

- **REST.** A `curl` for `POST /query` with a real response.
- **TypeScript.** `import { Client } from '@textral/sdk'`; ingest +
  query in 6 lines.
- **MCP.** The 1-line `claude mcp add textral` install + a Claude
  Code transcript snippet showing it being used naturally.

Every snippet must be copy-paste-runnable.

#### 6. How It Works

Architecture diagram showing:

- Ingest path: file → chunking → embedding (provider abstraction) →
  vector backend (Vectorize or Pinecone) + FTS5 sparse index
- Query path: query → hybrid retrieval (RRF) → reranker → synthesis
  → audit lineage
- The same diagram annotated with where the customer's data lives
  (their Cloudflare account, or ours, or self-host)

This is the "credibility insurance" section — proves there's real
engineering behind the headlines.

#### 7. Hosted or Self-Hosted

Side-by-side comparison: same packages (`@textral/contracts`,
`@textral/sdk`, `@textral/mcp`), same MCP profile model, two
deployment modes. "Start hosted; move to self-host when compliance
demands it; you're not rewriting anything."

#### 8. Compared To…

Concise comparison table. Honest. Recommended columns:

| | Textral | Pinecone Assistant | Vectara | OpenAI File Search |
|---|---|---|---|---|
| MCP-native | ✓ | ✗ | ✗ | ✗ |
| Hybrid retrieval | ✓ | ✓ | ✓ | partial |
| Audit lineage | ✓ full | partial | partial | minimal |
| Self-hostable | ✓ same package | ✗ | ✗ | ✗ |
| Multi-tenant API | ✓ | per-account | per-account | per-account |
| Pluggable vector backend | ✓ Vectorize/Pinecone | locked | locked | locked |
| BYO provider keys | ✓ | partial | partial | ✗ |

Avoid weaselly language. If a competitor genuinely has feature parity
on a row, mark it. Trust grows from honesty here.

#### 9. Roadmap Snapshot

Three or four cards linking to public roadmap docs. Signals momentum
and a serious product team. Recommended featured items:

- **Eval as a Service** — public benchmarks + customer drift
  detection
- **Agentic Retrieval** — multi-hop, decompose-then-synthesize
- **Connector Marketplace** — Notion / GitHub / Slack / Drive
- **Domain Tuning** — fine-tuned rerankers on your corpus

Link to `docs/roadmap/ROADMAP_ITEMS.md` for the full list. (Stretch:
auto-render the roadmap index from the markdown source so the page
stays in sync.)

#### 10. Pricing Teaser

Pricing is unresolved (see Open Questions). For v1 this section is
either:

- "Free during beta. Sandbox available now." (if pricing is genuinely
  TBD)
- Three-tier card layout (free / pro / enterprise) if we have
  decided.

Don't ship vague filler ("Contact us for pricing"). Either be honest
that pricing is in flight, or commit.

#### 11. Final CTA

Repeat hero CTAs. One last opportunity to convert before footer.

#### 12. Footer

- Company: Alacrity AI
- Product: Textral, Sandbox, Docs, Status
- Open Source: GitHub, npm packages, Roadmap
- Legal: Privacy, Terms, Security
- Social: GitHub, X/Twitter, LinkedIn

## 5. Design Direction

**Reference vibe:** Linear × Resend × Anthropic. Clean, premium,
considered. *Not* Cloudflare-dense, *not* Pinecone-corporate.

### Tone

- **Mature, not playful.** Developer-infra audience trusts restraint
  more than emoji.
- **Code-prominent.** Real snippets, syntax-highlighted, with
  generous breathing room.
- **Confident, not boastful.** Show benchmark scores when we have
  them; don't overclaim before we do.
- **Calm motion.** Subtle on-scroll reveals; no bouncy animations.

### Visual language

- **Color.** Dark mode default with a light mode toggle. Single
  accent color (recommend a deep saturated teal or oxblood — needs
  alignment with Alacrity brand). Restricted palette — accent + 2
  neutrals + 1 success/code-highlight green.
- **Typography.** Display in a refined sans (Inter, Geist, or a
  serif for headlines à la Anthropic). Mono for code (JetBrains
  Mono, Geist Mono, Berkeley Mono). One serif for accents
  (signaling craft) is a strong differentiator vs. generic SaaS
  sans-only sites.
- **Layout.** Generous whitespace. Wide max-width (1200-1280px) for
  hero, narrower (~720px) for prose. No 5-column feature grids.
- **Iconography.** Custom or Lucide. Avoid stock illustrations;
  they signal "we hired a generic agency."

### Hero visual options (in order of ambition)

1. **Live audit trace animation.** Real query rendering through the
   pipeline; high effort, high payoff.
2. **Stylized Claude Code transcript.** Real MCP session;
   medium effort, high relevance.
3. **Architecture diagram with subtle motion.** Lower effort,
   adequate.
4. **Static hero image with the 3-line MCP install.** Lowest effort,
   still better than most SaaS heroes.

Recommendation: ship option 2 for v1, plan option 1 for v2.

### Accessibility

- WCAG AA minimum, AAA where feasible.
- Full keyboard navigation; visible focus rings.
- `prefers-reduced-motion` respected on all animations.
- Code blocks with proper language attributes for screen readers.

## 6. SEO Strategy

### Target keywords

Primary (high intent, lower volume):

- "managed RAG"
- "RAG API"
- "MCP RAG server"
- "self-hosted RAG"
- "RAG with citations"
- "vector search platform"
- "hybrid retrieval API"

Secondary (longer tail, higher intent):

- "Cloudflare Workers RAG"
- "RAG-as-a-service multi-tenant"
- "Pinecone alternative open source"
- "RAG with audit trail"
- "TypeScript RAG SDK"
- "Python RAG SDK"

### On-page SEO

- One `<h1>`, semantic `<h2>`/`<h3>` hierarchy.
- Title tag under 60 chars; meta description under 155 chars.
- `og:image` and `twitter:card` (custom-rendered, not generic logo).
- JSON-LD structured data: `Product`, `Organization`, `FAQPage`
  (for the FAQ if we add one), `SoftwareApplication`.
- Canonical URL set.
- Sitemap.xml + robots.txt.
- Open-source repo links use `rel="nofollow"`? Probably not — we
  want the link equity to flow to GitHub.

### Technical SEO

- LCP under 1.5s on 4G (fast enough that core web vitals don't bite).
- 100/100 Lighthouse on performance, accessibility, SEO. Best
  practices ≥95.
- No layout shift. Images explicit width/height.
- Defer all non-critical JS.

### Content depth

The single landing page won't rank for everything. Plan to support
it with:

- A blog (`textral.alacrity.ai/blog`) — post-launch.
- Docs (`docs.alacrity.ai` or `textral.alacrity.ai/docs`) — separate
  surface.
- Roadmap docs visible on the public site (we already have them
  written; render them as web pages).

## 7. Tech Stack Recommendation

**Astro** is the strong recommendation.

**Why:**
- Zero JS by default = best-possible Lighthouse scores out of the
  box.
- MDX support means the team can author marketing copy in markdown
  with React components inline (great for code snippets).
- Static-first = cheap CDN hosting; can deploy to Cloudflare Pages
  for natural fit with the rest of the stack.
- Mature islands architecture if we need any client interactivity
  (live demo, theme toggle, copy-to-clipboard buttons).

**Alternatives considered:**

- **Next.js.** Overkill for a static marketing page. Worth it only
  if we plan to bolt on a dashboard or auth flow on the same domain
  (probably not — sandbox is its own surface).
- **Hand-rolled Vite + React.** Smaller, but loses MDX, sitemap,
  partial hydration ergonomics. Not worth it.
- **Webflow / Framer.** Faster to ship visually but locks copy into
  a CMS the engineers can't easily version. Bad for a developer-
  focused brand.

### Hosting

- Cloudflare Pages (natural fit; free tier; same provider as the API).
- Custom domain: `textral.alacrity.ai`.
- DNS via the Alacrity org's existing Cloudflare account.

### Repo location

Recommend a new package: `apps/landing/` in the existing monorepo.
Same `pnpm-workspace.yaml`, same release rituals. Alternative is a
separate repo, but co-locating means the marketing copy can stay in
sync with shipped product features (the comparison table can pull
from contracts metadata, the API examples can be type-checked
against the live SDK).

## 8. Performance Budget

- **LCP (Largest Contentful Paint):** ≤ 1.5s on Slow 4G
- **CLS (Cumulative Layout Shift):** ≤ 0.05
- **TBT (Total Blocking Time):** ≤ 100ms
- **JS bundle (initial load):** ≤ 50kB gzipped
- **Total page weight:** ≤ 500kB
- **Lighthouse:** Perf 95+, A11y 100, Best Practices 95+, SEO 100

These are non-negotiable. A developer-tooling site that loads slowly
is a credibility liability.

## 9. Conversion Goals & Analytics

### Primary conversion

Click on the primary CTA (sandbox sign-up). We measure:

- Pageviews → CTA clicks (CVR)
- CTA clicks → sandbox account creations (qualified CVR)
- Time-to-first-query (a sandbox metric, not a landing page metric,
  but the funnel ends there)

### Secondary conversions

- GitHub star clicks
- Docs link clicks
- Outbound on roadmap doc links (signals deep interest)

### Analytics

- Plausible or Fathom (privacy-first, no cookie banner needed).
- Avoid GA4 unless someone has a strong reason. The privacy-banner
  tax for a developer audience isn't worth it.
- Track `cta_click` events with source (hero, mid-page, final).

## 10. Acceptance Criteria

- Page deployed at `textral.alacrity.ai`.
- All sections from §4 present and substantive (no Lorem Ipsum).
- Hero conveys product in under 4s on first paint.
- Primary and secondary CTAs visible above the fold.
- All code snippets verified against the live SDK / API / MCP.
- Comparison table reviewed for accuracy (no overstated claims).
- Lighthouse scores meet §8 budget on production URL.
- Open Graph + Twitter card render correctly when shared.
- Sitemap and robots.txt published.
- Mobile-responsive (320px → 1920px tested).
- Dark/light mode both polished.
- Footer links all work.
- Analytics events firing in production.

## 11. Open Questions

- **What is the canonical sandbox URL?** Subdomain
  (`sandbox.textral.alacrity.ai`)? Path on the same domain
  (`textral.alacrity.ai/sandbox`)? Or is it `apps/sandbox/` deployed
  separately?
- **What is the canonical docs URL?** `docs.alacrity.ai`,
  `textral.alacrity.ai/docs`, or a subpath off the GitHub README? A
  separate Astro Starlight site is the right v1.
- **Pricing strategy.** Free / paid tiers, BYO-key with a margin,
  pure usage-based? The pricing teaser section depends on this.
- **Brand identity.** Does Alacrity have an existing visual system?
  Does Textral get its own sub-identity, or inherit Alacrity's? This
  unblocks the design phase.
- **Logo / wordmark.** Do we have one? Need it before any design
  work meaningfully starts.
- **OG image strategy.** Auto-generated per-page (with section-
  specific imagery), or single hero shot for the whole page?
- **Newsletter / lead capture.** Yes/no. If yes, what platform? If no,
  remove the question now so we don't bolt it on awkwardly.
- **Status page.** Do we have one? Should the footer link to it?
  Statuspage.io, Better Stack, or self-hosted?
- **Trademark.** Is "Textral" cleared? Worth confirming before
  spending on an SEO push around it.
- **Comparison table — public competitors' positions.** How do we
  make sure we're not misrepresenting them? Recommend reviewing the
  table with an external eye before publishing.

## 12. Out of Scope (For This v1)

- A blog. Plan it for post-launch, but the launch page does not
  require one.
- A status page on the same surface. Different surface.
- Customer logos / testimonials. We have no customers yet; faking
  this is suicide. Skip until we have real ones.
- Live demo embedded on the page (e.g. an in-page chat against a
  hosted namespace). Cool eventually; not v1.
- Internationalization. English-only at launch.
- Authenticated state on the marketing page (e.g. "logged in as
  Leif"). Sandbox handles auth; marketing page stays static.

## 13. Sub-Docs to Follow

This high-level doc will be supported by:

- `docs/landingpage/COPY_DECK.md` — full final copy for every
  section, ready to paste into the build.
- `docs/landingpage/DESIGN_SPEC.md` — typography, palette, spacing
  scale, component library, illustration plan.
- `docs/landingpage/IMPLEMENTATION.md` — Astro project structure,
  components, build/deploy workflow, CI hooks.
- `docs/landingpage/SEO_PLAYBOOK.md` — keyword strategy, structured
  data templates, post-launch SEO content plan.

These are explicitly *not* part of this v1 scoping doc — they are
the next layer of detail once the high-level vision is locked.

## 14. Suggested Sequence of Work

1. **Resolve open questions** (§11) — especially pricing and brand
   identity. These block design.
2. **Lock the hero copy** by A/B-testing the four candidates with a
   small audience (Twitter poll, internal vote, ask 5 ICP-shaped
   engineers).
3. **Author `COPY_DECK.md`** — full page copy, signed off before
   design starts.
4. **Author `DESIGN_SPEC.md`** — palette, typography, hero visual
   direction.
5. **Wireframe + visual mockup** (Figma) for hero + pillars + audit
   section. Other sections can follow the established design system.
6. **Implement in Astro** at `apps/landing/`. Wire up Cloudflare
   Pages preview deployments per PR.
7. **Pre-launch checklist:** Lighthouse audit, OG card test,
   mobile sweep, content review, broken-link sweep, analytics
   verification.
8. **Launch.** Set up the canonical URL, redirect any pre-existing
   placeholder, announce on the channels we have (X, the Anthropic
   community, HN if there's a moment that makes sense).
9. **Post-launch (week 1):** monitor analytics, fix any conversion
   leaks, A/B test hero copy alternates.

---

> Last reviewed: 2026-05-08. Owners: Leif (product), TBD (design).
> Status: **proposed** — awaiting open-question resolution before
> moving to `COPY_DECK.md`.
