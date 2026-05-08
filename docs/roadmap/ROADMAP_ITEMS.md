# Roadmap Items

Index of roadmap docs. Within each tier the order roughly reflects priority,
but tiers themselves are not strictly sequential — many items can ship in
parallel and several have dependencies on each other (see each doc's
"Related" section).

## Already on the roadmap

- [x] **MCP Environments** — multi-environment MCP support. See [`MCP_ON_CLOUDFLARE.md`](./MCP_ON_CLOUDFLARE.md). _(✓ resolved by MCP V2 — see banner.)_
- [ ] **Bulk Upload** — multi-file ingestion through API/MCP/sandbox. Canonical design + implementation plan live in [`docs/development/bulk_ingest/`](../development/bulk_ingest/) (`BULK_UPLOADS_DESIGN.md` + `BULK_UPLOADS_IMPLEMENTATION.md`). Historical context: [`BULK_UPLOAD_SANDBOX.md`](./BULK_UPLOAD_SANDBOX.md) (problem statement), [`LARGE_INGEST_ISSUE.md`](./LARGE_INGEST_ISSUE.md) (the MCP-side b64-into-context failure mode).
- [ ] **Intent-Driven MCP** — smarter MCP tool routing. See [`INTENT_DRIVEN_MCP.md`](./INTENT_DRIVEN_MCP.md).
- [ ] **Integrations** — third-party source connectors. See [`INTEGRATIONS.md`](./INTEGRATIONS.md). _Pairs with the connector framework in [`CONNECTOR_MARKETPLACE.md`](./CONNECTOR_MARKETPLACE.md)._

## Table-stakes (parity gaps the market expects)

These are the gaps where prospects compare us to Pinecone/Vectara/OpenAI File Search and find us short. None of them are individually a moat; collectively, missing them is a ceiling on serious adoption.

- [ ] **Python SDK** — `pip install textral`. See [`PYTHON_SDK.md`](./PYTHON_SDK.md).
- [ ] **Retrieval-Only Mode** — skip synthesis for cost/latency. See [`RETRIEVAL_ONLY_MODE.md`](./RETRIEVAL_ONLY_MODE.md).
- [ ] **Pluggable Reranker** — Voyage / Cohere / BGE / Workers AI / none. See [`PLUGGABLE_RERANKER.md`](./PLUGGABLE_RERANKER.md).
- [ ] **Query Rewriting** — HyDE / multi-query / step-back. See [`QUERY_REWRITING.md`](./QUERY_REWRITING.md).
- [ ] **Metadata Filters** — `where: { tag: "policy" }` on retrieval. See [`METADATA_FILTERS.md`](./METADATA_FILTERS.md).
- [ ] **Webhooks** — tenant event subscriptions. See [`WEBHOOKS.md`](./WEBHOOKS.md).
- [ ] **Embed Widget** — 3-line script tag for chat-with-docs. See [`EMBED_WIDGET.md`](./EMBED_WIDGET.md).
- [ ] **Cost Attribution** — populate `total_cost_usd_micros` per query. See [`COST_ATTRIBUTION.md`](./COST_ATTRIBUTION.md).
- [ ] **Inference Providers** — Claude / Gemini / Workers AI synthesis. See [`INFERENCE_PROVIDERS.md`](./INFERENCE_PROVIDERS.md).

## Wedges (differentiating bets)

These are the gaps that, if we lean in hard, could make Textral genuinely uncatchable in its corner. Pick one or two to invest in deeply rather than scattering.

- [ ] **Agentic Retrieval** — multi-hop, decompose-then-synth. See [`AGENTIC_RETRIEVAL.md`](./AGENTIC_RETRIEVAL.md).
- [ ] **Eval as a Service** — public benchmark + customer drift detection. See [`EVAL_AS_A_SERVICE.md`](./EVAL_AS_A_SERVICE.md).
- [ ] **Connector Marketplace** — Notion / GitHub / Slack / Drive / Confluence. See [`CONNECTOR_MARKETPLACE.md`](./CONNECTOR_MARKETPLACE.md).
- [ ] **Domain Tuning** — fine-tuned rerankers/embeddings on customer corpora. See [`DOMAIN_TUNING.md`](./DOMAIN_TUNING.md).

## Cross-cutting dependencies

A few items are heavily depended-on by others; if you sequence work, lean on
this graph:

```
COST_ATTRIBUTION ──┬──> EMBED_WIDGET (rate-limit/cost on public tokens)
                   ├──> EVAL_AS_A_SERVICE (cost-per-query in eval rows)
                   └──> DOMAIN_TUNING (training run pricing)

EVAL_AS_A_SERVICE ──┬──> PLUGGABLE_RERANKER (defensible A/B claims)
                    ├──> INFERENCE_PROVIDERS (quality matrix)
                    ├──> QUERY_REWRITING (defensible nDCG lift claims)
                    ├──> AGENTIC_RETRIEVAL (defensible quality lift)
                    └──> DOMAIN_TUNING (before/after measurement)

WEBHOOKS ──────────┬──> CONNECTOR_MARKETPLACE (state events)
                   └──> EVAL_AS_A_SERVICE (drift alerts)

METADATA_FILTERS ──┬──> CONNECTOR_MARKETPLACE (auto-tag by source)
                   └──> EMBED_WIDGET (faceted UX)
```

If you're picking a starting wedge: **EVAL_AS_A_SERVICE** is the highest-leverage
investment, because it converts every other item from "trust us" to
"here's the receipt." Cost attribution is the closest thing to a hard prereq
under it.
