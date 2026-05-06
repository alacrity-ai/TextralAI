// Per-tag landing-section markdown rendered above each tag's
// operation list in Scalar. Per docs/SCALAR_DOCS_ENHANCEMENT_PLAN.md
// §8. Each block ~150-250 words.

export const TAG_DESCRIPTIONS: Record<string, string> = {
  // ── Get started ────────────────────────────────────────────────────
  Meta: `Health checks and the OpenAPI surface. Use \`GET /v1/me\` as
your first auth-sanity-check call after pasting your API key into
the auth field above. \`GET /healthz\` is unauthenticated and returns
200 when the Worker is healthy.

The OpenAPI 3.1 spec for this API is served at \`/openapi.json\` and
is the source of truth for SDK generators and client tooling.

This section also lists dev-only debug endpoints — these 404 in
production deploys.`,

  // ── Core integration ───────────────────────────────────────────────
  'Provider Keys': `Bring-your-own-key (BYOK) registration for upstream
LLM, embedding, and reranker providers. Supported providers:

| Provider | Chat | Embedding | Rerank |
|----------|------|-----------|--------|
| OpenAI / OpenAI-compatible | ✓ | ✓ | — |
| Anthropic | ✓ | — | — |
| Voyage | — | ✓ | ✓ |
| Cohere | — | — | ✓ |
| Workers AI | ✓ | ✓ | — |

The Workers AI tier requires no key — it's a Cloudflare binding —
useful for smoke tests but lower-quality than BYOK.

> **Workers AI no-key tier — Cloudflare-hosted only.** Self-hosted
> Textral has no equivalent: every provider request must carry a
> registered key. Self-host operators who want the same "no-key"
> experience can wire an internal LiteLLM proxy with a
> deploy-side OpenAI key as a tenant-shared default.

Each registered key has a \`label\` (human-readable, unique within
\`(tenant, provider)\`). When invoking \`/v1/query\` or \`/v1/ingest\`,
you reference a key by \`provider_key_ref: <label>\` (or
\`provider_key_id: <id>\` for explicit pinning).

Raw keys are stored in Cloudflare Secrets Store (KV-backed in dev,
real Secrets Store in prod) and are **never re-emitted** by any
endpoint. The list endpoint returns metadata only.

If you revoke a key upstream (e.g., rotate your OpenAI key), call
\`POST /v1/provider-keys/{id}/revoke\` to mark it revoked Textral-side
too. Failed calls during the rotation window surface as
\`PROVIDER_KEY_INVALID\` (422).

> **Vector store ≠ provider key.** Vector backends (Vectorize,
> Qdrant, Pinecone) are configured per-namespace at create time —
> see the **Namespaces** tag. They are **not** provider keys; you
> never register a Qdrant or Pinecone API key here. Operator-side
> config (\`QDRANT_URL\`, \`PINECONE_API_KEY\`) lives in the deploy
> environment.`,

  Namespaces: `A **namespace** is a retrieval scope inside a tenant.
Pick one of the five shipped corpus profiles when you create it:

- **\`generic\`** — passages-only fallback. No enrichment. Fastest path.
- **\`narrative\`** — for stories, books, articles. Adds character
  dossier, scene, theme, and section-summary enrichment passes.
- **\`legal\`** — for contracts, leases, regulatory text. Adds clause
  extraction and obligation extraction.
- **\`support\`** — for help-desk content. Adds troubleshooting-step
  extraction.
- **\`technical\`** — for API docs, runbooks. Adds endpoint-reference
  extraction.

The namespace's \`default_embedding_profile\` pins the dense-embedding
model + dimensions for everything indexed there. All ingest + query
calls must match this profile, or you'll get
\`EMBEDDING_PROFILE_MISMATCH\` at query time.

You can override profile defaults per request body — but **arrays
replace wholesale** (e.g., adding \`enrichment.passes\` replaces the
profile's pass list entirely; you must respecify the complete list
to keep existing passes). Scalars override.

If you've ingested under one profile and want to migrate, the
preferred path is: re-ingest the version with the new profile via
\`POST /v1/documents/{id}/ingest\` — versions are immutable but
\`version_indexes\` are not.

## Vector backend selection (V3 Phase 1)

Each namespace pins one of three vector backends at create time:

| Backend | When to pick | \`vector_index_name\` | \`vector_namespace\` |
|---------|--------------|-----------------------|----------------------|
| \`vectorize\` (default on Cloudflare) | Cloudflare-hosted Textral; the simplest path | not set (binding is global) | not used |
| \`qdrant\` (default on self-host) | Self-hosted or Qdrant Cloud; OSS option | collection name (auto-created idempotently at namespace-create time) | not used |
| \`pinecone\` | Managed Pinecone serverless | full host URL (operator pre-provisions the index) | native Pinecone namespace inside the index — defaults to the slug |

**Pinecone multi-tenancy.** The \`vector_namespace\` field maps the
Textral namespace onto a *Pinecone native namespace* inside the
operator-provisioned index. Many Textral namespaces can share one
Pinecone index by varying \`vector_namespace\` — the canonical
Pinecone multi-tenancy pattern. Defaults to the Textral slug.
Cross-namespace isolation happens at the Pinecone REST layer (the
\`namespace\` field on every upsert/query/delete); the existing
\`tenant_id\` metadata filter is preserved as defense in depth.

**Backend availability per runtime:**

| Backend | Cloudflare runtime | Self-host runtime |
|---|---|---|
| \`vectorize\` | ✓ default | ✗ — \`BAD_REQUEST\` at namespace-create |
| \`qdrant\` | ✓ optional | ✓ default |
| \`pinecone\` | ✓ optional | ✓ optional |

Self-host deploys reject \`vector_backend=vectorize\` because
Vectorize is a Cloudflare-only binding. Migrating a Vectorize-
backed namespace to self-host requires re-ingestion under a new
Qdrant or Pinecone-backed namespace (see \`docs/SELF_HOSTING.md\`
§9 for the runbook).

Backend choice is locked at create time. Switching backends after
data is indexed requires a new namespace + re-ingest under
\`mode='full'\`. Same approach to migrate between embedding profiles.

Operator config required:
- Qdrant: \`QDRANT_URL\` env var (e.g.
  \`http://host.docker.internal:6333\` for the local
  \`make dev-stack\` workflow); optional \`QDRANT_API_KEY\` Worker
  secret for Qdrant Cloud.
- Pinecone: \`PINECONE_API_KEY\` Worker secret. The operator
  pre-provisions the serverless index in the Pinecone console
  (dimensions must match \`default_embedding_profile\`); Textral
  references it by host URL via \`vector_index_name\`.`,

  Documents: `Documents have a four-step lifecycle:

1. **Register** — \`POST /v1/namespaces/{slug}/documents\` creates a
   logical document with a title and doc_type.
2. **Upload** — \`POST /v1/documents/{id}/uploads\` returns a URL +
   upload_id. PUT your bytes to the URL with \`x-textral-api-key\`
   as a header (the URL points back at the Worker — Worker-proxied
   upload, not S3-style presigned).
3. **Finalize** — \`POST .../uploads/{upload_id}/finalize\` hashes
   the bytes, deduplicates against existing versions
   (\`UNIQUE(document_id, content_hash)\`), and returns the
   \`version_id\`.
4. **Ingest** — \`POST /v1/documents/{id}/ingest\` (see the
   Ingestion section).

Re-uploading identical bytes returns the existing \`version_id\`. To
update the document content, upload bytes that hash differently — a
new \`version_id\` results.

The R2 layout is \`{tenant_id}/{namespace_id}/{document_id}/{version_id}/source.{ext}\`.
You can read the source bytes via \`GET /v1/documents/{id}/source\`
(useful for debugging a corrupt upload) but the canonical source of
truth is the version row in D1.

Documents that are no longer needed can be soft-deleted via
\`DELETE /v1/documents/{id}\` — chunks are kept (audit) but the
document is removed from query results.`,

  Chunks: `**Chunks** are the retrievable units inside a document
version. Ingestion's chunk + embed stages produce them; retrieval and
re-ranking operate on them; citations point to them.

\`GET /v1/chunks/{id}\` is the operator-facing read surface — it
returns the text, section path, ord, embedding metadata
(\`embedding_status\`, \`embedding_dimensions\`, \`embedding_profile\`,
\`chunking_profile\`), and any \`parent_chunk_id\` /
\`enrichment_pass_id\` linkage. The full chunk JSON omits internal
plumbing columns (vector_id, embedding_input_hash,
embedding_provider_request_id) which are diagnostic-only.

For a document's full chunk waterfall (paginated by \`ord\`,
filterable by \`artifact_type\` and \`version_id\`), see
\`GET /v1/documents/{id}/chunks\` under **Documents**.

Chunks are tenant-scoped — cross-tenant probes resolve to 404 by
design (the same shape as missing rows). \`artifact_type\` is
profile-driven; the default \`generic\` profile only emits
\`passage\` chunks, while \`narrative\`/\`legal\`/\`support\`
profiles add summary and structural artifacts that surface here too.`,

  Ingestion: `Ingestion is a **queue-driven** pipeline. \`POST
/v1/documents/{id}/ingest\` enqueues a job; the Container worker
picks it up, runs the stages, and writes back through the
HMAC-authenticated internal back-channel.

**Stages** (run in order):

1. **fetch** — pulls bytes from R2.
2. **normalize** — converts to canonical document model (CDM).
3. **chunk** — applies the corpus profile's chunker.
4. **embed** — calls \`/internal/providers/embed\` per chunk batch.
5. **index** — upserts vectors to the namespace's configured vector
   backend (Vectorize, Qdrant, or Pinecone) + writes chunks to D1.
6. **enrich** — runs profile-declared enrichment passes (only on
   non-generic profiles).

**Modes:**

- \`mode='full'\` — runs all 6 stages.
- \`mode='embed_only'\` — re-runs embed + index (use after changing
  embedding model).
- \`mode='enrichment_only'\` — runs only enrich (assumes chunks +
  vectors already exist).

**Polling:** \`GET /v1/ingestion-jobs/{id}\` returns the current
status (\`pending\` / \`running\` / \`completed\` / \`failed\`). For
per-stage forensics: \`GET /v1/ingestion-jobs/{id}/logs\`.

**Idempotency:** the runner skips stages whose latest attempt is
\`completed\`. Replaying a partially-failed job picks up where it
left off. Repeated identical \`POST /ingest\` calls return the
existing job id (no duplicate jobs per \`(version_id, mode)\`).

**Failure → DLQ:** after \`attempt_count >= 3\`, the job is
dead-lettered. Recovery via \`POST /v1/ingestion-jobs/{id}/retry\`
(admin scope; see Operations).`,

  Query: `\`POST /v1/query\` runs the full retrieval-and-synthesis
pipeline against a namespace and returns a citation-grounded
answer plus an audit row.

The body is parameterised; the **Cookbook** below shows eight
real-world patterns covering the breadth. Every example is
validated end-to-end against the deployed dev environment by
\`apps/api/scripts/validate-cookbook.ts\` — copy any block, replace
the placeholders, and it runs.

## Pipeline

1. **Embed** the query (\`embedding.provider/model/dimensions\`).
2. **Retrieve** dense (the namespace's configured vector backend —
   Vectorize, Qdrant, or Pinecone) + sparse (D1 FTS5), fuse via
   Reciprocal Rank Fusion (\`retrieval.strategy='hybrid_rrf'\`).
   Backend choice is transparent to the caller — all three return
   the same \`audit.candidates_returned\` and \`audit.retrieval_status\`
   shapes.
3. **Rerank** if the corpus profile enables it — Voyage or Cohere
   cross-encoder re-scores the candidate set. Falls back to RRF
   top-K if the reranker is unavailable;
   \`audit.reranker.fallback_reason\` records why.
4. **Assemble context** under \`context.max_context_tokens\`,
   honouring the corpus profile's per-layer budgets.
5. **Synthesise** with the chosen LLM (\`inference.provider/model\`).
   The platform appends a mandatory citation suffix to whatever
   \`prompt.system\` / \`prompt.developer\` you supply.
6. **Validate citations** post-hoc — drops any \`[N]\` referencing
   chunks that weren't in the retrieved set.

## Cookbook — eight patterns

| # | Pattern | Demonstrates |
|---|---------|--------------|
| 1 | **Basic Q&A** | minimal body, citations, audit shape |
| 2 | **Structured (simple)** | \`output.mode='structured'\` with a one-level schema |
| 3 | **Structured (nested + citations)** | nested schema with a \`citations\` field; round-trip resolution |
| 4 | **Streaming (SSE)** | \`?stream=sse\` consumer pattern |
| 5 | **Document subset** | \`document_ids: [...]\` to scope retrieval |
| 6 | **Custom system prompt** | \`prompt.system\` override + the mandatory suffix |
| 7 | **Cannot-answer recovery** | how to branch on \`degradation_level\` |
| 8 | **Token-budget tweak** | \`context.max_context_tokens\` for cheap models |

Patterns ship as \`x-codeSamples\` on \`POST /v1/query\` (curl + TS +
Python) and as named \`examples\` on the request body — pick from
the dropdown above the request body editor in Try-It to swap
between them.

## Deep-dive: structured output

When you set \`output.mode='structured'\` with a JSON schema, the
platform forwards \`response_format: {type: 'json_schema', schema:
<yours>, strict: true}\` to OpenAI / Anthropic-compat. The model is
constrained to produce schema-conformant JSON; you receive
\`answer.mode='structured'\` with \`answer.object\` parsed and
validated.

**Citations round-trip via the schema.** If your schema declares a
top-level \`citations\` array of objects with \`chunk_id\`, the
platform reads it, filters out chunk_ids the retriever didn't
return, and resolves each surviving entry into the response
shape's top-level \`citations\` array (\`{n, chunk_id, section_path,
quote?}\`). If your schema **omits** \`citations\`, the structured
object passes through unchanged but the top-level \`citations\`
array is empty (\`audit.citation_integrity='missing'\`,
\`degradation_level\` may become \`no_citations\`).

**Recommended schema shape:**

\`\`\`json
{
  "type": "object",
  "properties": {
    "answer": { "type": "string" },
    "key_findings": { "type": "array", "items": { "type": "string" } },
    "citations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "chunk_id": { "type": "string" },
          "quote": { "type": "string" }
        },
        "required": ["chunk_id", "quote"],
        "additionalProperties": false
      }
    }
  },
  "required": ["answer", "key_findings", "citations"],
  "additionalProperties": false
}
\`\`\`

**OpenAI strict-mode gotcha.** OpenAI's \`strict: true\` rejects any
schema with optional properties — every property in an
\`additionalProperties: false\` object must be in \`required\`. If a
field is logically optional, model it as
\`type: ['string', 'null']\` and require the field anyway. The
platform surfaces strict-mode failures as
\`degradation_level='cannot_answer'\` with
\`audit.synthesis_status='failed'\`.

## Streaming consumer pattern

\`?stream=sse\` opens a Server-Sent Events stream. Two event types:

- \`event: token\` with \`data: {"text": "..."}\` — one per content delta.
- \`event: done\` with \`data: <full QueryResponse>\` — emitted once at
  end of stream. Carries the same audit + citations +
  \`degradation_level\` the sync response would carry.

There is **no** \`event: error\` — a mid-stream upstream failure
emerges as a single \`done\` frame with
\`degradation_level='cannot_answer'\` and
\`synthesis_status='failed'\`. Consumers handle one terminal frame
either way.

## Failure-recovery branches

\`degradation_level\` is the canonical signal:

- \`full\` — citations + answer, all integrity checks pass. Ship
  the answer.
- \`partial\` — answer present but some citations dropped. Ship
  with a "may be incomplete" hint.
- \`no_citations\` — answer present but no chunk citations
  validated. Either retrieval missed or the model didn't cite.
  Consider retrying with rerank enabled or a stronger model.
- \`cannot_answer\` — empty answer or synthesis failure. Read
  \`audit.synthesis_status\` and the upstream error message via
  \`GET /v1/query-events/{id}\` for the cause; common: provider
  quota, key revocation, empty corpus, schema-strict-mode
  rejection.

## Audit

Every query produces a \`query_events\` row.
\`GET /v1/query-events/{id}\` returns the canonical \`QueryAudit\`
shape. Beyond the basics (latency, tokens):

- \`audit.reranker.{enabled, executed, fallback_reason, actionable}\` —
  three booleans + a reason. \`actionable=true\` means an operator
  should take note (key revoked, quota exhausted); \`false\` means
  the fallback was transient (provider 5xx, timeout).
- \`audit.tokens.{embedding_input, synthesis_input, synthesis_output, context}\` —
  fine-grained token accounting for cost reconciliation.
- \`audit.citation_integrity\` ∈ \`valid | invalid_removed | missing\`.

## Choosing your knobs

- **Cheap, fast, generic Q&A** — \`corpus_profile=generic\`,
  \`gpt-4o-mini\` synthesis, \`context.max_context_tokens=2000\`,
  no rerank.
- **Higher precision (legal, medical, contract)** — narrative or
  legal profile, \`gpt-4o\` or \`claude-haiku-4-5\` synthesis, rerank
  on, \`top_k_dense/sparse=20\`.
- **Programmatic JSON consumer** — structured output, schema
  with all fields required, \`citations\` field present.
- **Interactive UX** — \`?stream=sse\` + \`gpt-4o-mini\` for low TTFB.`,

  Eval: `Per-namespace **golden sets** for regression evaluation.
Each set holds a list of questions; each question can have an
optional \`expected_answer\` and per-judge prompt overrides.

**Built-in judges:** three of them, each scored 1–5:

- **\`relevance\`** — how on-topic is the answer to the question?
- **\`groundedness\`** — how well does the answer match the cited
  context?
- **\`citation_quality\`** — are citations precise + correctly
  attached?

A question **passes** when every judge's score is at or above the
configured \`pass_threshold\` (default 4).

**Run lifecycle:** \`POST /v1/namespaces/{slug}/eval-sets/{id}/runs\`
runs the set synchronously and returns the run record once every
question has completed. For sets with N>30 questions, expect
multi-second latency; pagination is the consumer's responsibility.

**CLI:** \`packages/eval-cli\` ships a \`textral eval ls/show/run\`
binary that wraps these endpoints. Useful as a CI regression gate.

**Tenant-supplied judges:** per-question \`judge_overrides\` lets
you ship your own prompts for one or more judges (e.g., a custom
\`citation_quality\` rubric tuned to your domain).`,

  // ── Operations (admin scope) ───────────────────────────────────────
  Admin: `**Operator/admin only — not needed for standard
integration.** This section is for operators recovering from
incidents and running bulk maintenance. Day-one consumers do not
need to call any of these.

Endpoints here require an API key with the \`admin\` scope. Calls
made with insufficient scope return \`403 INSUFFICIENT_SCOPE\`. Cross-
tenant probes return \`404\` (consistent with the rest of the API —
existence is never leaked across tenant boundaries).

**DLQ inspection** (\`GET /v1/admin/ingestion-jobs?dead_lettered=1\`)
lists ingestion jobs that hit \`attempt_count >= 3\` and were
dead-lettered. Common causes: invalid provider key, exceeded quota,
malformed input.

**DLQ retry** (\`POST /v1/ingestion-jobs/{id}/retry\`) clears
\`dead_lettered\`, resets \`attempt_count\`, and re-enqueues. After
fixing the underlying issue (e.g., rotating the provider key),
retry the job to pick up where it left off.

**Bulk enrichment-only** (\`POST /v1/admin/namespaces/{slug}/enrichment-runs\`)
selects ready-or-partial \`version_indexes\` in the namespace and
enqueues \`mode='enrichment_only'\` jobs for each. Filterable by
\`profile_id\`, \`since\`, \`until\`. Use \`dry_run=true\` to preview
the matched count before enqueuing.

**Rate limits:** admin batch endpoints cap at 10 calls / minute /
tenant. Exceeding returns \`429 ADMIN_RATE_LIMITED\`.`,

  // ── Tenancy & keys (operator/admin only) ───────────────────────────
  Tenancy: `**Operator/admin only.** Tenant management. Day-one
consumers receive an API key from their workspace admin or operator
and don't interact with this section.

The \`POST /v1/admin/bootstrap\` flow is intentionally hidden from
the public spec (it's authenticated by a one-shot
\`X-Admin-Bootstrap-Token\` Worker secret, not a tenant API key, and
is used by \`make seed-dev\` / the deploy runbook). If you're
running a fresh deploy, see \`docs/runbooks/DEPLOY.md\` and
\`docs/QUICKSTART.md\` for the bootstrap recipe.`,

  'API Keys': `**Operator/admin only.** API-key management.

Scopes are JSON-array tokens stored on the \`api_keys\` row:

- \`*\` — wildcard; admin-tier capability.
- \`admin\` — gates admin endpoints (DLQ, bulk enrichment, etc.).
- \`read\` — read-only endpoints; suitable for analytics consumers.

**Revocation latency:** the resolver caches \`(api_key_hash → tenant)\`
mappings in KV with a 60-second TTL. After \`POST /v1/api-keys/{id}/revoke\`,
the key continues to work for up to 60 seconds. Documented in
\`1-DESIGN.md\` §7.1; the trade-off is the 90%+ cache hit rate that
keeps the auth path fast.

For zero-downtime rotation: issue a new key, switch consumers,
then revoke the old key; the 60-second window covers the
switchover.`,

  MCP: `Textral exposes a **Model Context Protocol** server so any
MCP-compatible agent client (Claude Code, Cursor, Windsurf, Cline,
internal orchestrators) can drive it as a node in agentic pipelines.

The server publishes 16 tools, 3 workflow prompts, and 3 resources.
Every tool routes through the canonical REST surface above —
tenant scoping, redaction, and audit policy apply identically.

**Two transports:**

- \`POST /v1/mcp\` — embedded transport, mounted in-process on the
  Node runtime (self-host). Uses the same \`X-Textral-Api-Key\`
  header as the rest of the v1 surface. Cloudflare-runtime
  deploys return 501 NOT_IMPLEMENTED in Phase 1; use stdio there.
- \`npx @textral/mcp\` — stdio CLI binary. Boots from
  \`TEXTRAL_BASE_URL\` + \`TEXTRAL_API_KEY\` env vars and serves
  JSON-RPC over stdio against any backend (CF or self-host).

The MCP protocol exposes capabilities via JSON-RPC envelopes (not
OpenAPI), so individual tools/prompts/resources don't appear in
this reference. See **docs/mcp/QUICKSTART.md** for client setup,
the full tool list, the workflow prompts, and the audit
configuration.`,
};

/** Convenience: the tags we want a description for, in display order
 *  within their group. */
export const TAGS_WITH_DESCRIPTIONS = Object.keys(TAG_DESCRIPTIONS);
