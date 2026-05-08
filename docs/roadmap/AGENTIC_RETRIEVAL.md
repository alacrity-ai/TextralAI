# Agentic / Multi-Hop Retrieval

Single-turn retrieval-then-synthesize hits a hard ceiling on questions that require:
- Decomposition ("compare X vs. Y across these docs")
- Sequential reasoning ("what changed between version 2 and version 5?")
- Cross-document synthesis ("aggregate every mention of Z")

Pinecone Assistant has agentic retrieval. So does Vectara. We don't. This is one of the highest-leverage wedges available.

## Why

- **Quality ceiling.** Single-turn fundamentally cannot answer multi-hop questions well, no matter how good the reranker.
- **Differentiation.** Most managed RAG services are still single-turn; agentic is where the frontier is moving.
- **Pairs with audit-first.** Agentic retrieval has a much richer trace; our audit story makes it explainable in a way few competitors can match.
- **Anthropic prompt caching makes this cheap.** Each hop reuses the namespace context — cache hits across hops drop cost dramatically.

## Scope

In:
- New mode: `POST /query { mode: "agentic" }` (or new endpoint `/agent-query` if the contract diverges enough).
- Planner LLM decomposes question → sub-queries.
- Each sub-query runs hybrid retrieval (with rerank).
- Synthesizer composes a single answer with citations spanning all hops.
- Full hop trace in audit: each hop's sub-query, candidates, citations.
- Per-hop streaming events in `/query-stream`.
- Max-hop budget (default 3, configurable up to 5).
- Per-hop timeout and global timeout.

Out (v1):
- Tool-use beyond retrieval (web search, function calling, code execution). Pure-retrieval agent only.
- Branching exploration trees. Linear chain only for v1.
- Customer-defined planner prompts. Use a fixed, well-tuned default.

## Sketch

- New file `apps/api/src/query/agent.ts`.
- Planner: cheap LLM (gpt-4o-mini or Claude Haiku) + a fixed prompt that decomposes into 1-N sub-queries with declared dependencies.
- Loop: for each hop in order, run hybrid retrieval, accumulate candidates with hop attribution.
- Stop conditions: planner returns "no more hops needed", max-hops reached, global timeout.
- Synthesizer: high-quality LLM (Claude Sonnet 4.6 or gpt-4o) sees union of candidates (deduped) + the hop trace, produces final answer with citations.
- Audit gains:
  ```
  agent: {
    planner: { model, latency_ms, hops_planned: [...] },
    hops: [{ sub_query, retrieval, citations_used }, ...],
    synthesizer: { model, latency_ms, ... }
  }
  ```

## Acceptance Criteria

- "Compare Eratosthenes' contributions to those of Hipparchus across the corpus" produces an answer that synthesizes from chunks in different sections, with citations from each.
- Audit shows the hop trace with sub-queries.
- Streaming emits hop events (`hop.start`, `hop.retrieved`, `hop.complete`) ahead of `synthesis.start`.
- Max-hops cap is enforced; over-budget questions return partial-answer + warning.
- Latency p95 under 30s for 3-hop queries (heavy use of prompt caching).
- Cost reported correctly per hop in cost_breakdown.

## Open Questions

- **Single planner pass vs. iterative replanning.** Iterative is more powerful (planner can adjust based on hop results) but slower and more expensive. Recommend single-pass for v1.
- **Citation deduplication across hops.** Same chunk cited from multiple hops — collapse or preserve attribution? Recommend collapse with hop-list metadata.
- **Failure mode when planner can't decompose.** Fall back to single-turn and flag the audit, or fail loudly? Recommend silent fallback with audit signal.
- **Cost ceiling.** Agentic queries can be 5-10× the cost of single-turn. Default budget? Per-tenant cap?
- **Should this be the default once it's solid?** Probably not — single-turn is right for most queries; agentic is opt-in. Possibly an "auto" mode that picks per query complexity, but that's a v2 lever.

## Related

- [`QUERY_REWRITING.md`](./QUERY_REWRITING.md) — agentic subsumes query rewriting; ship rewriting first as the cheap version.
- [`INFERENCE_PROVIDERS.md`](./INFERENCE_PROVIDERS.md) — agentic shines with Anthropic + prompt caching.
- [`COST_ATTRIBUTION.md`](./COST_ATTRIBUTION.md) — agentic cost breakdown matters more than for single-turn.
- [`EVAL_AS_A_SERVICE.md`](./EVAL_AS_A_SERVICE.md) — needed to demonstrate the quality lift over single-turn.
