# Textral API Reference

> **Canonical source:** `https://<your-worker>.workers.dev/docs`
> (Scalar UI). The Scalar landing page carries the full mental
> model, the 5-minute quickstart, the corpus-profile concept blurbs,
> common recipes, strategy guidance, the failure-semantics table,
> and the complete error catalog — kept in sync with the running
> Worker via `apps/api/src/openapi/landing-description.ts`.
>
> This document is a static GitHub-readable mirror with the
> conventions, flagship flows, and code samples. For the latest
> rendered docs, hit `/docs` against any deployed Worker.

Two ways to access the OpenAPI spec:

- **Live JSON:** `https://<your-worker>.workers.dev/openapi.json`
- **Docs UI:** `https://<your-worker>.workers.dev/docs` (Scalar UI)

This document is the human-readable companion: conventions, the four
flagship flows, and code samples.

## Conventions

- All authenticated paths under `/v1/*` require the
  `X-Textral-Api-Key` header.
- Admin paths under `/v1/admin/*` require an API key with the
  `admin` scope. The bootstrap path (`/v1/admin/bootstrap`) uses a
  one-time bootstrap token instead.
- All errors return the standard envelope:
  ```json
  {
    "error": {
      "code": "EMBEDDING_PROFILE_MISMATCH",
      "message": "...",
      "request_id": "req_01H...",
      "details": { ... }
    }
  }
  ```
  See `packages/contracts/src/error.ts` for the full code catalog.
- Identifiers are prefixed ULIDs: `doc_01H...`, `qev_01H...`, etc.
  Tenant-scoped uniqueness is enforced.
- Idempotency: ingestion is idempotent on (`document_id`,
  `content_hash`); re-uploading identical bytes returns the existing
  version_id.

## Audit fields

Every query response carries an `audit` object that mirrors
`packages/contracts/src/query.ts:QueryAudit`. Consumers can rely on
the field names being stable across MVP releases. Notable fields:

- `audit.reranker.{enabled, executed, fallback_reason, actionable}` —
  distinguishes "not requested" from "requested but fell back."
- `audit.degradation_level` ∈ `{full, no_citations, partial,
  cannot_answer}`.
- `audit.tokens.{embedding_input, synthesis_input, synthesis_output,
  context}` — for cost attribution.

## Flagship flows

### 1. Register a tenant + API key

This is the bootstrap-only path; see
`docs/runbooks/PROVISIONING.md`.

### 2. Register a BYOK provider key

```bash
curl -X POST "$BASE/v1/provider-keys" \
  -H "x-textral-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"provider":"openai","label":"default","key":"sk-..."}'
```

The response includes a `provider_key_id`; the raw key is stored in
KV-backed Secrets Store (prod requires the binding) and never
returned to the client again.

### 3. Ingest a document

```bash
# Step 1: register the doc
curl -X POST "$BASE/v1/namespaces/<ns>/documents" \
  -H "x-textral-api-key: $KEY" \
  -d '{"title":"my-doc","doc_type":"narrative"}'

# Step 2: presign upload
curl -X POST "$BASE/v1/documents/<doc_id>/uploads" \
  -H "x-textral-api-key: $KEY" \
  -d '{"content_type":"text/markdown","size_bytes":1234}'

# Step 3: PUT the bytes (the URL points back at the Worker — proxied)
curl -X PUT "$UPLOAD_URL" \
  -H 'content-type: text/markdown' \
  -H "x-textral-api-key: $KEY" \
  --data-binary @document.md

# Step 4: finalize → returns version_id
curl -X POST "$BASE/v1/documents/<doc_id>/uploads/<upload_id>/finalize" \
  -H "x-textral-api-key: $KEY" \
  -d '{}'

# Step 5: trigger ingestion
curl -X POST "$BASE/v1/documents/<doc_id>/ingest" \
  -H "x-textral-api-key: $KEY" \
  -d '{
    "version_id":"<from step 4>",
    "embedding":{"provider":"openai","model":"text-embedding-3-large","dimensions":1536,"provider_key_ref":"default"},
    "chunking":{"profile":"generic"},
    "mode":"full"
  }'

# Step 6: poll job
curl "$BASE/v1/ingestion-jobs/<job_id>" -H "x-textral-api-key: $KEY"
```

### 4. Query (sync)

```bash
curl -X POST "$BASE/v1/query" \
  -H "x-textral-api-key: $KEY" \
  -d '{
    "namespace":"narrative",
    "query":"Where was Alexandria?",
    "embedding":{"provider":"openai","model":"text-embedding-3-large","dimensions":1536,"provider_key_ref":"default"},
    "inference":{"provider":"openai","model":"gpt-4o-mini","provider_key_ref":"default"},
    "chunking":{"profile":"generic"},
    "retrieval":{"strategy":"hybrid_rrf","top_k_dense":5,"top_k_sparse":5}
  }'
```

### 4b. Query (streaming)

Append `?stream=sse` to `/v1/query`. Two SSE event types: `token`
(per token delta) and `done` (single final event with audit +
citations + degradation_level). See `docs/development/PHASE_6_7_IMPLEMENTATION.md`
§6.5.

### 5. Eval

```bash
# Register a set
curl -X POST "$BASE/v1/namespaces/narrative/eval-sets" \
  -H "x-textral-api-key: $KEY" \
  -d '{
    "name":"my-baseline",
    "questions":[{"question":"Who calculated the circumference of the Earth?"}]
  }'

# Run it
curl -X POST "$BASE/v1/namespaces/narrative/eval-sets/<id>/runs" \
  -H "x-textral-api-key: $KEY" \
  -d '{
    "inference":{"provider":"openai","model":"gpt-4o-mini","provider_key_ref":"default"},
    "embedding":{"provider":"openai","model":"text-embedding-3-large","dimensions":1536,"provider_key_ref":"default"}
  }'
```

The CLI in `packages/eval-cli/` wraps these calls.

## TypeScript SDK

The `@textral/contracts` workspace package exports every Zod schema —
import it from your own TS project to validate request bodies and
response shapes:

```ts
import { QueryRequest, QueryResponse } from '@textral/contracts';

const body = QueryRequest.parse(input); // throws if shape is wrong
const res = await fetch(`${BASE}/v1/query`, { ... });
const parsed = QueryResponse.parse(await res.json());
```

## Rate limits

- Public endpoints: rely on Cloudflare's edge protection + AI
  Gateway's per-key quotas. No Worker-level limits today.
- Admin batch endpoints (e.g.
  `POST /v1/admin/namespaces/:slug/enrichment-runs`): 10/min/tenant.
  Returns 429 `ADMIN_RATE_LIMITED` when exceeded.

## Versioning

The `/v1/*` prefix is stable for the MVP. Breaking changes will land
under `/v2/*` with a deprecation window. Audit field names are
guaranteed stable; new fields may be added.
