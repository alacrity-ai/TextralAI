# KnowQL + Pinecone Nexus — What This Means for Textral (V2)

> Refresh of `KNOWQL_WHAT_THIS_MEANS.md` (V1).
>
> V1 was a pre-call briefing written before the MCP layer landed and
> before structured outputs, hybrid RRF retrieval, citation integrity,
> and the per-query audit shape were generally available. This V2
> updates the comparison against Pinecone Nexus / KnowQL with
> Textral's current capabilities and re-evaluates V1's strategic
> scenarios in light of two things V1 didn't account for:
>
> 1. **MCP became the agent-tool protocol.** The "agents have no
>    standard vocabulary" problem KnowQL is positioned to solve has
>    largely been solved by MCP at the protocol layer.
> 2. **Textral now ships several KnowQL primitives.** Output-shape
>    contracts, citation grounding, audit, hybrid retrieval, and
>    reranking are live and observable in the audit object today.
>
> Source: `docs/third-party/PINECONE_NEXUS.md` (whitepaper),
> `docs/SABER.md` (recap), and `docs/third-party/KNOWQL_WHAT_THIS_MEANS.md` (V1).

---

## TL;DR

**V1's core thesis still holds:** Pinecone is moving up the stack into
the application/retrieval layer Textral occupies. Nexus's
context-compiler pattern — compile-time enrichment producing typed,
cited, task-shaped artifacts — remains a real architectural shift.

**What changed since V1:**

1. **MCP eclipsed the "standard interface" framing.** KnowQL's
   pitch — "agents have no shared vocabulary, we're providing one" —
   is true at the *query semantics* layer (intent / output-shape /
   confidence / budget) but largely false at the *invocation*
   layer, where MCP is now the de facto contract that Claude,
   Cursor, ChatGPT desktop, and the wider IDE agent ecosystem
   already speak. Textral's MCP tool surface is, today, an
   agent-callable contract — without waiting for KnowQL to publish.
2. **Textral closed several V1 gaps without adopting KnowQL.**
   Structured outputs (caller-defined JSON schema), citation
   grounding with chunk-level provenance, hybrid RRF retrieval,
   optional Voyage/Cohere reranking, BYOK with provider-key audit,
   and a rich per-query audit (`degradation_level`,
   `citation_integrity`, `dropped_citations`, token usage,
   retrieval status) all ship and are observable in `query`
   responses today.
3. **Cross-source synthesis is real but architecturally different.**
   Nexus does cross-source synthesis at *compile time* into a
   persistent artifact. Textral does cross-source synthesis at
   *query time* via MCP fan-out across namespaces (each namespace
   can use a different vector backend, embedding model, and
   dimensions). Both work; the trade-offs are different and worth
   making explicit.
4. **The remaining gaps are narrower and more specific.** Per-field
   confidence on extracted values, an iterative compilation
   feedback loop, a first-class latency-budget primitive, and
   compile-time multi-source artifacts are the genuine outstanding
   items.

**Strategic read:** the urgency of "implement KnowQL or be left
behind" has dropped because MCP is doing the universal-interface
job. The urgency of "close the per-field-confidence + iterative
compilation gap" has stayed flat — those are real engineering
investments worth making whether or not KnowQL ships open.

---

## §1. What Textral has shipped since V1 was written

Each of these is observable from a single `mcp__textral__query`
audit response today.

