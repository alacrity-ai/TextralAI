# Pluggable Reranker

Today the reranker is hardcoded to Voyage `rerank-2`. That's a fine default, but it's also a single point of vendor risk and a missed lever for customers who want a different cost/latency/quality tradeoff.

This is the same architectural pattern we already have for embeddings (provider/model abstraction with namespace-scoped defaults). Reranker should follow.

## Why

- **Customer choice.** Different rerankers shine in different domains. Cohere `rerank-3` is strong on multilingual; BGE-reranker-v2 is solid open-source; Voyage `rerank-2` is best-in-class for English; Workers-AI Llama-rerank is zero-egress.
- **Vendor risk.** Voyage going down (or pricing out) shouldn't break every Textral query.
- **Cost tier.** Some customers (free tier, eval) may want to skip rerank entirely.
- **BYO key.** Customers with existing Cohere/Voyage contracts want to use their own keys.

## Scope

In:
- Reranker abstraction matching the existing `embedding_provider` / `inference_provider` patterns.
- Per-namespace default (`default_reranker_profile`) settable at create or update.
- Per-query override.
- Initial provider set: `voyage`, `cohere`, `workers_ai`, `none`.
- Provider-key registration via existing provider_keys flow.
- Audit row reflects which provider/model/keyref ran.

Out:
- Open-source self-hosted rerankers (BGE on customer infra). That's a v2 if there's demand; we'd need a way to call it.

## Sketch

- New table column `namespaces.default_reranker_profile` (nullable; null = `voyage:rerank-2` legacy default for backwards compat).
- New file `apps/api/src/retrieval/reranker.ts` with a `Reranker` interface and provider implementations.
- `runHybridRetrieval` consumes a reranker function rather than calling Voyage directly.
- Audit `reranker` block already has `provider` and `model` fields — populate them honestly.
- Sandbox UI: reranker picker on namespace create/edit.

## Acceptance Criteria

- `POST /namespaces { default_reranker_profile: "cohere:rerank-3" }` works.
- Query against that namespace uses Cohere; audit confirms provider+model+latency+keyref.
- `voyage:rerank-2` remains the implicit default for namespaces without a setting (back-compat).
- `default_reranker_profile: "none"` skips the rerank step; audit shows `reranker.executed: false`.
- BYO Cohere key via `register_provider_key` works end-to-end.
- Sandbox lets admins switch reranker per namespace.

## Open Questions

- **Reranker on the query path or the namespace?** Pinned to namespace for predictability vs. per-query for flexibility. Recommend namespace default + per-query override.
- **Should we offer a "auto" reranker mode** that picks per language/length/cost? Probably out of scope; explicit is better.
- **Workers-AI rerank** — is the Llama-based rerank quality good enough to ship as a real option, or is it a placeholder for "free tier"? Needs benchmarking against EVAL_AS_A_SERVICE before we recommend it.
- **Cost reporting per provider** — Voyage and Cohere price differently per token; the cost calculator (see COST_ATTRIBUTION) needs per-provider price tables.

## Related

- [`INFERENCE_PROVIDERS.md`](./INFERENCE_PROVIDERS.md) — same architectural pattern, different layer.
- [`EVAL_AS_A_SERVICE.md`](./EVAL_AS_A_SERVICE.md) — needed to defensibly compare rerankers.
- [`COST_ATTRIBUTION.md`](./COST_ATTRIBUTION.md) — per-reranker cost tracking.
