# Textral Landing Page — Copy Deck

> **Status:** First draft. Paste-ready for sections marked `READY`;
> needs decision for sections marked `NEEDS DECISION`.
>
> **Tone reference (per `HIGH_LEVEL.md` §5):** Mature, not playful.
> Code-prominent. Confident, not boastful. Calm. Linear × Resend ×
> Anthropic vibe.
>
> **Voice rules:**
> - Second person ("you"), never first person plural marketing-speak ("we help you")
> - Short sentences. One thought per line.
> - No "powerful," "robust," "seamless," "revolutionary," "platform"
> - Code blocks > adjectives
> - Numbers when we have them; nothing when we don't (no fake stats)
> - "Cloudflare" not "the edge"; "TypeScript" not "modern stack"
>
> **Placeholders used in this doc:**
> - `{{SANDBOX_URL}}` — TBD (see HIGH_LEVEL §11). Recommend `https://sandbox.textral.alacrity.ai`.
> - `{{DOCS_URL}}` — TBD. Recommend `https://docs.textral.alacrity.ai`.
> - `{{REPO_URL}}` — `https://github.com/alacrity-ai/TextralAI`
> - `{{API_BASE}}` — `https://api.textral.alacrity.ai` (or wherever the prod API ends up).

---

## 1. Page Meta `READY`

```html
<title>Textral — Hosted RAG your AI agent can actually use</title>
<meta
  name="description"
  content="Hybrid retrieval, audit-first, MCP-native. Hosted on Cloudflare or self-hosted on your own infra. Multi-tenant from day one."
/>
<meta property="og:title" content="Textral — Hosted RAG your AI agent can actually use" />
<meta
  property="og:description"
  content="Hybrid retrieval with citations, full query lineage, MCP-native. Hosted or self-hosted — same packages either way."
/>
<meta property="og:type" content="website" />
<meta property="og:url" content="https://textral.alacrity.ai" />
<meta property="og:image" content="https://textral.alacrity.ai/og-default.png" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="canonical" href="https://textral.alacrity.ai" />
```

**Title length:** 56 chars (≤60 ✓)
**Description length:** 134 chars (≤155 ✓)

---

## 2. Navigation `READY`

**Logo (left):**
> Textral

**Links (center, desktop only):**
- Docs → `{{DOCS_URL}}`
- Roadmap → `/roadmap` (renders the markdown index)
- GitHub → `{{REPO_URL}}` (with star count badge)

**CTA (right):**
> Try the sandbox →

Mobile nav collapses to a hamburger; CTA stays visible.

---

## 3. Hero `READY`

### Recommended

**Eyebrow (small caps, accent color):**
> RAG-AS-A-SERVICE · MCP-NATIVE · OPEN SOURCE

**Headline (display weight):**
> Hosted RAG your AI agent can actually use.

**Subheadline (body+1 weight, max 2 lines on desktop):**
> Hybrid retrieval, audit-first, MCP-native. Run it on Cloudflare or self-host on your own infra — same packages, same contracts.

**Primary CTA button:**
> Try the sandbox →

**Secondary CTA (text link with chevron):**
> View on GitHub ↗

**Tertiary line under CTAs (small, muted):**
> No credit card. Free during beta.

### Alternate hero copy (for A/B testing post-launch)

| Variant | Headline | Subheadline |
|---|---|---|
| **A** *(recommended default)* | Hosted RAG your AI agent can actually use. | Hybrid retrieval, audit-first, MCP-native. Run it on Cloudflare or self-host on your own infra — same packages, same contracts. |
| **B** *(audit-first lean)* | RAG with receipts. | Every query returns a forensically-replayable event with full retrieval lineage. Hosted or self-hosted, multi-tenant from day one. |
| **C** *(self-host lean)* | Run it yourself, or let us run it. | Managed RAG that ships as the same packages you'd self-host. Hybrid retrieval, MCP-native, no fork, no migration. |
| **D** *(provocative)* | The retrieval API your agent should be calling. | One MCP install. Hybrid retrieval with citations. Your data lives where you want it. |