| Capability | Status | Evidence in the audit shape |
|---|---|---|
| MCP tool surface | Live | `mcp__textral__query`, `list_namespaces`, `ingest_file`, `list_query_events`, etc. — typed JSON-RPC schemas callable by any MCP-aware agent |
| Structured output with caller-supplied schema | Live | `output.mode = "structured"` with a JSON schema; falls back to `text` mode |
| Citation-grounded answers | Live | `citations[]` with `chunk_id` + `section_path`; `audit.citation_integrity` reports `valid` / mismatches; `audit.dropped_citations` lists rejected ones |
| Hybrid retrieval (dense + sparse, RRF) | Live | `retrieval.strategy = "hybrid_rrf"` with configurable `top_k_dense`, `top_k_sparse`, `rrf_k` |
| Reranking (Voyage / Cohere) | Live | `retrieval.rerank` config + `audit.reranker.{enabled,executed,provider,model,top_n}` |
| BYOK with provider-key audit | Live | `provider_key_id` / `provider_key_ref` on embedding + inference + reranker; recorded in `audit.provider_key_id` |
| Per-query audit envelope | Live | `audit.tokens.{embedding_input, synthesis_input, synthesis_output, context}`, `latency_ms`, `retrieval_status`, `degradation_level` |
| Multi-backend in one tenant | Live | Demonstrated: Qdrant-backed and Pinecone-backed namespaces coexist; same `query` API for both |
| Cross-namespace synthesis (query-time, agent-driven) | Live via MCP fan-out | The agent issues parallel `query` calls; observed in the Northwind churn demo (sales-crm + support-tickets + roadmap) |
| Per-namespace heterogeneity | Live | Each namespace declares its own `corpus_profile`, `chunking_profile`, `embedding_profile` (incl. dimensions), `vector_backend`, `vector_index_name` |
| Token budget primitive (partial) | Live | `context.max_context_tokens`, `inference.max_output_tokens` |
| Graceful degradation | Live | `degradation_level: "full" \| ...` reported per query; agents can decide whether to act |
| Failing-job retry surface | Live | `list_failing_jobs`, `retry_failing_job` — operability for the ingest pipeline |

What this means: a fair number of V1's "Textral lacks vs Nexus"
items are no longer accurate. The next section walks the V1 tables
line-by-line.

---

## §2. Updated capability comparison

### 2.1 What V1 said Textral has that maps cleanly — still mostly accurate

V1's mapping table (Textral's existing capabilities → Nexus
analogues) holds up well. Two updates worth flagging:

| Textral concept | Nexus / KnowQL analogue | V2 note |
|---|---|---|
| Corpus profiles | Task-specific compilation contexts | Still profile-driven (generic, narrative, support visible in production); per-task spec is still TBD. |
| Enrichment passes → derived artifacts | Derived artifacts | Still the closest direct analogue. Textral still calls them passes, not artifacts, and they're not yet returned through a typed-artifact contract. |
| Hybrid retrieval | Native hybrid retrieval | Now first-class: `hybrid_rrf` is the default `retrieval.strategy`. |
| Per-tenant audit fields | Per-query token + cost tracking | **Significantly richer than V1 implied.** See the audit table in §1. |
| Per-version_index immutability + content-hash dedup | Versioned artifacts | Still true. |
| Cookbook validator | Task-shaped end-to-end testing | Still true. |
| Pluggable vector backends | BYOC / portability | Now battle-tested across Qdrant + Pinecone live concurrently. |
| Self-hostable posture | Builder tier + BYOC angle | Pinecone's BYOC is "managed-Pinecone in your cloud," which is not the same as "run our binaries on your hardware." That distinction is now even sharper. |

### 2.2 V1's "gaps" table — re-evaluated

