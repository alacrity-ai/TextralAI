# Query Rewriting / HyDE / Multi-Query

Today the query path embeds the user's literal question and retrieves against it. That works for well-formed questions; it underperforms on terse, ambiguous, or jargon-heavy queries.

Query rewriting is one of the cheapest accuracy levers in the literature. We're leaving measurable nDCG on the table by not having it.

## Why

- **+3-7pt nDCG** on standard benchmarks (BEIR/MS MARCO) for HyDE and multi-query expansions vs. raw query embedding.
- **Cheap.** A single `gpt-4o-mini` call is ~$0.0001 per query; total query cost goes up <5%.
- **Latency budget fits.** ~200-400ms added; absorbable in an end-to-end query that already takes 8-12s with synthesis.
- **Differentiator vs. raw vector DBs.** Pinecone Assistant has it; Vectara has it. Textral doesn't, today.

## Scope

In:
- Optional `query_rewrite` field on `/query` request:
  ```
  { query_rewrite: { mode: "hyde" | "multi_query" | "step_back" | "none" } }
  ```
- Per-namespace default (`default_query_rewrite_mode`).
- Audit captures the rewritten queries and which one matched the citations.
- Each mode implemented as a deterministic, cheap LLM call (gpt-4o-mini default, configurable).

Out:
- Query rewriting that requires retrieval-of-retrieval (recursive). That's agentic territory.
- Customer-defined custom rewrite prompts. Maybe a v2.

## Sketch

- New file `apps/api/src/query/rewrite.ts`.
- Three modes:
  - **HyDE.** Generate a hypothetical answer; embed *that* instead of the question.
  - **Multi-query.** Generate 3-5 paraphrased versions; embed each; merge candidate sets via RRF before reranking.
  - **Step-back.** Generate a more general version of the question; embed both; merge.
- Branch in `apps/api/src/routes/query.ts` before the embed call: if rewrite mode is set, fan out, then run hybrid retrieval over the union of candidates, dedupe, rerank.
- Audit gains a `query_rewrite` block: `{ mode, generated_queries: [...], generation_latency_ms, generation_cost_usd_micros }`.

## Acceptance Criteria

- `POST /query { query_rewrite: { mode: "multi_query" } }` works against any namespace.
- Audit shows the generated queries, the per-query candidate counts, and the merged final set.
- BEIR-NQ benchmark (or equivalent) shows +3pt+ nDCG@10 vs. mode `none`.
- Latency overhead under +400ms p95.
- All three modes are toggleable independently.

## Open Questions

- **Default mode for new namespaces?** Multi-query is the safest universal choice; HyDE is best on niche corpora; step-back helps with overly-specific questions. Recommendation: ship `none` as default for v1, gather usage data, then re-default.
- **What model generates the rewrites?** Cheap is right (gpt-4o-mini). But if the namespace's `default_inference_model` is Claude, do we use Claude for rewriting too (consistency) or always cheap (cost)?
- **Cache rewrites?** Same query embedded twice today gets two rewrite calls. Worth a small cache keyed on (namespace, query, mode)?
- **Should the audit capture which generated query produced each cited chunk?** Useful for debugging; non-trivial to wire up.

## Related

- [`AGENTIC_RETRIEVAL.md`](./AGENTIC_RETRIEVAL.md) — agentic mode subsumes query rewriting in a fancier way; this is the cheap, single-turn version.
- [`EVAL_AS_A_SERVICE.md`](./EVAL_AS_A_SERVICE.md) — needed to defensibly claim "+3pt nDCG" in marketing.
- [`COST_ATTRIBUTION.md`](./COST_ATTRIBUTION.md) — rewrite generation cost needs to land in the cost block.