### Hero visual (per HIGH_LEVEL §5)

V1: Stylized terminal showing the 3-line MCP install followed by a Claude Code transcript calling Textral. Asset spec lives in `DESIGN_SPEC.md` (TBD).

---

## 4. Pillars (4-card row) `READY`

Section heading (small, centered):
> What you get

Each card: icon + headline + 1 sentence.

### Card 1
**Headline:** MCP-native by default
**Body:** Your AI agent calls Textral directly — no glue code, no wrappers. One install, multi-profile addressing for stage and prod, every tool surfaced.

### Card 2
**Headline:** Hybrid retrieval, in the box
**Body:** Dense + BM25 + reranker out of the box. Per-namespace dimension locking catches the silent embedding mismatches other services let you ship into production.

### Card 3
**Headline:** Audit-first
**Body:** Every query is a forensically-replayable event with retrieval lineage, citation integrity, dropped-citation tracking, and per-arm error surfacing.

### Card 4
**Headline:** Run it your way
**Body:** Hosted on Cloudflare, or self-hosted on your own infra. Same packages. Same contracts. No fork, no migration story.

---

## 5. The Audit Story (featured section) `READY`

This is the wedge. Lay it out as: narrative copy left half, real audit JSON right half. On mobile, JSON stacks below narrative.

### Section heading (large, display-weight)
> Receipts. For every query.

### Narrative copy

> When retrieval quality silently degrades, most teams find out from a user complaint. Textral surfaces it the second it happens.
>
> Every query returns a `query_event_id` you can replay weeks later. Full retrieval lineage: which arm fired, what scored, what was reranked, what got cited, what got dropped. Per-arm error messages when an arm degrades. Citation integrity validated against the chunks you actually retrieved.
>
> We shipped a real production fix on day two of building Textral because the audit caught a silent dimension-mismatch bug nothing else would have. The kind of bug that turns into "our retrieval just got worse, no one knows why" three months later.

### CTA below narrative

> Read about how we caught it → *(link to a blog post or to a public retrospective doc — TBD)*

### Audit JSON (right column, syntax-highlighted, *real shape* from the wire)

```json
{
  "query_event_id": "qev_01KR39M0YHK6KJ14S7QXKVWWQW",
  "answer": "The library's legacy endures through the texts that were copied and disseminated…",
  "citations": [
    { "n": 1, "chunk_id": "chk_…", "section_path": "/chapter-six-what-survived" },
    { "n": 2, "chunk_id": "chk_…", "section_path": "/chapter-three-the-founding" },
    { "n": 3, "chunk_id": "chk_…", "section_path": "/chapter-four-the-scholars" },
    { "n": 4, "chunk_id": "chk_…", "section_path": "/chapter-five-the-decline" }
  ],
  "audit": {
    "retrieval_status": "full",
    "dense_candidates_returned": 4,
    "sparse_candidates_returned": 8,
    "candidates_returned": 8,
    "reranker": { "provider": "voyage", "model": "rerank-2", "executed": true },
    "citation_integrity": "valid",
    "dropped_citations": []
  }
}
```

> **Designer note:** Truncate this to fit one viewport-height; allow click-to-expand for the full audit.

---

## 6. Code-First Proof (tabbed) `READY`

### Section heading
> Three lines from "I just heard about you" to "my agent is querying my docs."

(Or alternate: "Three minutes from sign-up to your first cited answer.")

### Tab 1 — MCP

**Tab label:** MCP (Claude Code, Cursor, etc.)

**Step copy:**
> One command. Your agent gets retrieval as a tool.

**Code:**

```bash
claude mcp add textral --scope user -- npx -y @textral/mcp
```

**Below the code:** small caption.
> Then ask: *"What survived the Library of Alexandria?"* — your agent calls `query`, gets cited chunks, and answers.

### Tab 2 — TypeScript

**Tab label:** TypeScript

**Code:**

