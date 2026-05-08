# Eval as a Service

The repo has an `eval/` directory but it's not yet a customer-facing surface or a public benchmark. Without reproducible evaluation, prospects can't compare Textral to competitors, and customers can't detect retrieval quality drift in their own corpora.

This is the most defensible long-term moat we can build, because it compounds: better evals → better defaults → better customer outcomes → more eval data → repeat.

## Why

- **Sales credibility.** Pinecone Assistant, Vectara, OpenAI File Search all publish (or imply) benchmark numbers. We need defensible ones too.
- **Quality drift detection.** Customers with growing corpora can't tell when retrieval starts degrading. An eval-as-a-service product alerts them before users complain.
- **Evidence-based defaults.** Decisions like "default reranker", "default query rewrite mode", "default inference model" should be backed by eval scores, not vibes.
- **The audit-first pitch needs receipts.** "We give you full retrieval lineage" pairs perfectly with "and here's our public eval methodology, run it yourself."

## Scope

Two tiers:

### Tier 1 — Public Benchmark (marketing surface)

In:
- `eval/` directory becomes public; reproducible scripts that run BEIR / MS MARCO / MTEB-RAG against Textral defaults.
- Published results page: nDCG@10, Recall@10, MRR, citation-precision, end-to-end latency, end-to-end cost.
- Comparison tables vs. published numbers from Pinecone Assistant, OpenAI File Search, Vectara, Cohere RAG.
- Re-run on every release; results timestamped and versioned.

### Tier 2 — Customer-Facing Eval (product feature)

In:
- `POST /evaluate` endpoint takes a gold-set (queries + relevant chunk_ids or relevant document_ids) + namespace; returns standard metrics.
- Scheduled re-runs via the same cron infra as connectors / digest jobs.
- Drift alerts via webhooks: "Recall@10 dropped from 0.82 to 0.71 over the last 7 days."
- Sandbox UI for uploading gold sets, viewing scores, configuring alerts.
- Comparative eval: "score this namespace under reranker A vs. reranker B" — a/b at the eval level.

Out (v1):
- LLM-as-judge for synthesis quality. Useful but error-prone; ship retrieval evals first.
- Public leaderboard accepting third-party submissions. v3.
- Multi-language benchmarks. English-first.

## Sketch

- `eval/` becomes a published TypeScript-first eval harness with a CLI: `pnpm eval run --suite beir-nq --namespace mine`.
- Standard metrics: `nDCG@k, Recall@k, MRR, MAP, P@k, CitationPrecision, CitationRecall`.
- Gold-set format: simple JSONL `{ query, relevant_doc_ids: [...], optional_relevant_chunk_ids: [...] }`.
- Tier 2 endpoint: stores gold sets in D1; runs them against the namespace using the existing query path; persists results per run; computes deltas.
- Drift detection: simple z-score over the last N runs; threshold-configurable.

## Acceptance Criteria

- Tier 1: marketing site has a `/benchmarks` page with current scores + methodology + reproducer command.
- Tier 1: scores re-run on every release in CI; results auto-update the page.
- Tier 2: customer uploads 50-query gold set via sandbox; sees scores within 60s.
- Tier 2: scheduled weekly re-run works; drift webhook fires when Recall@10 drops >5%.
- Tier 2: a/b mode works for reranker choice (`evaluate?reranker=cohere` vs `voyage`) and surfaces deltas.

## Open Questions

- **Gold-set creation is the customer's problem.** We can offer LLM-as-judge to bootstrap one ("here are 50 candidate queries from your corpus; mark relevance"), but that's a separable feature.
- **Eval-set contamination.** If the same docs are in the customer's corpus *and* in BEIR's training data, scores are inflated. Document this caveat aggressively.
- **What's the SLA on customer evals?** Async job model is right (eval can take minutes for big sets). Webhook on completion.
- **How much of `eval/` to open-source?** Methodology + harness should be open. The benchmark dataset curation might be a moat. Probably both should be open.
- **Free tier — included or paid?** Tier 1 (public benchmark) is marketing. Tier 2 (customer eval) is a candidate paid feature.

## Related

- [`COST_ATTRIBUTION.md`](./COST_ATTRIBUTION.md) — eval result rows include cost per query, so customers can pick on quality/cost frontier.
- [`PLUGGABLE_RERANKER.md`](./PLUGGABLE_RERANKER.md), [`INFERENCE_PROVIDERS.md`](./INFERENCE_PROVIDERS.md), [`QUERY_REWRITING.md`](./QUERY_REWRITING.md) — every variant lever benefits from defensible eval scores.
- [`DOMAIN_TUNING.md`](./DOMAIN_TUNING.md) — domain tuning is meaningless without before/after eval scores.
- [`WEBHOOKS.md`](./WEBHOOKS.md) — drift alerts are a webhook event.