| V1 gap claim | V1 said | V2 status | What changed |
|---|---|---|---|
| Declarative query DSL | "REST endpoints with body schemas" | **Partially closed via MCP.** | MCP tool schemas are a typed agent-callable contract over JSON-RPC. Not KnowQL-shaped, but it solves the agent-vocabulary problem on the protocol the ecosystem actually adopted. |
| Per-agent / per-task artifact specialization | "Profile-driven (5 profiles)" | Still a gap, narrowed | Same five-ish profiles; per-task spec is still TBD. Less urgent because cross-namespace fan-out lets the *agent* compose task-shaped reads from heterogeneous corpora at query time. |
| Output shape contract | "Fixed response schema per endpoint" | **Closed.** | `output.mode = "structured"` with a caller-supplied JSON schema; the synthesis call validates and shapes against it. Equivalent to KnowQL's `output_shape` primitive at the wire level. |
| Per-field confidence | "Overall retrieval scores; no per-claim confidence" | Still a gap | `citation_integrity` is binary (`valid` / not), and reranker scores are per-chunk, not per-extracted-value. Genuine outstanding work. |
| Iterative compilation | "Profile passes run once; no feedback loop" | Still a gap | Enrichment is still one-shot. Reasonable next step, especially for narrative/legal artifacts. |
| Budget envelope semantics | "Server timeout; no caller-provided depth budget" | Partially closed | Token budgets are first-class (`max_context_tokens`, `max_output_tokens`). A caller-side latency-budget primitive that adapts retrieval depth is still missing. |
| Deterministic conflict resolution | "Last-write-wins / no explicit policy" | Partially closed | Hybrid RRF gives deterministic ranking. Within-result conflict resolution between disagreeing sources is still LLM-mediated at synthesis time, not declared via an explicit policy. |
| Cross-source synthesis at compile time | "Single-source per document" | **Architecturally different, not strictly a gap.** | Textral synthesizes across sources at **query time** via MCP fan-out across namespaces (the Northwind demo: 3 backends, 1 synthesized answer, with citations preserved per-source). Nexus does it at **compile time** into a persistent artifact. Trade-offs in §3. |

### 2.3 What Textral does that Nexus appears NOT to — still true and stronger

| Capability | Textral | Nexus | V2 note |
|---|---|---|---|
| Self-host story | V3 Phase 2 — Postgres + Redis + Qdrant + MinIO | "BYOC" of managed Pinecone | Distinction is now sharper given Nexus is closed-source. |
| Multi-vector-backend portability | Vectorize / Qdrant / Pinecone, demonstrably concurrent | Pinecone-only | Demonstrated this session: 10 namespaces split across Qdrant and Pinecone, single query API, single audit shape. |
| Per-namespace heterogeneity | Embedding model, dims, chunking, corpus profile differ per namespace | Single Pinecone-shaped store | Each namespace can be tuned to its corpus without affecting others. |
| Open-source posture | TBD per V3 license decision | Closed | Still TBD; the agent-ecosystem case for an open implementation has only strengthened. |
| Per-tenant API key model + BYOK + audit | First-class; visible in every audit | Presumably present, undocumented in the whitepaper | Textral exposes the provider-key chain end-to-end for compliance / cost attribution. |
| MCP-native interface | First-class; this is how the demo works | No public MCP server announced | This is the V1 doc's biggest blind spot — see §3. |
| Agent observability surface | `list_query_events`, `get_query_event`, `get_query_response`, `degradation_level`, `citation_integrity` | Unspecified in whitepaper | Replayable, auditable, drillable; useful for evals as well as compliance. |

---

## §3. The KnowQL "standard interface" claim — re-evaluated against MCP

V1 treated KnowQL's openness as the single most important variable.
That framing was right for the moment but is partially superseded
by what happened in the agent ecosystem since:

**MCP is the agent-tool protocol now.** Claude Code, the broader
Claude desktop/web clients, Cursor, Zed, Windsurf, the JetBrains
plugin, ChatGPT's desktop client, and every serious agent framework
either ship MCP support or are visibly building toward it. The
"agents have no shared vocabulary" gap KnowQL was positioned to
fill is being filled — at the protocol/invocation layer — by MCP.

What KnowQL still uniquely contributes is at a *higher* layer: a
declarative semantic contract for retrieval (intent + output-shape +
provenance + confidence + budget). MCP solves "how does an agent
call your tool"; KnowQL solves "what does the agent say inside the
call to get a typed, cited, budgeted answer."

This reframes V1's scenarios.

### 3.1 Compile-time vs query-time cross-source synthesis

This is the genuine architectural fork between Nexus and Textral
today.

**Nexus (compile-time):** the context compiler builds a Sales
Agent artifact synthesizing Gong + Salesforce + Slack into one
persistent, versioned object. At query time, the agent reads the
artifact. Trade-offs:

