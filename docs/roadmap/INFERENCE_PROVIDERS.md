# Inference Provider Expansion (Claude / Gemini / Workers-AI / etc.)

Synthesis is OpenAI-only today (`gpt-4o-mini`, `gpt-4o`). The "BYO provider key" story is incomplete without a way to route synthesis to the customer's preferred LLM.

This is the same architectural pattern we already have for embeddings; inference should follow.

## Why

- **Compliance buyers** (healthcare, legal, finance) often have an Anthropic or AWS Bedrock contract and cannot send PHI/PII through OpenAI.
- **Cost-sensitive customers** want Gemini Flash or Workers-AI Llama for ~10× cheaper synthesis.
- **Quality-sensitive customers** want Claude Sonnet 4.6 / Opus 4.7 for highest-fidelity answers.
- **Zero-egress customers** want Workers-AI for synthesis to keep traffic on Cloudflare.
- **Vendor-risk hedge.** OpenAI outage shouldn't break Textral synthesis.

## Scope

In:
- Inference provider abstraction matching `embedding_provider` and (future) `reranker_provider`.
- Initial provider set: `openai`, `anthropic`, `google`, `workers_ai`.
- Per-namespace default (`default_inference_model: "anthropic:claude-sonnet-4-6"`).
- Per-query override.
- Citation format normalization across providers (each LLM emits citations differently).
- Streaming uniform interface across providers.
- BYO key via existing provider_keys flow.

Out (v1):
- AWS Bedrock, Azure OpenAI as separate providers. Both surface the same models with different keys; doable in v2.
- Self-hosted/on-prem LLM endpoints. Doable but out of v1 scope.
- Multi-model "best of N" synthesis. Possible eval feature; not for production query path.

## Sketch

- New file `apps/api/src/inference/providers/{openai,anthropic,google,workers_ai}.ts` implementing a common `InferenceProvider` interface (chat, stream-chat, function-call).
- Dispatcher `getInferenceProvider(model_string)` routes by prefix (`openai:`, `anthropic:`, etc).
- Citation format: each provider's native citation/tool-use mechanism is normalized to the contract's citation shape:
  - Anthropic: native citations (post-Claude-4.x).
  - OpenAI: structured outputs / JSON mode.
  - Google: structured outputs (when Gemini supports them well).
  - Workers AI: prompt-engineered for now.
- Streaming: SSE events normalized to a common envelope.
- New table column `namespaces.default_inference_model` (already exists per the schema we saw — wire it up).

## Acceptance Criteria

- `POST /namespaces { default_inference_model: "anthropic:claude-sonnet-4-6" }` works.
- Query against that namespace produces a synthesized answer with valid citations.
- Same query path works for `openai:gpt-4o-mini`, `google:gemini-1.5-flash`, `workers_ai:llama-3.1-8b`.
- Audit reports correct provider/model/tokens/cost (with cost catalog from COST_ATTRIBUTION).
- Streaming responses work uniformly across providers.
- Citation integrity (the existing `citation_integrity: "valid"` invariant) holds across all providers.

## Open Questions

- **Citation quality varies wildly across providers.** Anthropic native citations are the gold standard; OpenAI is OK with structured outputs; Gemini is rough; Workers AI Llama needs prompt-engineering. Should we publish a quality matrix? Almost certainly yes — see EVAL_AS_A_SERVICE.
- **What about non-citing providers** (e.g. customer wants Gemini and is willing to accept worse citations)? Allow with a warning, or hard-block? Recommend allow + audit warning.
- **Default for new namespaces.** Stay on `openai:gpt-4o-mini` for v1 (broadest compatibility). Re-default once we have eval data.
- **Anthropic prompt caching** — huge cost saver for retrieval+synthesis flows. Should be on by default for the Anthropic provider; document the caching breakpoints.
- **Tool-use / structured-output uniformity.** Each provider has its own format. The contract layer needs to hide that.

## Related

- [`PLUGGABLE_RERANKER.md`](./PLUGGABLE_RERANKER.md) — same architectural pattern, different layer.
- [`COST_ATTRIBUTION.md`](./COST_ATTRIBUTION.md) — per-provider price catalog is a hard prereq.
- [`EVAL_AS_A_SERVICE.md`](./EVAL_AS_A_SERVICE.md) — quality matrix across providers.
- [`AGENTIC_RETRIEVAL.md`](./AGENTIC_RETRIEVAL.md) — agentic mode benefits hugely from prompt-cached Anthropic.