```typescript
import { Client } from "@textral/sdk";

const client = new Client({ profile: "hosted-prod" });

// Ingest
await client.documents.ingest({
  namespace: "narrative",
  filename: "alexandria.md",
  content: alexandriaText,
});

// Query with citations
const { answer, citations, audit } = await client.query({
  namespace: "narrative",
  query: "What survived the Library of Alexandria?",
});
```

**Caption:**
> `audit.query_event_id` is your replay handle. Save it next to your logs.

### Tab 3 — REST

**Tab label:** REST

**Code:**

```bash
curl -X POST {{API_BASE}}/query \
  -H "Authorization: Bearer $TEXTRAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": "narrative",
    "query": "What survived the Library of Alexandria?",
    "embedding": { "provider": "openai", "model": "text-embedding-3-large" },
    "inference":  { "provider": "openai", "model": "gpt-4o-mini" }
  }'
```

**Caption:**
> Full OpenAPI surface at `{{DOCS_URL}}`.

---

## 7. How It Works (architecture diagram) `NEEDS DESIGN`

### Section heading
> What's actually happening

### Body copy (above or below the diagram)

> Ingest splits documents into section-aware chunks, embeds them with the provider you chose, indexes them in both a vector store (Cloudflare Vectorize or Pinecone) and a BM25 sparse index. Query runs both arms in parallel, fuses with reciprocal-rank fusion, reranks with Voyage, and synthesizes with the inference model you chose. Every step writes an audit row. Every audit row is replayable.

> **Designer note:** Diagram should show ingest path (top) and query path (bottom) with the provider abstractions called out (embedding / reranker / inference / vector backend). Specs live in `DESIGN_SPEC.md`.

---

## 8. Hosted or Self-Hosted `READY`

Two-column layout. Same packages, two deployment surfaces.

### Section heading
> Hosted, self-hosted, or both at once.

### Subhead
> The MCP profile model lets one Claude Code session talk to a hosted dev instance and a self-hosted prod instance in the same conversation. We did not bolt this on as a v2 — it's how the product was built.

### Column 1 — Hosted

**Heading:** Hosted on Cloudflare
**Body:**
> Spin up a tenant in the sandbox, get an API key, ingest your first document. We run the workers, the database, the vector store. You bring your provider keys (OpenAI, Anthropic, Voyage, Cohere) — or use ours.

**CTA:**
> Start in the sandbox →

### Column 2 — Self-hosted

**Heading:** Self-hosted on your infra
**Body:**
> Same packages. Same contracts. Deploy `@textral/api` to your own Cloudflare account or your own runtime. The MCP server, SDKs, and audit trail work identically. No fork, no separate codebase to maintain.

**CTA:**
> Self-hosting guide →

---

## 9. Compared To… `NEEDS DECISION` (final cells need legal/competitor review)

### Section heading
> Honestly compared

### Subhead
> If a competitor matches us on a row, we say so. If we're behind, we don't hide it. Last reviewed YYYY-MM-DD.

### Table

| | **Textral** | Pinecone Assistant | Vectara | OpenAI File Search |
|---|---|---|---|---|
| MCP-native | ✓ | — | — | — |
| Hybrid retrieval (dense + sparse) | ✓ | ✓ | ✓ | partial |
| Reranker in the box | ✓ | ✓ | ✓ | — |
| Full audit lineage | ✓ | partial | partial | minimal |
| Self-hostable (same packages) | ✓ | — | — | — |
| Multi-tenant API | ✓ | per account | per account | per account |
| Pluggable vector backend | ✓ | locked to Pinecone | locked | locked to OpenAI |
| BYO provider keys | ✓ | partial | partial | — |
| Open-source SDK + MCP | ✓ | — | — | — |

> **Footnote:** "MCP-native" means we ship a maintained MCP server as a first-class npm package, not that the competitor cannot be wrapped. Wrapping any REST API in an MCP server is possible; doing it well is not.

> **Reviewer note:** Verify each "—" before launch. Vectara has been investing in agentic features; Pinecone Assistant ships some audit fields. Re-check 2 weeks before launch.

---

## 10. Roadmap Snapshot `READY`

### Section heading
> What we're building next

### Subhead
> Public roadmap. Pull-requests welcome.

