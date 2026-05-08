# Pinecone Nexus — Technical Findings

> Source-of-truth read on Pinecone Nexus and KnowQL after the second
> whitepaper landed (`NEXUS_WHITEPAPER_2.md`). This supersedes the
> architectural reads in V1 (`KNOWQL_WHAT_THIS_MEANS.md`) where they
> conflict; the strategic comparison in V2
> (`KNOWQL_WHAT_THIS_MEANS_V2.md`) and the Marketplace brainstorm
> (`MARKETPLACE_BRAINSTORM.md`) remain valid as written.
>
> The launch announcement (`docs/SABER.md`, the original
> `PINECONE_NEXUS.md` press piece) was marketing-shaped and
> imprecise. The second whitepaper is the technical document.
> Where the two disagree, this doc trusts the technical paper.

---

## §1. Executive summary

The technical paper materially refines V1's read of Nexus in four
ways:

1. **The Context Compiler is an autonomous coding agent, not an
   "LLM-driven enrichment pass."** It uses an agentic harness: a
   coding agent paired with (a) a per-domain eval set, (b) a
   library of pre-vetted skills, and (c) a feedback loop scoring
   each iteration. With every iteration, the coding agent
   modifies two functions — `curate()` for artifact construction
   and `query()` for retrieval — runs the evals, refines on the
   failure signal, and repeats until the evals pass. The output
   is *working tuned code*, not a fitted schema.
2. **The contract from the domain expert is an eval set, not a
   schema.** Domain experts (without a retrieval background)
   bring representative tasks with known right answers plus the
   data sources. Nexus discovers the artifact structure,
   granularity, and construction strategy from the evals. This
   is structurally different from "user defines schema, system
   fills it."
3. **KnowQL has four primitive categories in the technical paper,
   not six.** The launch's "intent / filter / provenance / output
   shape / confidence / budget" has consolidated into "intent /
   filter / provenance / control." Output-shape is now folded
   into intent (alongside `ask` and `contexts in scope`); control
   absorbs depth + latency budget; confidence does not appear as
   an explicit query primitive in the technical paper's wire
   example. See §4.
4. **The KRAFTBench numbers are honest but smaller than the
   launch's "90% / 30x / 90%" headlines.** Nexus measured 100%
   completion (every question answered within budget) but only
   **0.680 accuracy**. The 90% completion-rate launch claim
   appears to be conflating completion with accuracy. Token
   reduction is real and large: Nexus 6.7K avg, RAG 49K (~7.3×),
   Coding agent 528K (~78×). Latency: Nexus 22.7s, RAG 37.9s,
   Coding agent 84.1s. See §5.

