# Textral AI — Cloudflare RAG Service Refactor

## Current Application

Textral AI is currently designed as a full-stack RAG application for narrative intelligence. The existing architecture assumes a product-facing application shape:

```text
React Frontend
  → NestJS API / BFF
  → Orchestrator Layer
  → Python RAG Core
  → Qdrant Vector DB
````

The current design is built around an end-user UI: upload books, manage a library, ask questions, persist conversations, and receive citation-grounded answers. Internally, however, the most valuable part of the system is not the UI. It is the RAG intelligence layer: ingestion, normalization, document-specific enrichment, chunking, embedding, retrieval strategy, context assembly, synthesis, and citation validation.

The existing backend already contains the right architectural ingredients: asynchronous ingestion, a canonical document model, multi-layer derived artifacts, tenant isolation, provider abstractions, evaluation hooks, and retrieval-quality-first design. The problem is that these capabilities are currently framed as part of a product application rather than as a reusable RAG service.

## What We Want To Do

We want to separate the backend intelligence layer into its own API-driven service that can be deployed cheaply on Cloudflare and consumed by upstream applications with RAG needs.

Instead of requiring every upstream application to implement its own ingestion, embedding, vector storage, enrichment, and retrieval stack, upstream consumers should be able to call Textral as a service:

```text
POST /v1/documents
POST /v1/documents/:id/ingest
GET  /v1/ingestion-jobs/:id
POST /v1/query
```

The service should accept documents from other applications, run the appropriate ingestion/enrichment pipeline, persist the source and derived artifacts, index the embeddings, and later answer RAG queries against those documents with citations.

This makes Textral less of a single-purpose UI application and more of a reusable **RAG infrastructure service**.

## Target Architecture

The new architecture will be Cloudflare-first and API-first:

```text
Upstream Applications
        │
        ▼
Cloudflare Worker API
        │
        ├── Auth / API keys
        ├── Tenant resolution
        ├── REST API validation
        ├── Upload URL generation
        ├── Job creation
        └── Query façade
        │
        ├── R2
        │     └── original documents, normalized text, artifacts
        │
        ├── D1
        │     └── tenants, documents, versions, jobs, chunks, usage
        │
        ├── Queues
        │     └── async ingestion / enrichment dispatch
        │
        ▼
Cloudflare Container: RAG Core
        │
        ├── document classification
        ├── normalization
        ├── corpus-specific enrichment
        ├── chunking
        ├── embedding orchestration
        ├── retrieval strategy
        ├── context assembly
        ├── synthesis
        └── citation validation
        │
        ▼
Cloudflare Vectorize
        └── vector persistence and nearest-neighbor search
```

The Worker API remains stateless. Durable state lives in Cloudflare-managed services:

```text
R2        → source files and derived artifacts
D1        → metadata, jobs, chunks, audit/usage records
Queues    → async ingestion and reindex work
Vectorize → vector index
Container → stateless RAG compute
```

Because the RAG Core container does not own durable state, it can be restarted, scaled, or replaced safely. Every job is replayable and idempotent through deterministic document/version/chunk/vector identifiers.

## Deployment Shape

For MVP, we will use:

```text
one public Cloudflare Worker
one R2 bucket
one D1 database
one ingestion queue
one Cloudflare Container running RAG Core
one or two Vectorize indexes
```

Questions and ingestion do not need separate public Workers initially. They should be separate route modules inside one Worker:

```text
/v1/documents
/v1/ingestion-jobs
/v1/query
```

The distinction is operational rather than architectural:

```text
Queries   → synchronous request/response path
Ingestion → asynchronous queue-backed path
```

This keeps deployment simple while preserving the right internal boundaries.

## Long-Term Shape

The system will remain portable by keeping Cloudflare-specific services behind interfaces:

```text
R2        → ObjectStore
D1        → MetadataStore
Queues    → EventBus
Vectorize → VectorStore
Workers AI/OpenAI/Anthropic → Provider interfaces
```

If needed later, we can replace:

```text
Vectorize → Qdrant
D1        → Postgres
R2        → S3 / Azure Blob
Queues    → SQS / NATS / Redis Streams
Container → Kubernetes / ECS / AKS
```

without changing the public API or rewriting the RAG Core.

## Final Goal

The refactor turns Textral AI from a UI-centered RAG application into a reusable Cloudflare-hosted RAG service.

The new application will be:

```text
API-first
Cloudflare-native
cheap to operate
stateless at the compute layer
tenant-isolated
idempotent and replayable
designed for bespoke enrichment
portable to Qdrant/Kubernetes later
consumable by any upstream application with RAG needs
```

The core thesis is simple:

> Textral should become the shared document intelligence backend.
> Upstream products should bring documents and questions.
> Textral should handle ingestion, enrichment, retrieval, synthesis, and citations.

# FIRST CLASS INVARIANTS

## Purpose

Textral is being refactored from a narrative-focused RAG application into a general-purpose, API-driven RAG service. The existing system’s valuable core is not the UI or “novel chat” product shell; it is the RAG intelligence layer: ingestion, normalization, enrichment, embedding, retrieval, context assembly, synthesis, citation validation, failure semantics, and evaluation. Those principles remain, but the service must no longer be tied to books, novels, chapters, characters, or any fixed product workflow. :contentReference[oaicite:0]{index=0}

Textral should become a reusable backend for upstream applications with RAG needs.

```text
Upstream application
  → register document
  → upload source
  → choose ingestion/enrichment/embedding behavior
  → query later with chosen retrieval/inference/prompt behavior
  → receive citation-grounded output