### Card grid (4 featured items)

#### Card 1 — Eval as a Service
**Headline:** Eval as a Service
**Body:** Public benchmark + per-namespace drift detection. nDCG@k, Recall@k, MRR — alerted when retrieval quality degrades on your corpus.
**Link:** Read the spec → `/roadmap/eval-as-a-service`

#### Card 2 — Agentic Retrieval
**Headline:** Agentic Retrieval
**Body:** Multi-hop, decompose-then-synthesize. The audit captures the full hop trace, so complex questions stay debuggable.
**Link:** Read the spec → `/roadmap/agentic-retrieval`

#### Card 3 — Connector Marketplace
**Headline:** Connectors
**Body:** Notion, GitHub, Slack, Drive, Confluence. Auto-ingest, delta-sync, source metadata for filtered queries.
**Link:** Read the spec → `/roadmap/connector-marketplace`

#### Card 4 — Domain Tuning
**Headline:** Domain Tuning
**Body:** Hosted fine-tuned rerankers on your corpus. +5–12pt nDCG over generic baselines for specialized domains.
**Link:** Read the spec → `/roadmap/domain-tuning`

### Bottom CTA
> Full roadmap (13 docs) → `/roadmap`

---

## 11. Pricing Teaser `NEEDS DECISION`

Pricing strategy is unresolved (HIGH_LEVEL §11). Two paste-ready treatments depending on the decision; pick one before launch.

### Treatment A — "Free during beta" `READY` *(recommended for v1 if pricing isn't locked)*

**Section heading:**
> Free during beta.

**Body:**
> We're in private beta. Sandbox tenants are free; bring-your-own provider keys (OpenAI, Anthropic, Voyage, Cohere) cover inference and reranking costs.
>
> When pricing lands, you'll see it here first — and beta tenants get advance notice and a grandfathered tier.

**CTA:**
> Start in the sandbox →

### Treatment B — Three-tier card layout `NEEDS DECISION`

If pricing is decided before launch, three-card layout: **Free**, **Pro**, **Enterprise**. Cell content blocked on pricing model.

> **Decision needed before launch:** which treatment ships?

---

## 12. Final CTA (above footer) `READY`

Centered, single column.

### Headline
> Put your docs to work.

### Body
> Spin up a tenant. Ingest your first document. Watch your agent cite it. All in under three minutes.

### Primary CTA
> Try the sandbox →

### Secondary line
> Free during beta. No credit card. {{REPO_URL}} ↗

---

## 13. Footer `READY`

### Column 1 — Product
- Sandbox → `{{SANDBOX_URL}}`
- Docs → `{{DOCS_URL}}`
- Roadmap → `/roadmap`
- Pricing → `/pricing` *(or anchor on this page if Treatment A)*
- Status → `{{STATUS_URL}}` *(see HIGH_LEVEL §11 — TBD)*

### Column 2 — Open Source
- GitHub → `{{REPO_URL}}`
- npm: `@textral/sdk` → `https://www.npmjs.com/package/@textral/sdk`
- npm: `@textral/mcp` → `https://www.npmjs.com/package/@textral/mcp`
- npm: `@textral/contracts` → `https://www.npmjs.com/package/@textral/contracts`

### Column 3 — Company
- Alacrity AI → `https://alacrity.ai`
- Blog → `/blog` *(post-launch)*
- Contact → `mailto:hello@alacrity.ai` *(or wherever inbound goes)*

### Column 4 — Legal
- Privacy → `/privacy`
- Terms → `/terms`
- Security → `/security`

### Footer base row

Left:
> © 2026 Alacrity AI

Right (small links):
- `X / Twitter` → TBD
- `LinkedIn` → TBD
- `Discord` *(if/when we have one)*

---

## 14. Microcopy & Edge Cases `READY`