- ✅ Query-time latency is low (typed read, no LLM sift).
- ✅ Token cost amortizes across many queries.
- ✅ Conflict resolution and entity linking can be done once,
   rigorously.
- ❌ Stale-on-source-changes. Requires recompilation strategy.
- ❌ Compilation cost is up-front and per-task-spec; new task
   spec = new artifact.
- ❌ Less flexibility for ad-hoc, exploratory queries the
   compiler didn't anticipate.

**Textral (query-time, MCP fan-out):** namespaces stay in their
native shape (sales-crm, support-tickets, roadmap, etc.), and the
agent fans out parallel `query` calls across the relevant
namespaces. The agent (or a higher-level summarizer) synthesizes.
Trade-offs:

- ✅ No staleness — every query reads current data.
- ✅ Flexible — any combination of namespaces composes; no
   pre-declared task spec.
- ✅ Auditable per-namespace — citations stay tied to their
   source corpus.
- ✅ Agent (Claude, GPT, etc.) does the cross-corpus reasoning
   the model is good at.
- ❌ Token cost per query is higher (each query path runs).
- ❌ Latency is the slowest of the parallel paths, plus the
   agent's synthesis.
- ❌ Cross-source conflict resolution is LLM-mediated at
   synthesis time, not declared by policy.

Neither is universally better. They're suited to different
workloads:

- High-frequency, repetitive, structurally-stable queries
  (every Sales rep asking the same shape of deal question) →
  compile-time wins.
- Low-frequency, exploratory, structurally-novel queries (a
  CEO asking a one-off cross-functional question) →
  query-time wins.

A mature platform probably wants both. Textral could add
compile-time multi-source artifacts as an enrichment-pass type
(currently passes are single-source per document) without giving
up the query-time fan-out path.

---

## §4. Updated strategic scenarios

V1 framed four scenarios. They're still useful, but the weights
have shifted.

### Scenario A: Threat — Pinecone moves up the stack

**Still real, but weakened by MCP.** The Marketplace + Nexus +
KnowQL pincer is a serious commercial play. But the "KnowQL becomes
the standard agent vocabulary" leg of the threat has weakened:
agents already have a standard vocabulary in MCP, and Textral
already speaks it. Pinecone's threat is now narrower:

- Marketplace distribution into 800k devs / 9k paying customers —
  still a real channel advantage.
- Compile-time artifact pattern as a perceived "we have the
  reasoning, you have the chunks" wedge — until Textral ships
  the equivalent.
- Token-cost narrative ("90% reduction") — still a sales hook,
  but increasingly contestable as Textral can publish honest
  per-query token audits and structured outputs that themselves
  reduce post-processing cost.

### Scenario B: Opportunity — KnowQL becomes an open spec