````

The core invariant:

> Textral owns the durable RAG execution substrate.
> Upstream consumers own the product intent.

---

## 1. Platform Vocabulary Must Be Generic

Core APIs, storage, and service boundaries must use generic document-intelligence terms.

Use:

```text
tenant_id
namespace_id
document_id
version_id
doc_type
corpus_profile
artifact_type
enrichment_pass
chunk_id
vector_id
query_event_id
```

Avoid platform-core names such as:

```text
book_id
novel_id
chapter
character
scene
theme
```

Those concepts may exist only as domain-specific artifact types inside a corpus profile, for example:

```text
narrative.character_dossier
narrative.scene_summary
legal.clause
legal.obligation
support.troubleshooting_step
technical.endpoint_reference
```

The platform must be able to serve legal docs, leases, support docs, technical docs, code-adjacent docs, sales/CPQ material, knowledge bases, and narrative corpora without a rewrite.

---

## 2. Ingestion Must Be Parameterized

When ingesting a document, the upstream consumer must be able to specify the meaningful parts of the ingestion pipeline.

The ingestion API should support:

```text
doc_type
corpus_profile
embedding provider/model
chunking profile
enrichment passes
enrichment model(s)
required vs optional enrichment behavior
indexing behavior
artifact types to generate
```

Example:

```json
{
  "version_id": "ver_01HY...",
  "doc_type": "lease_agreement",
  "corpus_profile": "legal",
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-large"
  },
  "chunking": {
    "profile": "legal_clause_aware"
  },
  "enrichment": {
    "enabled": true,
    "default_model": {
      "provider": "openai",
      "model": "gpt-5.4-mini"
    },
    "passes": [
      {
        "name": "clause_extraction",
        "enabled": true,
        "required": true
      },
      {
        "name": "obligation_extraction",
        "enabled": true,
        "required": false,
        "model": {
          "provider": "openai",
          "model": "gpt-5.4"
        }
      }
    ]
  },
  "indexing": {
    "replace_existing_vectors": true,
    "artifact_types": ["passage", "clause", "obligation"]
  }
}
```

Textral should provide sensible defaults through named profiles, but consumers must be able to override pipeline behavior where it affects cost, quality, semantics, or compatibility.

---

## 3. Querying Must Be Parameterized

When questioning a document or corpus, the upstream consumer must be able to specify the inference behavior.

The query API should support:

```text
query embedding provider/model
inference provider/model
retrieval strategy
artifact types to search
document filters
top_k
context budget
compression policy
citation requirements
output format
prompt/system instructions
structured output schema
```

Example:

```json
{
  "namespace": "leases",
  "document_ids": ["doc_01HY..."],
  "query": "What happens if the tenant pays rent late?",
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-large"
  },
  "inference": {
    "provider": "openai",
    "model": "gpt-5.5",
    "max_output_tokens": 1600
  },
  "retrieval": {
    "strategy": "legal_clause_grounded",
    "top_k": 12,
    "artifact_types": ["passage", "clause", "obligation"],
    "require_citations": true
  },
  "context": {
    "max_context_tokens": 12000,
    "allow_compression": false
  },
  "prompt": {
    "system": "You are analyzing lease documents for a landlord-facing SaaS application. Answer in plain English and distinguish contractual text from legal advice.",
    "developer": "Use only retrieved context. If the retrieved context is insufficient, say so explicitly.",
    "template_id": "lease_plain_english_v1"
  },
  "output": {
    "mode": "structured",
    "schema": {
      "type": "object",
      "properties": {
        "answer": { "type": "string" },
        "risk_level": { "type": "string", "enum": ["low", "medium", "high", "unknown"] },
        "citations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "chunk_id": { "type": "string" },
              "quote": { "type": "string" }
            },
            "required": ["chunk_id", "quote"]
          }
        }
      },
      "required": ["answer", "risk_level", "citations"]
    }
  }
}
```

