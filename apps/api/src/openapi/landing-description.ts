// The landing-page markdown rendered by Scalar at the top of /docs.
//
// Target ~500 words + small fenced blocks. Per
// docs/SCALAR_DOCS_ENHANCEMENT_PLAN.md §7. Sections:
//   1. Hero        2. Mental model        3. Quickstart
//   4. Concepts    5. Common Recipes      6. Choosing a Strategy
//   7. Failure semantics                  8. Top errors
//   9. Where to go next
//
// Long-form prose belongs on per-tag descriptions, not here.

export const LANDING_DESCRIPTION = `Textral is a multi-tenant, citation-grounded retrieval-augmented
generation API. Bring your own model keys, ingest documents, and
query them with structured audit trails — from a single REST surface.

This API reference is identical whether the deploy you're calling is
**Cloudflare-managed** (Workers + D1 + R2 + Vectorize) or
**self-hosted** (Hono on Node 24 + Postgres + Redis + MinIO +
Qdrant). Same routes, same request/response shapes, same audit
fields. The "how do I stand this up" question lives in the repo's
\`README.md\` + \`docs/QUICKSTART.md\`; this reference covers
"how do I call it."

## Mental model

A **tenant** owns one or more **namespaces**. A namespace declares a
**corpus profile** (e.g. \`generic\`, \`narrative\`, \`legal\`). You
register **documents** under a namespace, upload bytes, and trigger
**ingestion** — which chunks, embeds, indexes, and (depending on the
profile) enriches the content. **Queries** against a namespace return
citation-grounded answers plus a full audit row.

Provider keys (BYOK) are stored server-side. Raw keys never leave
the deploy; on Cloudflare they live in Secrets Store, on self-host
they live in the Redis-backed secrets store wired through the same
\`KvStore\` abstraction. An AI Gateway in front of every upstream
call tags requests with your tenant id for per-tenant cost
attribution (Cloudflare AI Gateway natively, LiteLLM / Helicone on
self-host).

Each namespace also picks a **vector backend** — Vectorize
(Cloudflare-managed default), Qdrant (self-host default; or Qdrant
Cloud), or Pinecone (managed serverless). Backend choice is locked
at create time and transparent to the query path;
\`audit.candidates_returned\` and the rest of the audit shape are
identical across backends.

## 5-minute quickstart

You'll need a Textral API key (your workspace admin or operator
issues this) and an OpenAI key.

\`\`\`bash
# 1. Auth sanity check
curl -H "X-Textral-Api-Key: $KEY" "$BASE/v1/me"

# 2. Register your OpenAI key under label "default"
curl -X POST "$BASE/v1/provider-keys" \\
  -H "X-Textral-Api-Key: $KEY" \\
  -H 'content-type: application/json' \\
  -d '{"provider":"openai","label":"default","key":"sk-..."}'

# 3. Create a namespace using the generic corpus profile
curl -X POST "$BASE/v1/namespaces" \\
  -H "X-Textral-Api-Key: $KEY" \\
  -H 'content-type: application/json' \\
  -d '{"slug":"my-docs","corpus_profile":"generic","default_embedding_profile":"openai-text-embedding-3-large-1536"}'

# 4. Query (after upload + ingest — see Documents and Ingestion tags)
curl -X POST "$BASE/v1/query" \\
  -H "X-Textral-Api-Key: $KEY" \\
  -H 'content-type: application/json' \\
  -d '{"namespace":"my-docs","query":"What does the doc say about X?",
       "embedding":{"provider":"openai","model":"text-embedding-3-large","dimensions":1536,"provider_key_ref":"default"},
       "inference":{"provider":"openai","model":"gpt-4o-mini","provider_key_ref":"default"},
       "chunking":{"profile":"generic"},
       "retrieval":{"strategy":"hybrid_rrf","top_k_dense":5,"top_k_sparse":5}}'
\`\`\`

## Core concepts

| Concept | What it is |
|---------|------------|
| **Tenant** | Top-level isolation boundary. Every API call is scoped to one tenant via the API key. |
| **Namespace** | A retrieval scope inside a tenant. Picks a corpus profile + default embedding model. |
| **Corpus profile** | Declarative chunking + enrichment + retrieval defaults. Five shipped: \`generic\`, \`narrative\`, \`legal\`, \`support\`, \`technical\`. Per-request body overrides win when supplied. |
| **Document → version → version_index** | Bytes are immutable versions. \`version_indexes\` carry the chunking + embedding combo + enrichment status. |
| **Audit trail** | Every query produces a \`query_events\` row; every ingestion stage produces an \`ingest_stage_attempts\` row; daily cost rollups in \`usage_records\`. |

## Common recipes

- **Basic document QA** — \`POST /v1/namespaces\` with
  \`corpus_profile=generic\` + \`POST /v1/query\`.
- **Streaming answer (SSE)** — append \`?stream=sse\` to
  \`POST /v1/query\`.
- **Structured JSON answer** — set \`output.mode='structured'\` with a
  JSON schema on \`POST /v1/query\`.
- **Re-run enrichment after a profile change** —
  \`POST /v1/admin/namespaces/:slug/enrichment-runs\` (admin scope).
- **Run an eval set** —
  \`POST /v1/namespaces/:slug/eval-sets/:id/runs\`.
- **Recover a dead-lettered ingestion job** —
  \`GET /v1/admin/ingestion-jobs?dead_lettered=1\` then
  \`POST /v1/ingestion-jobs/:id/retry\`.
- **Inspect a query post-hoc** — \`GET /v1/query-events/:id\`.
- **Re-embed under a new model** — \`POST /v1/documents/:id/ingest\`
  with \`mode='embed_only'\`.
- **Pluggable vector backend** — \`POST /v1/namespaces\` with
  \`vector_backend='qdrant'\` or \`'pinecone'\` (defaults to
  \`vectorize\` on Cloudflare-managed deploys, \`qdrant\` on
  self-host). Operator setup lives outside the API.

## Choosing a strategy

**Ingestion**

| Goal | Choice |
|------|--------|
| Fastest, passages only | \`corpus_profile=generic\`, \`mode='full'\` |
| Narrative documents | \`narrative\` profile, \`mode='full'\` |
| Legal documents (clauses, obligations) | \`legal\` profile, \`mode='full'\` |
| Backfill enrichment without re-uploading | existing version, \`mode='enrichment_only'\` |
| Re-index under a new embedding model | new \`version_index\`, \`mode='embed_only'\` |
| Pluggable vector store (self-host or non-CF) | \`vector_backend='qdrant'\` or \`'pinecone'\` on namespace create |

**Query**

| Need | Choice |
|------|--------|
| Normal QA | \`POST /v1/query\` |
| Interactive UX (token-by-token) | append \`?stream=sse\` |
| Programmatic JSON output | \`output.mode='structured'\` + schema |
| Higher precision (more cost / latency) | \`retrieval.rerank.enabled=true\` |
| Citation grounded by default | already on; see \`audit.citation_integrity\` |

**Model**

| Need | Choice |
|------|--------|
| Cheap smoke test | Workers AI no-key tier |
| Production quality | OpenAI / Anthropic BYOK |
| Smaller model for enrichment | per-pass \`model:\` override |
| Stronger model for synthesis | \`inference.model\` in \`/v1/query\` |

## Failure semantics

| Outcome | What you see | What it means |
|---------|--------------|----------------|
| \`degradation_level: full\` | Citations + answer | Happy path |
| \`degradation_level: partial\` | Citations + answer, some integrity issues | Some retrieval/synthesis layers degraded |
| \`degradation_level: cannot_answer\` | Empty answer + reason | Provider/quota/empty-corpus failure |
| \`audit.reranker.executed: false\` | Reranker fell back to RRF top-K | Voyage/Cohere unavailable; not a hard failure |

## Error envelope

Every error response uses the same shape:

\`\`\`json
{
  "error": {
    "code": "EMBEDDING_PROFILE_MISMATCH",
    "message": "...",
    "request_id": "req_01H...",
    "details": { }
  }
}
\`\`\`

**Top errors you'll encounter:**

- \`INVALID_API_KEY\` (401) — header missing or key revoked.
- \`INSUFFICIENT_SCOPE\` (403) — admin endpoints require \`admin\` scope.
- \`NAMESPACE_NOT_FOUND\` / \`DOCUMENT_NOT_FOUND\` / \`PROVIDER_KEY_NOT_FOUND\` (404).
- \`EMBEDDING_PROFILE_MISMATCH\` (400) — query model/dimensions don't
  match the namespace's index. Re-ingest, or query with the matching
  \`embedding.model\`.
- \`PROVIDER_KEY_INVALID\` / \`PROVIDER_QUOTA_EXHAUSTED\` (422) — your
  upstream provider rejected the call.
- \`INGESTION_FAILED\` — see the job's \`error_code\` and stage attempts
  for specifics.
- \`ADMIN_RATE_LIMITED\` (429) — bulk-admin endpoints cap at 10/min.

The full catalog lives in
\`packages/contracts/src/error.ts\` (one source of truth).

## Where to go next

- **Provider Keys (BYOK)** — register your OpenAI / Anthropic / Voyage
  / Cohere keys.
- **Namespaces** — pick a corpus profile.
- **Documents** + **Ingestion** — register, upload, ingest.
- **Query** — sync, streaming, structured output.
- **Evaluations** — golden sets, judges, regression gating.
- **Operations** (admin) — DLQ retry, bulk enrichment-only.

Auth: every \`/v1/*\` request requires the \`X-Textral-Api-Key\`
header. Use the auth field in the top-right to paste yours; it
persists across reloads.`;