### CTA button states
- Default: "Try the sandbox →"
- Hover: same; subtle motion on the arrow
- Loading (if there's any client-side gating): "Loading…"

### Form field placeholders (for any inline lead capture, if added)
- Email: `you@yourcompany.com`
- "Subscribe" button: "Get release notes"

### 404 page (if applicable)
> Page not found. Maybe it's in the [docs]({{DOCS_URL}}) or the [roadmap](/roadmap).

### "Powered by" footer note (if shipping the embed widget — see EMBED_WIDGET roadmap doc)
> Powered by [Textral](https://textral.alacrity.ai)

### Cookie banner copy
> We use Plausible analytics. No cookies, no tracking, no banner.

*(If we end up needing a banner: keep it under 12 words, single dismiss action.)*

---

## 15. SEO Copy Targets `READY` *(for content that supplements the page)*

Per HIGH_LEVEL §6, the landing page won't rank for everything alone. These are headlines + slug recommendations for a follow-on `/blog` or `/learn` series:

| Target query | Page title | Slug |
|---|---|---|
| "what is RAG-as-a-service" | RAG-as-a-Service: What It Is, When You Need It | `/learn/rag-as-a-service` |
| "MCP RAG server" | What an MCP RAG Server Actually Does | `/learn/mcp-rag-server` |
| "Pinecone alternative open source" | Pinecone Alternatives, Honestly Compared | `/learn/pinecone-alternatives` |
| "self-hosted RAG" | Self-Hosting Your RAG Stack on Cloudflare | `/learn/self-host-rag-cloudflare` |
| "RAG with citations" | Why RAG Citation Integrity Matters | `/learn/rag-citation-integrity` |
| "hybrid retrieval explained" | Hybrid Retrieval: Dense + Sparse + Reranker | `/learn/hybrid-retrieval` |

These are **out of scope for the v1 landing page** but worth noting so the SEO playbook (`SEO_PLAYBOOK.md`) inherits the targets.

---

## 16. Voice Consistency Checklist `READY` *(for reviewers)*

Before any section ships, verify:

- [ ] No banned adjectives: powerful, robust, seamless, revolutionary, cutting-edge, world-class, leading
- [ ] No "we help you…" or "we make it easy…"
- [ ] No undated benchmark claims; every number is sourced or removed
- [ ] No exclamation points outside of code blocks
- [ ] No emoji (per CLAUDE.md project rule)
- [ ] No reference to features that don't exist yet (Python SDK, agentic mode, etc.) without "soon" / "on the roadmap" framing — link to the roadmap doc instead
- [ ] No fake customer logos, fake testimonials, or "trusted by" lines
- [ ] Code in every snippet runs against the live API as published

---

## 17. What's Still Missing (for a future revision)

Items deliberately out of v1 of this copy deck — flag as we get clarity:

- **Customer testimonial pull quotes.** Skip until we have real ones.
- **Logo bar.** Same.
- **Animated audit-trace section copy** (HIGH_LEVEL §5 ambition tier 1). If/when we ship the live audit visualization, narrative copy will need a rewrite to match.
- **Pricing card cell content** (treatment B). Blocked on pricing.
- **Press/launch announcement copy.** Separate doc when we get there.
- **Comparison table cell verifications.** Re-check each "—" 2 weeks pre-launch.
- **Per-section OG images.** The default OG covers the page; per-section is a nice-to-have.

---

## 18. Sequence of Approval

Before this deck moves to `IMPLEMENTATION.md`:

1. **Hero variant locked** (recommend A; signoff or pick alternate).
2. **Sandbox URL decided** (HIGH_LEVEL §11).
3. **Docs URL decided** (HIGH_LEVEL §11).
4. **Pricing treatment decided** (Treatment A vs B in §11 of this deck).
5. **Comparison table cells verified** by an external eye.
6. **`{{API_BASE}}` placeholder resolved** to the canonical prod hostname.
7. **Status page decision** (link or skip).
8. **Brand identity / logo locked** (HIGH_LEVEL §11) — affects nav and OG image.

Once all eight are checked, this deck is paste-ready and `DESIGN_SPEC.md` can lock visuals against final copy.

---

> **Last drafted:** 2026-05-08. Owner: Leif (product). Status:
> first-draft — awaiting hero variant lock + 7 other approvals (§18).