No hard-coded prompt such as “You are answering questions about a book…” may exist in the platform core.

Prompt defaults may exist by profile, but they must be overrideable.

---

## 4. Prompt and Output Control Are First-Class API Concerns

Textral must distinguish between:

```text
retrieval policy
context assembly policy
prompt policy
output schema policy
model policy
```

Consumers should be able to supply:

```text
system prompt
developer/internal instruction prompt
response style instructions
prompt template ID
structured output JSON Schema
citation policy
fallback behavior
```

The RAG Core may still enforce non-negotiable safety/correctness rules around provenance, tenant isolation, and citation integrity, but product-specific instruction should come from the upstream consumer.

Required behavior:

```text
Platform core:
  generic RAG execution, citations, grounding, validation, failure semantics

Consumer configuration:
  domain framing, answer style, output schema, model choice, prompt template
```

Invalid behavior:

```text
Hard-code “book”, “novel”, “chapter”, “character”, or literary-analysis behavior into the generic query prompt.
```

Valid behavior:

```text
Use corpus_profile defaults when no consumer prompt is supplied.
Allow request-level prompt/schema overrides.
Persist prompt/template/schema metadata with query_event for auditability.
```

---

## 5. Model Choice Must Be Configurable but Governed

Consumers may request concrete models, for example:

```text
gpt-5.5
gpt-5.4
gpt-5.4-mini
gpt-5-nano
text-embedding-3-large
text-embedding-3-small
```

They may also request abstract model directives:

```json
{
  "tier": "balanced",
  "capabilities": ["structured_output", "long_context"],
  "max_cost_class": "medium"
}
```

Textral must validate model choices against:

```text
tenant entitlement
provider allowlist
provider availability
cost policy
structured-output capability
context-window requirement
embedding dimensionality
index compatibility
```

The system may reject invalid combinations, downgrade by policy where allowed, or resolve abstract directives to concrete models.

---

## 6. Embedding Compatibility Is Mandatory

Embedding selection is not cosmetic. It determines vector dimensionality, index compatibility, and retrieval correctness.

Every document version must record:

```text
embedding_provider
embedding_model
embedding_dimensions
embedding_profile
vector_index
```

Every query must either use a compatible embedding profile or fail explicitly.

Invalid behavior:

```text
Index with text-embedding-3-small.
Query with text-embedding-3-large.
Silently search the incompatible index.
```

Required behavior:

```json
{
  "error": {
    "code": "EMBEDDING_PROFILE_MISMATCH",
    "message": "Requested query embedding model is incompatible with the indexed document version."
  }
}
```

---

## 7. Parameterization Without Chaos

Textral should be flexible but not bloated. Use layered configuration:

```text
service defaults
tenant defaults
namespace/corpus defaults
document ingestion overrides
query request overrides
```

Expose parameters that materially affect:

```text
retrieval quality
cost
model behavior
output shape
domain semantics
compatibility
citation behavior
```

Do not expose low-level internals prematurely:

```text
raw tokenizer details
provider SDK minutiae
internal retry timings
internal batch sizes
private prompt fragments
raw Vectorize/Qdrant tuning knobs
```

Those can remain internal configuration until a real consumer need emerges.

---

## 8. Durable Auditability

All meaningful configuration must be persisted for replay, debugging, and evaluation.

For ingestion jobs, persist:

```text
doc_type
corpus_profile
embedding config
chunking config
enrichment config
models used per pass
artifact types generated
failure/degradation state
```

For query events, persist:

```text
query text
embedding config
retrieval config
prompt/template config
output schema
inference model requested
inference model used
citations
degradation level
latency/token/cost metadata
```

This is required because parameterized RAG without auditability becomes impossible to evaluate.

---

## Final Invariant

Textral must be a flexible RAG execution platform, not a hard-coded narrative application.

The correct abstraction is:

```text
documents in
configurable ingestion/enrichment pipeline
indexed artifacts out
configurable retrieval/inference/prompting
citation-grounded responses back
```

Textral should be opinionated about:

```text
tenant isolation
idempotency
embedding/index compatibility
provider failure semantics
citation preservation
auditability
```

Textral should be configurable around:

```text
doc_type
corpus_profile
embedding model
enrichment passes
enrichment models
chunking profile
retrieval strategy
inference model
prompt instructions
structured output schema
cost/quality tier
```

This makes Textral usable by many upstream products while preserving a coherent, robust RAG platform core.
