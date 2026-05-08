# Retrieval-Only Query Mode

Today every `/query` call goes embedding → retrieve → rerank → **synthesize**. Synthesis is the largest cost and latency contributor. Some customers don't want it: they want the ranked chunks back so they can pipe them into their own LLM stack.

This is also a wedge against managed-RAG services that gate retrieval behind their synthesizer.

## Why

- **Cost control.** Retrieval-only is ~5-20× cheaper than retrieval+synthesis on most queries.
- **Latency.** P95 drops from ~10s to ~500-1500ms when synthesis is skipped.
- **Power-user UX.** Sophisticated customers run their own prompt engineering and just want chunks.
- **Compliance.** Customers using on-prem LLMs for synthesis can still use Textral as their hosted retrieval layer.
- **Eval pipelines.** Most retrieval evals (nDCG, Recall@k, MRR) operate on ranked chunks, not synthesized answers.

## Scope

In:
- New request flag: `synthesis: false` on `/query` (and `/query-stream`).
- Response shape returns ranked chunks + audit; `answer` field is `null` (or omitted under a v2 contract).
- Audit reflects mode (`synthesis_status: "skipped"`).
- Cost reflects retrieval-only (no synthesis tokens).
- MCP exposes the flag on the `query` tool.
- SDK and Python SDK expose the flag.

Out:
- Major contract version bump. Stay backwards-compatible — `synthesis: true` is default.
- Removing the synthesis path. This is an option, not a replacement.

## Sketch

- Branch in `apps/api/src/routes/query.ts` after retrieval+rerank but before synthesis: if `body.synthesis === false`, finalize audit with `synthesis_status: "skipped"` and short-circuit the response.
- `QueryResponse` schema: make `answer` nullable (it already is when synthesis fails).
- Reranker still runs by default in retrieval-only mode (it's the value-add over a raw vector DB). Optional flag `reranker: false` to skip.
- New audit fields are unnecessary — `synthesis_status` enum gains `"skipped"`.

## Acceptance Criteria

- `POST /query { synthesis: false }` returns within 1.5s p95 against a warm namespace.
- Response includes ranked chunks with full content + section_path + score.
- `audit.synthesis_status === "skipped"`; synthesis token counts are 0 or absent.
- Cost in audit reflects only embedding + retrieval + (optional) rerank.
- MCP tool surfaces the flag with a sensible default.
- Existing `synthesis: true` (default) behavior is bit-for-bit unchanged.

## Open Questions

- **Should `reranker: false` be a separate flag or a single `mode: "fast" | "ranked" | "synthesized"` enum?** Probably the enum is cleaner long-term but changes the contract more.
- **Top-K default?** Today retrieval candidates feed synthesis at one K; for retrieval-only the user might want a higher K (e.g. 20) since they're going to filter themselves.
- **Should we expose embedding-only mode** (return only the query embedding for hybrid use cases)? That's possibly its own roadmap item, not bundled here.

## Related

- [`COST_ATTRIBUTION.md`](./COST_ATTRIBUTION.md) — retrieval-only mode makes cost reporting more important, since the savings are the whole point.
- [`EVAL_AS_A_SERVICE.md`](./EVAL_AS_A_SERVICE.md) — eval harness depends on retrieval-only.