The architecture is well-thought-out and the benchmark is
well-instrumented. The category claim ("Knowledge Engine, not
retrieval system") is supportable from this paper. The headline
numbers in the launch announcement are not a fair summary of what
the paper actually measured.

---

## §2. The four primitives (corrected from V1)

V1 modeled Nexus as two boxes (Context Compiler + Composable
Retriever). The technical paper structures it as **four primitives,
each composed from the one below**:

| Primitive | What it is | Build vs serve |
|---|---|---|
| **Artifact** | A typed, governed piece of information constructed for a specific task or outcome. From the same 10-K data, a market-intelligence agent gets a financial-metrics artifact and a compliance agent gets a risk-factor-disclosure artifact. The shape is what makes the underlying representation efficient. | Build-time output. |
| **Context** | A curated set of artifacts designed for a specific role/team/workflow (e.g. analyst's financial-metric artifacts + MD&A + segment reporting = the analyst's context). | Build-time composition. |
| **Knowledge** | The collective body of every Context across the company. A query can span as many Contexts as it needs; routing is engine-handled. | Logical aggregation. |
| **Knowledge Engine** | The system that builds and serves all of the above. Core component is the Context Compiler (§3). | Runtime + build-time. |

**Concrete artifact example from the paper** — Allstate Corp 2021
10-K compiled artifact:

```
Compiled Artifact — source: 2022/899051.txt — ingested via Context Compiler
Allstate Corp — 2021 10-K summary
Ticker: ALL — CIK: 899051 — fiscal_year_end: 2021-12-31 — Exchange: NYSE

Identity:
  - Legal name: The Allstate Corporation
  - Common name: Allstate
  - Ticker: ALL (NYSE)
  - CIK: 899051
  - Fiscal year end: December 31

Revenue and Sales:
  - Total revenue: 50,588M, +20.7% YoY (prior 41,909M)
  - Drivers: P&C premiums earned +13.9% (National General acq);
             net investment income +107.1%
  - Allstate Protection: 46,030M (incl 40,454M premiums earned)
  - Protection services: 2,361M
  - Allstate Health & Benefits: 2,261M

[17 sections — grounded — field-level provenance — 2 of 17 shown]
```

Two things to note:

- Provenance is **field-level by construction**, baked into the
  artifact at compile time. Not reconstructed at query time.
- Sections (17 of them) are the artifact's structural unit. This
  is what `query()` operates over.

---

## §3. The Context Compiler — what it actually does

This is the substantive architectural claim and the largest delta
from V1's read.

### 3.1 The harness pattern

The Context Compiler is described as **"the autonomous coding agent
at the core of the Knowledge Engine."** It pairs a coding agent
with three inputs:

1. **An eval set per domain** — representative tasks with known
   right answers, plus the corresponding data sources. *This is
   the contract from the domain expert.*
2. **A library of pre-vetted skills** — document processing,
   entity extraction, chunking, etc. The agent composes solutions
   from these.
3. **A feedback loop** — scores each iteration against the eval
   signal.

### 3.2 What the agent actually writes

Each iteration, the coding agent modifies **two functions**:

| Function | Purpose | When it runs |
|---|---|---|
| `curate()` | Artifact construction from raw data | Build-time / ingest |
| `query()` | Knowledge retrieval shape | Query-time |

Then runs the eval set, uses failure signals to refine the code,
and repeats until evals pass. The output is *working tuned code
for that domain* — a real software artifact, not a model
configuration.

### 3.3 What this means for the "domain expert can produce a
Context" claim

Domain experts don't specify schemas, retrieval logic, or artifact
shapes. They specify **tasks they want answered** and the
**ground-truth answers**. The compiler discovers the structure
that satisfies the eval. This is materially different from "user
defines schema; system fills it" — and it's the part of Nexus most
worth being precise about, because it's the locus of the
"agentic-era infrastructure" claim.

The skills library is the operational lever. New domains are
served by **recombining existing skills in new ways**; when
something doesn't fit, Pinecone adds a new skill to the library.
This means the moat is partly the skills library itself — quality
and breadth of pre-vetted skills determines how many domains the
compiler can serve before requiring custom work.

### 3.4 Time-to-Context

The paper claims **"Contexts for new domains in days rather than
months"** with early design partners, with the explicit caveat
"we're still measuring across more domains and edge cases." This
is the only durability-of-claim caveat in the paper — worth taking
seriously, since "days vs months" is the headline justification
for the entire category.

### 3.5 What V1 got wrong about this

V1 framed the Context Compiler as "LLM-driven schema inference +
LLM-driven extraction, evaluated against task feedback." That's
not wrong, but it understates it. The actual mechanism is:

- The "LLM" is a coding agent.
- The "extraction" is whatever pattern of Python/skills the agent
  composes — could be a chunked-vector approach, a table parser,
  a graph extractor, depending on what the evals reward.
- The "schema" is whatever shape the artifact ends up having
  after the agent converges; the agent picks both shape and
  filling logic together, jointly optimized against the eval.
- The compiled output is durable code that re-runs at scale, not
  an inference-time function-call chain.

The implication: Nexus is closer to **"LLM-as-build-engineer"**
than to **"LLM-as-knowledge-extractor."** The reasoning happens at
build time and produces software; query time is then almost-pure
deterministic execution.

---

## §4. KnowQL — concrete wire format and primitive categories

### 4.1 Wire format (concrete example from the paper)

```json
{
  "ask": "Among NVIDIA, Microsoft, and Walmart, compare fiscal 2022 share repurchases: amount repurchased, original program size, and remaining authorization.",
  "ground": true,
  "shape": {
    "type": "object",
    "properties": {
      "companies": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "company_name":              { "type": "string" },
            "repurchased_usd_millions":  { "type": "number" },
            "program_size_usd_millions": { "type": "number" },
            "remaining_usd_millions":    { "type": "number" }
          }
        }
      }
    }
  }
}
```

Three observations:

1. **JSON, not a string DSL.** The wire format is a JSON document,
   GraphQL-shaped (caller declares return shape, server enforces).
   V1's prediction that this would feel "more like GraphQL than
   like SQL" was right.
2. **`shape` is a JSON Schema.** Strict, typed, machine-validatable.
   Not a sketch.
3. **Filter, control, contexts-in-scope not shown in this example.**
   The paper says intent "can be composed across multiple Contexts"
   and lists Filter (predicates + ACLs) + Control (budget envelope)
   as separate categories — so the full wire format presumably
   includes additional top-level fields the example omits.

### 4.2 The four primitive categories (technical paper's framing)

| Category | Contents | Maps to V1's "six primitives" |
|---|---|---|
| **Intent** | The question (`ask`), the response shape (`shape`), and the Contexts in scope. Composable across multiple Contexts. | intent + output_shape + filter (the "scope" half) |
| **Filter** | Deterministic predicates and access-control policies enforced at the surface. The agent only sees what its caller is permitted to see. | filter (predicate half) |
| **Provenance** | Field-level citations returned by construction, not reconstructed after. Every value carries its source. | provenance |
| **Control** | A budget envelope (depth and latency target). Cost declared in outcomes, not tokens. | budget |

V1's list of six (from the launch announcement) was **intent,
filter, provenance, output shape, confidence, budget**. The
technical paper consolidates to **four**:

- `output_shape` is folded into `intent` (it's the `shape` field
  of an intent).
- `confidence` does not appear as an explicit query primitive in
  the technical paper's example or category list. It may surface
  as a per-field annotation on the response (which the paper
  doesn't show), but it is no longer a top-level query input.

This is a meaningful simplification. It's also a clue about how
to think about confidence in Nexus: the artifacts are
deterministically constructed at compile time, the field-level
provenance is "by construction," and confidence may be a
build-time property of artifacts (e.g., per-field citations imply
groundedness) rather than a query-time knob.

### 4.3 What the response actually looks like

The paper says: *"The Engine returns one typed response, and the
agent's only reasoning step is comparing the typed response object
as all the orientation work was done at build time."*

The exact response wire format isn't shown. From context: it's a
JSON object conforming to `shape`, with field-level citations
(because `ground: true`) attached somewhere — likely as a sibling
metadata structure or as `_provenance` annotations per field.

### 4.4 What V1 got right

V1's GraphQL framing was correct. V1's prediction that
`output_shape` would be a JSON-schema-shaped contract was correct.
V1's framing of the six primitives is now slightly stale (and the
"confidence" gap V1 identified in Textral may not be the right
target — see §8.4).

---

## §5. KRAFTBench — what was actually measured

The paper introduces **KRAFTBench** (Knowledge Retrieval Assessment
Framework for Text), a benchmark that fixes the composer model
across three retrieval mechanisms so that any difference in
quality, latency, or token cost is attributable to retrieval.

### 5.1 Setup

- **Corpus:** 493 free-form text 10-K filings (~500 KB each, ~245
  MB total) — S&P 500 companies, fiscal year 2022.
- **Tasks:** 150 hard questions across 9 sectors and 10 financial
  topics (headcount, revenue, capex, capital returns, R&D,
  acquisitions, segment breakdowns, etc.).
- **Difficulty shapes:** multi-fact (≥2 facts about one entity),
  multi-company (compare across ≥2 entities), multi-step
  (retrieve A, then derive B from A).
- **Constraint per question:** 120 seconds and 1M tokens.
- **Composer model:** `claude-sonnet-4-6` (interesting — not the
  current 4.7).
- **Judge model:** `claude-sonnet-4-6` (same model judges; common
  practice but worth noting for self-grading bias).
- **Three retrieval mechanisms:**
  1. **Coding agent** — read-only file tools (`list_files`,
     `read_file`, `find_filecontent`, `find_filename`). No index.
  2. **Agentic RAG** — chunk + embed into Pinecone, query
     expansion + RRF fusion + top-k + agent loop until satisfied.
  3. **Pinecone Nexus** — Context Compiler artifacts, KnowQL
     query per question shape derived by Claude.

### 5.2 Results table (from the paper)

| Approach | Completion | Latency (avg) | Accuracy (avg) | Tokens (avg) | Steps (avg) |
|---|---|---|---|---|---|
| Pinecone Nexus | 100% (150/150) | **22.7 s** | **0.680** | **6,733** | **1.69** |
| Agentic RAG | 98.7% (148/150) | 37.9 s | 0.413 | 49,103 | 7.77 |
| Coding agent | 62.7% (94/150) | 84.1 s | 0.585 | 528,301 | 14.77 |

### 5.3 What this actually shows — and what the launch overstates

| Claim made in the launch | What KRAFTBench shows |
|---|---|
| "Task completion rates above 90%" | Nexus *completion* is 100%, but **completion ≠ accuracy**. Completion = "agent gave a conclusive answer within budget." Accuracy = "answer is correct per LLM judge." Nexus accuracy is **0.680**. The launch announcement appears to conflate the two. RAG completion is 98.7% but accuracy is 0.413. |
| "30x faster time-to-completion" | Nexus 22.7s vs Coding agent 84.1s = ~3.7×. Vs RAG = ~1.7×. Not 30×. The "30×" figure is not derivable from this table. |
| "Up to 90% less token spend" | Nexus 6,733 tokens vs RAG 49,103 (~7.3× less, or **86% reduction**) — this one checks out. Vs Coding agent 528,301 (~78× less, ~99% reduction). The "up to 90%" formulation is fair vs RAG. |

**Honest framing of the actual win:**

- Nexus is decisively better on **token cost** (~7× vs RAG, ~78×
  vs coding agent) — this is the strongest result.
- Nexus is meaningfully better on **latency** (~1.7× faster than
  RAG).
- Nexus is best on **accuracy at 0.680** vs RAG 0.413 vs Coding
  0.585 — better, but **0.680 is not "production-ready" for a
  finance-research workload** by any reasonable bar.
- Nexus is best on **completion** (100%) — meaning it always gives
  *an* answer.

The right read: **Nexus's compile-time-shape advantage is real and
the token reduction is the best evidence for it. But "agents on
Nexus answer 90% of complex questions correctly" is not what the
benchmark shows — it shows Nexus is the best of three options on
a benchmark where the best option is still wrong about a third of
the time.**

### 5.4 Failure-mode analysis (from the paper's traces)

The paper traces the share-repurchase question through each
approach. The failure modes are crisp:

- **Coding agent:** broad regex sweep on "share repurchase" /
  "Microsoft" / "Walmart" returns hundreds of matches across the
  corpus. Refinement by entity name returns more matches. Context
  window fills, hits 1M token limit. Disambiguation explosion is
  the structural failure mode.
- **Agentic RAG:** agent decomposes into 18 sub-facts, evaluates
  top-k chunks per fact. **Failure:** for Microsoft and Walmart,
  the dollar amount is in a table not colocated with the
  surrounding text, so chunked retrieval misses it. The agent
  marks the figure as "not present" even though it is. This is
  the **chunking-induced colocation failure** — well-known to
  practitioners, and a real architectural weakness of chunked RAG
  on tabular financial documents.
- **Pinecone Nexus:** takes the question + desired shape, fetches
  the precompiled per-company artifacts (which already have
  capital-returns aggregated), composes the typed response in
  one pass.

The structural argument: precompiling per-entity artifacts removes
the chunking-failure surface that breaks RAG on multi-company /
multi-step questions over heterogeneous documents.

### 5.5 What the benchmark doesn't measure

Worth being explicit:

- **Build cost.** The paper measures query-time tokens but doesn't
  publish the cost of compiling the 493-filing corpus. Compile
  cost is a real economic input — if it's $X per filing × 493
  filings, the per-question economic story changes.
- **Stale-on-source-changes cost.** No data on how recompilation
  works when a 10-K is amended or a new filing arrives.
- **Generalization across corpora.** 10-Ks are highly structured
  documents with well-known sections. Performance on less
  structured corpora (Slack threads, Gong transcripts, support
  tickets) isn't measured here.
- **Multi-tenant / governance overhead.** The Box+Unstructured
  example shows ACL passthrough but doesn't benchmark the
  governance path.
- **Comparison against other typed-output approaches.** No
  comparison to "RAG + structured output mode" (e.g., what
  happens if Agentic RAG also produces typed JSON?). The
  benchmark compares Nexus to chunked RAG with text outputs.

A fair external read of these numbers requires keeping these gaps
in mind.

---

## §6. The Box → Unstructured → Nexus reference architecture

The paper makes the partner integration concrete with a CUAD
contract-review example:

| Layer | Owner | Responsibility |
|---|---|---|
| Source-of-truth + ACLs | Box | Contracts in designated folders; file metadata including ACLs maintained by the legal team. |
| Parsing + extraction | Unstructured | Connects via Box APIs; captures content + metadata + ACLs; extracts document elements, tables, entities (`parties`, `agreement_date`); passes `permission_data` through. |
| Artifact layer + query surface | Pinecone Nexus | Ingests Unstructured output; Context Compiler produces artifacts (e.g., a renewal-terms table aggregating across contracts); KnowQL queries pass `permission_data` as a filter to enforce ACLs. |

Key architectural points:

1. **ACL passthrough is enforced at the query surface, not at
   ingest.** The artifact layer is shared; the *query path*
   filters by permission. This means a single artifact can serve
   multiple users with different access without a per-user
   rebuild.
2. **The same Context can serve multiple agents.** The paper
   names three (legal-ops contract review, sales renewal-risk,
   GC's-office compliance), all built from the same Box source.
   This is an important economic claim: artifact compile cost is
   amortized across multiple agent-task workloads.
3. **The reference architecture is "compose with existing data
   pipelines," not "displace them."** Box keeps source
   ownership; Unstructured keeps parsing; Nexus owns the artifact
   + query layer. This is a more cooperative posture toward the
   ecosystem than the launch announcement implied.

---

## §7. Concrete deltas from V1 and V2

### 7.1 Things V1 said that this paper confirms

- Output-shape is JSON-schema-shaped. ✅
- Provenance is per-field. ✅
- The "SQL for agents" framing is misleading; GraphQL-shaped is
  more accurate. ✅
- Compile-time vs query-time trade-off has the materialized-views
  shape (high build cost, low query cost, staleness exposure). ✅

### 7.2 Things V1 got wrong / understated

- **V1 framed the Context Compiler as LLM-driven enrichment.**
  It's an autonomous coding agent producing `curate()` and
  `query()` code — closer to "LLM-as-build-engineer" than
  "LLM-as-extractor." (§3.2)
- **V1 framed the user contract as a task spec.** Per the paper,
  it's an eval set: representative tasks with known answers. The
  compiler discovers schema/granularity from the evals. (§3.3)
- **V1 listed six KnowQL primitives.** The technical paper has
  four. Output-shape is folded into intent; confidence does not
  appear as a query-time primitive. (§4.2)
- **V1 didn't recognize the "skills library" as an architectural
  primitive.** It's the operational lever for serving new domains
  by recombination. (§3.1, §3.3)

### 7.3 Things V2's strategic recommendations should be updated for

V2 was written before this technical paper. The high-level
strategic posture in V2 is still right (lead with MCP +
multi-namespace + self-host; treat KnowQL as a future schema
mapping; close per-field-confidence + latency-budget gaps). Two
specific refinements:

- **The "implement KnowQL on top of Textral" mapping in V2 §4
  Scenario B is now cheaper than V2 estimated.** With the wire
  format known (JSON document, four categories), the mapping is
  ~half a day of design and a sprint of implementation. `ask` →
  `query`, `shape` → `output.mode=structured`, `ground` → already
  default-on with `audit.citation_integrity`. Filter and Control
  need new top-level fields. This is straightforward.
- **The "per-field confidence is a Textral gap" framing in V2
  §5.1 may be aiming at a goal Nexus has actually deprecated.**
  Confidence as a query-time primitive is gone in the technical
  paper. The Nexus answer to "is this trustworthy?" is "every
  field carries its source; check the source." That's an
  architecturally simpler answer and one Textral can adopt
  without building a confidence-scoring system. See §8.4.

---

## §8. Implications for Textral

Five concrete reads, each with a recommended response.

### 8.1 The agentic-coding-agent compiler is the deepest moat

The Context Compiler as an autonomous coding agent — writing real
`curate()` and `query()` code, scoring against per-domain evals,
amortizing the skills library across domains — is a substantively
non-trivial engineering investment. This is the part of Nexus
that's hardest to replicate.

**Textral's response:** don't try to replicate the autonomous-coding
compiler in V3. The closer-to-hand pattern that captures most of the
benefit is **eval-driven enrichment-pass selection**: let a tenant
declare a small eval set, then use it to choose between existing
enrichment passes (and their parameters) rather than to *generate*
new ones. This is a 10× simpler engineering problem with 60% of the
benefit.

### 8.2 Eval-set-as-contract is the right abstraction to steal

The most copyable insight from the paper is that **the input
contract from the domain expert is an eval set**, not a schema. A
schema is hard for non-experts to write; ground-truth answers to
real questions are easy.

**Textral's response:** add an eval-set primitive to V3 — let
tenants associate a namespace with an eval set, surface eval-pass
rates in the audit, and use the evals to drive both retrieval-tuning
suggestions and corpus-quality reporting. This is a high-leverage
addition independent of any KnowQL implementation.

### 8.3 KnowQL implementation cost is now low; do it

With the wire format in hand (§4.1), exposing a KnowQL endpoint on
top of Textral's existing query path is a small, durable
positioning win:

```
KnowQL field    → Textral parameter
─────────────────────────────────────
ask             → query
shape           → output.mode = "structured", schema = ...
ground          → retrieval.require_citations (default true)
filter          → namespace + (future) metadata predicates
control         → context.max_context_tokens, max_output_tokens
                  (+ new max_latency_ms — see §8.5)
```

**Textral's response:** ship a `/v1/knowql` endpoint (or an MCP
tool variant) that accepts the JSON wire format and dispatches to
the existing query infrastructure. Anti-lock-in story comes for
free; build cost is small.

### 8.4 Re-think the per-field-confidence investment

V2 §5.1 proposed building per-field confidence. The technical
paper suggests Nexus has *deprecated* per-field confidence as a
query-time primitive in favor of "every field has a citation; the
citation is the trust signal." This is architecturally simpler
and probably better.

**Textral's response:** instead of building per-field confidence
scoring, ensure **every field in a structured output has a
citation chain back to source chunks**. Today the audit returns
citations at the response level; per-field citations on
structured outputs is the thing to build. This is a smaller
project than confidence-scoring and aligns with where the
ecosystem is converging.

### 8.5 Compile-time multi-source artifacts are still the right §5.4 ask

V2 §5.4 proposed compile-time multi-source artifacts. The
technical paper validates this as the structural advantage on
multi-company / multi-step questions (§5.4 of this doc). The
chunking-induced colocation failure (RAG missed Microsoft and
Walmart's repurchase amounts because they were in tables not
colocated with surrounding text) is a *real and serious*
weakness of pure chunked RAG that compile-time artifacts solve.

**Textral's response:** prioritize compile-time multi-source
artifacts higher than V2 implied. The chunking failure is the
single best technical argument the paper makes; matching it (or
demonstrably solving it through MCP fan-out + structured output +
typed shape) is the strongest possible response to the Nexus
narrative.

---

## §9. What's still unknown

Things this paper doesn't tell us, ranked by importance:

1. **Build economics.** Compile cost per filing / per artifact /
   per Context. Without this, the "amortized" claim is
   unfalsifiable.
2. **Recompilation strategy.** When source data changes, how does
   Nexus re-derive artifacts? Full rebuild? Incremental? Triggered
   by what?
3. **Skills library catalog.** What's in it today? What does
   adding a new skill require? Open or closed?
4. **The shape of the response object.** The paper shows the
   request wire format but not the response wire format with
   provenance attached.
5. **Eval-set construction guidance.** How big do evals need to
   be? What's the minimum viable eval set for a new domain?
6. **Performance on less-structured corpora.** 10-Ks are
   structurally clean. Slack/Gong/email are not. KRAFTBench
   doesn't measure these.
7. **Multi-tenant architecture.** Is the Context Compiler a shared
   service across tenants, or per-tenant?
8. **The judge model used for accuracy scoring.** The paper notes
   the same model family (claude-sonnet-4-6) is used as composer
   *and* judge. Self-grading bias is a known risk; an external
   judge or human eval would be a stronger result.

These are good follow-up questions for any future Pinecone
conversation, sharper than the V1 question list because the
broad-strokes architecture is now known.

---

## §10. One-page summary

If this doc gets read once and then forgotten, these are the
things to remember:

- **Nexus is two systems:** an autonomous coding-agent compiler
  that writes `curate()` and `query()` code per domain (build
  time), and a typed-response query engine over the resulting
  artifacts (run time).
- **The user contract is an eval set, not a schema.** Domain
  experts bring tasks + ground-truth answers; the compiler
  discovers everything else.
- **The skills library is the operational lever.** New domains
  served by recombination; new skills added when something
  doesn't fit.
- **KnowQL has four categories** (intent / filter / provenance /
  control). Output-shape is folded into intent. Confidence is no
  longer a query-time primitive.
- **The wire format is JSON, GraphQL-shaped.** `ask` + `ground` +
  `shape` (JSON Schema) is the visible core.
- **KRAFTBench shows real but smaller wins than the launch
  headlines.** Token reduction (~7× vs RAG) is the strongest
  result. Accuracy at 0.680 is best-of-three but not
  production-grade for finance research. The "90% completion"
  launch claim conflates completion with accuracy.
- **The chunking-induced colocation failure** (figures separated
  from surrounding text in tables) is RAG's structural weakness
  on financial docs and the paper's strongest argument for the
  artifact pattern.
- **Box + Unstructured + Nexus is the reference stack.** ACL
  passthrough is enforced at the query surface; one Context
  serves many agents; reference architecture is cooperative not
  displacing.
- **For Textral:** don't replicate the autonomous compiler;
  steal the eval-set-as-contract abstraction; ship KnowQL as a
  thin endpoint; replace per-field confidence ambition with
  per-field citations on structured outputs; prioritize
  compile-time multi-source artifacts.