**Less urgent than V1 implied.** Even if KnowQL ships open, MCP
gives Textral a viable agent-callable surface today. Implementing
KnowQL on top of Textral is still possible and has positioning
value (anti-lock-in: "the same agent code runs against Nexus or
Textral"), but it's now an option, not a forcing function.

A pragmatic path: **expose KnowQL's six primitives as parameters
inside the existing MCP `query` tool.** `intent` is already the
`query` field. `filter` maps to namespace + (future) metadata
filters. `output_shape` is already `output.mode=structured`.
`provenance` is already `citations[]` + `audit.citation_integrity`.
`confidence` is the gap to close. `budget` is partially closed
(token budget) and needs a latency-budget addition. If the spec
publishes, mapping is cheap.

### Scenario C: Partnership — Marketplace app

**Still relevant, with the same caveat.** Distribution upside is
real; the risk is positioning Textral as a thin domain wrapper.
Worth pursuing as a *channel*, not as the *primary* GTM.

### Scenario D: Inspiration — adopt the architecture, ship our own

**Largely already happened.** Of V1's Scenario D punchlist:

- ✅ Output-shape contract — shipped (`output.mode=structured`).
- ✅ Citation grounding with provenance — shipped.
- ✅ Hybrid retrieval — shipped (RRF default).
- ✅ Reranking — shipped (Voyage/Cohere optional).
- ✅ Audit shape with degradation/integrity reporting — shipped.
- ⏳ Per-field confidence on extracted values — outstanding.
- ⏳ Iterative compilation feedback loop — outstanding.
- ⏳ Caller-side latency budget that adapts depth — outstanding
   (token budget is in place; latency budget that resizes top-k
   under pressure is not).
- ⏳ Compile-time multi-source artifacts — outstanding by design
   choice (query-time fan-out is the current pattern).

The remaining four items are the real V3 Phase 6+ punchlist.

---

## §5. Remaining gaps to close — concrete proposals

These are the four items from §4D that are worth investing in
regardless of how KnowQL plays out.

### 5.1 Per-field confidence on extracted values

**Today:** `citation_integrity` is `valid` / not; reranker
scores are per-chunk; the synthesizer's structured output has
no confidence annotation per field.

**Proposal:** when `output.mode="structured"`, augment each
schema-defined field with an optional sibling `_confidence`
field (or a parallel `confidences: { field: score }` object).
Source the score from one of:

- LLM self-evaluation (synthesizer asked to score each field)
- Logprob-derived (when the inference provider returns
  token-level logprobs, aggregate across the field's tokens)
- Retrieval-derived (max similarity score across the chunks
  cited for that field)

Stage 1: ship the LLM-self-evaluation path with a calibration
warning in docs. Stage 2: add logprob-derived where supported.

### 5.2 Iterative compilation feedback loop

**Today:** enrichment passes run once at ingest. There's no
mechanism to reshape an artifact based on retrieval-time
signals.

**Proposal:** record retrieval performance per artifact (which
chunks are repeatedly cited, which are never cited, which
queries returned `citation_integrity != valid`). Re-run
enrichment on artifacts whose retrieval signals indicate
underperformance. This is offline and async; doesn't change the
query path.

### 5.3 First-class latency budget primitive

**Today:** `max_context_tokens` and `max_output_tokens` exist;
no `max_latency_ms`.

**Proposal:** `query.budget = { max_latency_ms: 500 }`. The
retrieval engine adapts:

- Reduce `top_k_dense` / `top_k_sparse` if the budget is
  tight.
- Skip reranking if the budget can't accommodate it.
- Return partial results with `degradation_level` set
  appropriately rather than blocking past the budget.

This is the KnowQL `budget` primitive in everything but name.

### 5.4 Compile-time multi-source artifacts

**Today:** enrichment passes are single-source per document.
Cross-source synthesis happens at query time via MCP fan-out.

**Proposal:** add a new pass type — *cross-namespace artifact* —
that takes (namespace_set, task_spec) and produces a versioned
artifact synthesizing across the named namespaces. This sits
alongside the per-document passes; doesn't replace query-time
fan-out, just adds a high-frequency-query optimization path.

The Northwind demo from this session is the canonical use case:
"give me Sales-CRM + Support-Tickets + Roadmap synthesized for
'enterprise churn risk'" is exactly the shape of artifact a
compile-time multi-source pass should produce.

---

## §6. Updated recommendations

1. **Lead with the MCP story, not the KnowQL story.** Textral's
   competitive position has strengthened in a way V1 didn't
   account for: agents reach Textral natively today via MCP. That's
   a working version of "the standard interface KnowQL is
   promising." Marketing, demos, and partner conversations should
   make this concrete (the cross-namespace Northwind demo is the
   strongest single example).

2. **Treat KnowQL as a future schema mapping, not a strategic
   bet.** If/when KnowQL publishes openly, map the six primitives
   onto the existing `query` parameters. Cost is low; positioning
   value is high (anti-lock-in story); strategic dependency is
   minimal.

3. **Invest in the four §5 gaps in priority order.** Per-field
   confidence (§5.1) and the latency-budget primitive (§5.3) are
   the two with the most query-side leverage; iterative
   compilation (§5.2) and compile-time multi-source artifacts
   (§5.4) are higher-effort and should follow.

4. **Keep self-host + multi-backend front-and-center.** V1
   correctly identified these as durable Textral advantages.
   Nothing in Nexus's launch reduces that — if anything, the
   gap widened (Nexus is closed-source managed; "BYOC" is
   managed-Pinecone-in-your-cloud).

5. **Pursue Marketplace as a channel, not as positioning.**
   Same as V1's read on Scenario C. The risk of becoming a thin
   wrapper is real and should shape how the listing is framed.

6. **Don't compete on the "90% token reduction" headline.** It's
   a real claim about a specific architectural pattern
   (compile-time enrichment) Textral hasn't yet matched at the
   multi-source level. Until §5.4 ships, lead with audit
   transparency ("here's exactly what every query cost, with
   citations") rather than try to out-headline it.

---

## §7. What still needs answers

Most of V1's open questions for Siva are still open, but the
priority list has shifted:

| V1 question | Still open? | V2 priority |
|---|---|---|
| Is KnowQL an open spec? | Yes | Medium — informs Scenario B mapping but no longer urgent |
| Wire format (string DSL / JSON / GraphQL)? | Yes | Medium — concrete spec example shapes the mapping |
| Per-field confidence mechanism (logprobs / self-eval / heuristic)? | Yes | **High** — directly informs §5.1 implementation |
| Iterative-compilation feedback loop mechanism? | Yes | **High** — directly informs §5.2 |
| Versioning + incremental recompilation policy? | Yes | High — informs the artifact lifecycle if §5.4 ships |
| Deterministic conflict-resolution mechanism? | Yes | Medium |
| Marketplace economics + listing process? | Yes | Medium — informs Scenario C |
| Multi-tenant compilation isolation? | Yes | Low — Textral's per-tenant model is well-understood internally |

---

## Appendix A — Updated one-line reads on each Nexus claim

For quick recall:

- **"Knowledge engine, not retrieval system."** Textral is
  becoming one too; structured outputs + citations + audit are
  the building blocks that have shipped.
- **"Reasoning at compile time, not query time."** Textral does
  some of this (enrichment passes); doesn't yet do the
  multi-source compile-time variant.
- **"Per-field citations + confidence."** Citations: shipped at
  the chunk + section_path level. Per-field confidence: §5.1 gap.
- **"Up to 90% token reduction."** Specific to compile-time
  enrichment; Textral can't claim this until §5.4 ships. Counter
  with audit-transparency narrative.
- **"30x faster time-to-completion."** Specific to typed reads
  vs. multi-round retrieve-read loops. Textral's structured
  output mode addresses the typed-read half; the
  multi-round-loop half depends on agent design.
- **"Native hybrid retrieval."** Shipped (`hybrid_rrf`).
- **"Composable across heterogeneous sources."** Shipped via
  multi-namespace + MCP fan-out, with a different (query-time)
  architecture than Nexus's compile-time approach.

## Appendix B — V1 → V2 status diff

For readers tracking the deltas:

| V1 framing | V2 status |
|---|---|
| "KnowQL openness is the single most important variable" | Less urgent — MCP solved the invocation-layer problem |
| "Output-shape contract is a Textral gap" | Closed via `output.mode=structured` |
| "REST endpoints, no DSL" | Closed via MCP tool surface |
| "Cross-source synthesis is a Textral gap" | Architecturally different (query-time vs compile-time) — not strictly a gap, but compile-time variant is a fair §5.4 ask |
| "Per-field confidence is a gap" | Still a gap — §5.1 |
| "Iterative compilation is a gap" | Still a gap — §5.2 |
| "Budget envelope is a gap" | Partially closed (token); latency budget still a gap — §5.3 |
| "Self-host + multi-backend is a Textral edge" | Now battle-tested (Qdrant + Pinecone live concurrently in one tenant) |
| "Audit shape is a Textral edge" | Significantly stronger than V1 conveyed |
