# Domain-Tuned Embeddings & Rerankers

Generic embeddings and rerankers (OpenAI text-embedding-3-large, Voyage rerank-2, Cohere rerank-3) are excellent on broad text. They underperform on specialized domains: legal, medical, code, scientific literature, internal company jargon.

A managed "we'll fine-tune a reranker on your corpus" pitch is a real wedge against generic vector DBs. Customers in regulated/specialized verticals will pay for it.

## Why

- **Quality lift.** A LoRA-tuned reranker on a domain corpus typically lifts nDCG@10 by 5-12 points over the generic baseline.
- **Verticalization wedge.** Pinecone and Vectara mostly don't do this; OpenAI doesn't fine-tune embeddings; Cohere does fine-tuned rerankers but it's complex. A turnkey product here is differentiated.
- **Pairs with eval-as-a-service.** Domain tuning is meaningless without before/after scores.
- **Recurring revenue.** Tuning is a one-time engagement; hosting the tuned model is a recurring subscription.

## Scope

In:
- Hosted fine-tuning pipeline. Customer uploads (or imports from existing namespace) a corpus + (optional) labeled query/relevant pairs.
- Two tuning paths:
  1. **Reranker LoRA** (preferred default). Fine-tune `bge-reranker-v2-m3` or similar on customer pairs. Cheaper, lower-impact deployment, no re-embed required.
  2. **Embedding adapter** (advanced). Train a small adapter on top of existing embeddings; requires re-embedding the corpus (expensive but higher ceiling).
- Hosting: Workers AI for inference; tuned model becomes a reranker provider option (`reranker:tenant_<id>:model_<id>`).
- Eval before/after using EVAL_AS_A_SERVICE. Customer sees lift before paying.
- Sandbox UI: tuning job creation, progress, eval results, deployment toggle.

Out (v1):
- Tuning embedding base models (vs. just adapters). Possible v2.
- Multi-tenant model sharing. Each tenant's tuned model is private.
- Customer-supplied training infra. We host; we tune; we deploy.

## Sketch

- Bootstrap label generation: for customers without labels, offer "we'll generate synthetic queries from your corpus using an LLM, you mark relevance" — converts generic corpora into trainable pairs.
- Training infra: Modal Labs / Replicate / a CF Workers AI training endpoint (TBD which fits price model best).
- Tuned model artifact stored in R2; loaded by Workers AI inference at query time.
- Reranker provider gains a new prefix: `reranker: "tenant_01ABC:model_01XYZ"`.
- Audit reflects tuned-model use distinctly from base provider.
- Pricing: per-training-run + per-query premium for tuned-model inference.

## Acceptance Criteria

- Customer with a 10k-doc legal corpus + 200 labeled query/relevant pairs runs a tuning job.
- Job completes within 24h.
- Eval shows ≥+5pt nDCG@10 vs. generic Voyage rerank-2.
- Tuned model is deployable to a namespace via sandbox toggle.
- Tuned model query latency comparable to (within 50ms of) generic reranker.
- Tuning job cost shown upfront; query premium applied per-query.

## Open Questions

- **Training infrastructure.** Modal vs. Replicate vs. Workers AI fine-tuning vs. roll-our-own on Hyperdrive. Choice depends on price/SLA/quality. Probably Modal for v1 (most flexible).
- **Synthetic-query bootstrap quality.** LLM-generated training pairs lift quality, but how much? Needs eval. Customers without labels will use this path; quality must be defensible.
- **IP / data handling.** Customer's corpus → our training infra. Contract carefully. Most likely: training data deleted after the job; only the resulting LoRA persists.
- **Tuning-as-a-service vs. tuning-results-only-customer-can-use.** Latter (tenant-private) is the default. Could we offer "shared domain models" (e.g. a shared "legal" model trained on consenting tenants' data)? Complex; probably v3.
- **Pricing model.** $X per training run + $Y/query premium? Per-tier (basic/pro/enterprise)? Blocked on broader pricing strategy.

## Related

- [`PLUGGABLE_RERANKER.md`](./PLUGGABLE_RERANKER.md) — tuned models slot in as another reranker provider.
- [`EVAL_AS_A_SERVICE.md`](./EVAL_AS_A_SERVICE.md) — hard prereq; tuning without measurement is selling vibes.
- [`COST_ATTRIBUTION.md`](./COST_ATTRIBUTION.md) — tuning + tuned-inference need cost reporting.
- [`INFERENCE_PROVIDERS.md`](./INFERENCE_PROVIDERS.md) — fine-tuned synthesis models are a v2 extension.
