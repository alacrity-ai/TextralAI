Overall: **this is a strong Phase 3/4 plan**. The architecture is coherent: ingestion is asynchronous and Container-based; query is Worker-side to avoid cold-start tax; D1/Vectorize writes stay behind Worker bindings; retrieval uses hybrid dense+sparse with RRF; and the query response carries degradation and auditability. The strongest parts are the clear ingestion stage boundaries, idempotent replay model, embedding-profile compatibility, and citation-grounded synthesis path. 

That said, I would not mark this closed without tightening several areas.

## 1. The biggest concern: Container-to-Worker internal auth

The internal back-channel is gated by `X-Textral-Internal-Token`, shared with the Container. That is workable for MVP, but it is a high-trust path with powerful operations: resolving provider keys, writing chunks, upserting vectors, mutating jobs, and minting R2 read URLs. 

I would strengthen this before production:

```text
X-Textral-Internal-Token: static secret
X-Textral-Internal-Timestamp: unix ms
X-Textral-Internal-Signature: HMAC(method + path + body_hash + timestamp)
```

Then enforce a short clock-skew window, for example 5 minutes. A static bearer token on internal routes is easy to leak through logs, traces, crash dumps, or accidental request replay.

Also, every internal endpoint should still re-check tenant/job ownership from D1. Do not rely on the Container being honest. For example, `/internal/vectorize/upsert` should verify that every vector’s `tenant_id`, `namespace_id`, `document_id`, and `version_id` match the loaded `job_id`.

## 2. R2 presigned upload flow has a hashing ambiguity

The finalize step says it computes `content_hash` from metadata, using the R2 ETag for single-shot PUTs, with stream-read fallback. That is risky. S3-style ETags are not a portable content hash contract, and relying on ETag semantics tends to create surprising behavior later when multipart, encryption, proxies, or implementation details change.

Since the MVP upload limit is 25 MB, I would simply stream the object and compute a real digest every time:

```text
sha256(source bytes) → content_hash
```

The cost is acceptable at 25 MB. It also gives you a stable deduplication key independent of R2 behavior.

I would also require finalize to compare the actual uploaded size/content type from R2 metadata against the presign request. Otherwise a client can ask for a 12-byte `text/plain` upload and finalize a much larger or different object.

## 3. “R2 copy + delete, atomic in practice” should be softened

This phrase is dangerous:

> copy the upload object to the canonical version path, INSERT `document_versions`, DELETE the upload object.

That is not atomic across R2 and D1. It is a distributed write sequence. You can make it idempotent, but not atomic.

I would model finalize as a small state machine:

```text
upload_received
copy_started
copy_completed
version_inserted
upload_deleted
```

At minimum, make the canonical R2 key deterministic from `version_id` and make retries safe:

```text
if canonical object exists and hash matches → continue
if document_versions row exists → return it
if upload object still exists → copy again
```

This prevents finalize from leaving orphaned uploads or canonical objects that have no corresponding D1 row.

## 4. The `document_versions` dedup model conflicts with embedding-profile re-ingest

You have two statements that collide:

First, Phase 3.2 says `document_versions` has `UNIQUE(document_id, content_hash)`, and re-uploading identical content returns the existing version row. 

Later, Phase 3.11 says re-ingesting the same document with a different embedding profile creates a **new version** with new chunks and vectors. 

Those cannot both be true if `UNIQUE(document_id, content_hash)` is the only version uniqueness rule.

You need to choose the semantic meaning of `document_version`.

Option A: **Version means source bytes only.**
Then identical content always maps to one `version_id`, and different embedding profiles should create separate `indexing_profiles` or `version_embeddings` records, not new document versions.

Option B: **Version means source bytes + indexing profile.**
Then the uniqueness key should be:

```sql
UNIQUE(document_id, content_hash, embedding_profile, chunking_profile)
```

or a separate derived-artifact identity:

```text
source_version_id = ver_...
index_version_id = idx_...
```

I strongly prefer Option A architecturally:

```text
document_versions: source artifact identity
chunk_sets: version_id + chunking_profile
embedding_indexes: chunk_set_id + embedding_profile
```

That avoids pretending the source changed when only the embedding model changed.

## 5. Current-version semantics need clarification

Phase 3.10 says a successful run sets:

```text
documents.current_version_id = version_id
```

But Phase 3.11 says old versions remain queryable, and different embedding profiles may create multiple version rows. 

You need to define what `current_version_id` means:

```text
latest uploaded source version?
latest successfully ingested version?
default query version for namespace?
default query version for a specific embedding profile?
```

If old versions remain queryable and embedding profiles can vary, `current_version_id` alone is insufficient. Consider:

```sql
documents.current_source_version_id
documents.current_index_version_id
```

or a `document_version_aliases` table:

```text
document_id
alias: current | stable | latest
version_id
embedding_profile
```

Without this, query resolution will become ambiguous.

## 6. The ingestion job lock is underspecified

The prerequisites and dispatch mention active-job conflict, but the actual lock mechanics are not described. For queue redelivery and retry safety, this matters a lot.

You need a clear transition rule:

```sql
UPDATE ingestion_jobs
SET status = 'running',
    locked_at = ?,
    locked_by = ?,
    attempt_count = attempt_count + 1
WHERE id = ?
  AND status IN ('pending', 'retrying')
  AND (locked_at IS NULL OR locked_at < ?)
```

Then verify the row count is 1. If it is 0, the worker should treat the job as already claimed or terminal.

Add fields if they do not exist:

```text
locked_at
locked_by
attempt_count
heartbeat_at
lease_expires_at
```

A Queue message can be delivered more than once. The doc’s idempotency model is good, but it also needs an explicit lease model.

## 7. Stage logs keyed only by `(job_id, stage)` lose useful history

You chose `INSERT-OR-REPLACE` on `(job_id, stage)`, keeping only the latest attempt. That makes status simple, but it destroys the timeline. For debugging ingestion failures, this will be painful.

Better:

```sql
ingest_stage_attempts:
  job_id
  stage
  attempt
  status
  started_at
  finished_at
  metadata
  error_code
  error_message
  PRIMARY KEY(job_id, stage, attempt)
```

Then optionally maintain a latest-stage view/table. You can still expose the latest stage cheaply, but you retain forensic history.

This is especially important for external provider failures, partial batches, and replay behavior.

## 8. Partial ingestion needs stronger indexing invariants

In embed stage, `partial_batch` can mark some chunks as `embedding_status=missing` and proceed to `partial_ingestion`. That is reasonable. But the retrieval path must then explicitly exclude missing embeddings from dense retrieval and still allow BM25-only retrieval.

You need to define the invariant:

```text
D1 chunks may exist without Vectorize vectors.
FTS5 includes all textual chunks.
Vectorize includes only chunks where embedding_status = 'embedded'.
Query can degrade to sparse-only when dense coverage is incomplete.
```

Then `degradation_level` should include retrieval degradation, not only synthesis degradation. Right now the degradation taxonomy is mostly answer/citation oriented:

```text
full
no_citations
partial
cannot_answer
```

It does not clearly represent “retrieval fell back to sparse-only because embeddings are incomplete.” Consider adding audit fields even if you do not expand the enum:

```ts
retrieval_degraded: boolean
dense_candidates_returned: number
sparse_candidates_returned: number
embedding_missing_count: number
```

## 9. Vectorize index naming and dimensions appear inconsistent

The prerequisites mention:

```text
textral-{env}-openai-text-embedding-3-large-1536-cosine
```

But OpenAI `text-embedding-3-large` commonly supports a default dimensionality of 3072, while 1536 would imply you are intentionally using the embeddings API `dimensions` parameter. Your Phase 2 feedback also had `text-embedding-3-large` as 3072 unless otherwise configured.

So the profile needs to explicitly encode both model and dimension:

```text
provider=openai
model=text-embedding-3-large
dimensions=1536
metric=cosine
```

And the embedding request must pass:

```json
{ "model": "text-embedding-3-large", "dimensions": 1536 }
```

If you intend `text-embedding-3-small`, name the index accordingly. This is not cosmetic: Vectorize index dimensionality is a hard compatibility boundary.

## 10. Embedding-profile compatibility should include chunking profile too

The write side only gates `embedding_profile`, but the retrieval quality also depends on chunking. A query over chunks produced by a legal-profile chunker versus a generic chunker can behave very differently.

At minimum, the compatibility profile should include:

```text
embedding_provider
embedding_model
embedding_dimensions
distance_metric
chunking_profile
chunking_target_tokens
chunking_overlap_tokens
normalizer_version
```

Otherwise future replays can silently mix incompatible artifacts.

I would rename `embedding_profile` to `retrieval_profile` or introduce a composite:

```text
source_profile
chunking_profile
embedding_profile
retrieval_profile
```

## 11. Provider key resolution from the Container is powerful and should be narrower

The internal endpoint:

```text
POST /internal/secrets/resolve { provider_key_id } → { raw_key }
```

is convenient, but it gives the Container raw provider secrets. Since the Container only needs to embed, you could instead expose a Worker-side embedding endpoint:

```text
POST /internal/providers/embed
```

The Worker already owns provider resolution, AI Gateway metadata, redaction, and provider abstractions from Phase 2. If Python calls OpenAI directly, you are duplicating provider behavior in `apps/ingest/app/providers/openai.py`.

That duplication is a design tradeoff. It buys simpler bulk embedding inside Python, but it risks divergent behavior:

```text
TypeScript provider retry/classification
Python provider retry/classification
AI Gateway routing
metadata tagging
redaction
quota regression behavior
```

My recommendation: for MVP, either:

1. Move embedding calls through the Worker internal provider endpoint; or
2. Make Python provider code deliberately minimal and have explicit contract tests proving it classifies errors identically to Phase 2.

Right now the doc says “Phase 2 contract mirrored on the Python side,” but mirroring is where drift begins.

## 12. FTS5 query construction is more dangerous than it looks

“In-house escape + phrase pass-through” is fine, but FTS5 MATCH syntax is unforgiving. The doc says escape `" * (` characters. You should also consider operators and special syntax:

```text
AND OR NOT NEAR
^
:
-
)
```

Depending on tokenizer/query mode, these can change semantics or cause syntax errors.

I would implement a conservative MVP:

```text
Parse quoted phrases.
For unquoted text, tokenize to safe alphanumeric terms.
Drop or normalize everything else.
Join with OR.
Never pass raw user syntax through by default.
```

Then add an `advanced_query: true` mode later if needed. For normal RAG, predictable recall matters more than exposing FTS syntax.

## 13. Hydrating `WHERE id IN (...)` can destroy rank order

Context assembly says hydrate fused candidates using one:

```sql
SELECT ... WHERE id IN (...)
```

That query does not preserve the fused ranking order. You need to reorder rows in application memory according to the fused candidate list before token-budget selection.

Otherwise the greedy context budget can include lower-ranked chunks and exclude higher-ranked ones.

Add an acceptance test:

```text
Hydration returns rows in arbitrary DB order.
Context assembly still emits [1], [2], [3] in fused rank order.
```

## 14. Citation validation by marker removal can corrupt answer text

The current rule says hallucinated citations are “dropped from the response output” by removing the marker. That is reasonable, but be careful:

```text
"See [99]." → "See ."
"Claims [99][2]" → "Claims [2]"
```

You likely need a cleanup pass that removes orphaned spaces/punctuation, or better: do not mutate prose aggressively. Another option is to keep the answer text unchanged but exclude invalid citations from the returned `citations` array and set degradation accordingly.

I prefer:

```text
Do not rewrite answer text except in structured mode where citation arrays are explicit.
Return valid citations only.
Record invalid markers in audit.dropped_citations.
Set degradation_level = no_citations or partial as appropriate.
```

If you must remove invalid markers, add text-normalization tests.

## 15. `degradation_level='full'` is too weakly defined

You define `full` as:

```text
at least 1 citation, all valid, retrieval returned ≥ 1
```

That says nothing about whether the answer actually used the retrieved evidence correctly. It only says citation syntax was valid.

For MVP that may be acceptable, but rename mentally: this is **citation integrity**, not answer faithfulness.

I would include additional audit fields:

```ts
citation_integrity: 'valid' | 'invalid_removed' | 'missing'
retrieval_status: 'full' | 'sparse_only' | 'dense_only' | 'empty'
synthesis_status: 'success' | 'truncated' | 'failed'
```

Then compute the coarse `degradation_level` from those. This avoids overloading a single enum with too much meaning.

## 16. Query audit best-effort R2 mirror conflicts with acceptance

The design says the R2 mirror is best-effort and must not block the response. But the acceptance says:

```text
The R2 mirror exists for every row.
```

Those conflict.

Better acceptance:

```text
A query_events row exists for every successful or partial query.
When R2 mirror succeeds, answer_r2_key is populated.
When R2 mirror fails, answer_r2_key is null and mirror_error is recorded.
A sweeper can repair failed mirrors later.
```

Do not assert best-effort behavior as mandatory unless you are willing to block the response on it.

## 17. Cost accounting is underspecified

`query_events` includes `total_cost_usd_micros`, and `usage_records` are extended, but the doc does not specify how costs are computed.

For now, I would either:

```text
set total_cost_usd_micros = null
```

or introduce a pricing table with explicit effective dates:

```sql
provider_model_prices:
  provider
  model
  input_usd_per_million_tokens
  output_usd_per_million_tokens
  embedding_usd_per_million_tokens
  effective_at
```

Do not compute cost from hardcoded constants hidden in application code unless this is strictly dev-only. Pricing changes, and audit records need reproducibility.

## 18. Query events should be written for failed queries too

The doc says every successful or partial query gets a row. For production debugging, failed queries are equally important, especially:

```text
EMBEDDING_PROFILE_MISMATCH
retrieval empty
provider retryable exhausted
provider invalid key
synthesis failed
schema validation failed
```

I would write a `query_events` row as soon as the request validates and tenant/namespace are known, then update it through stages:

```text
received
retrieval_started
retrieval_completed
synthesis_started
completed
failed
```

That gives you replay-quality diagnostics for failures, not only successes.

## 19. The `query_events.request_config` may store sensitive prompts

The doc stores the full request body post-default-merge. That is useful for replay, but it can contain consumer prompts, proprietary queries, potentially PII, and maybe schema content. You need a retention and redaction policy.

At minimum:

```text
request_config_redacted
request_config_hash
raw_request_r2_key optional, privileged only
```

Or a tenant-level setting:

```text
audit_mode = full | redacted | metadata_only
```

Since this is an AI product handling documents, defaulting to full request-body retention may surprise enterprise users.

## 20. `answers/{query_event_id}.json` path may be ambiguous

The proposed R2 path is:

```text
{tenant_id}/{namespace_id}/{document_id?}/answers/{query_event_id}.json
```

But queries can span multiple documents or a whole namespace. A path with optional `document_id` can become inconsistent.

Prefer:

```text
{tenant_id}/{namespace_id}/answers/{query_event_id}.json
```

and record document IDs inside the JSON/audit row. Keep object layout stable.

## 21. Retrieval should handle sparse-only and dense-only failures explicitly

Phase 4 says retrieval runs dense + sparse in `Promise.all`. If either arm throws, the whole retrieval fails. For production RAG, you may want partial retrieval:

```ts
const [dense, sparse] = await Promise.allSettled([
  denseSearch(),
  sparseSearch(),
]);
```

Then:

```text
both succeeded → full
dense failed, sparse succeeded → sparse_only degradation
sparse failed, dense succeeded → dense_only degradation
both failed → cannot_answer / retrieval_failed
```

This also makes partial ingestion more useful, because sparse retrieval can still work when embeddings are missing or Vectorize is impaired.

## 22. Reranker disabled but “wired” needs an explicit no-op interface

You say reranking is wired but disabled by default. Good. Make the interface deterministic now:

```ts
type RerankMode = 'disabled' | 'enabled';

if disabled:
  rerank_candidates = fused_candidates
  audit.reranker = { enabled: false }
```

That prevents Phase 5 from changing response shape or audit semantics when reranking is enabled.

## 23. The CDM model uses mutable defaults in Python

This snippet:

```python
metadata: dict = {}
```

should be:

```python
metadata: dict = Field(default_factory=dict)
```

Pydantic generally protects you better than raw dataclasses, but explicit default factories are the safer and clearer convention. The same applies anywhere you define list/dict defaults.

## 24. Deterministic ULID is a contradiction

The doc says:

```text
id = chunk_<deterministic ULID over (version_id, ord)>
```

ULIDs encode time randomness; “deterministic ULID” is not quite the right construct. Use a deterministic ID format:

```text
chunk_<base32(sha256(version_id + ":" + ord))[0:26]>
```

or:

```text
chk_<version_id>_<zero_padded_ord>
```

For chunks, I prefer the latter unless IDs must be opaque. Deterministic and human-debuggable beats pseudo-ULID aesthetics.

## 25. `chunks.jsonl` should include a schema version

If replay depends on `chunks.jsonl`, include:

```json
{"type":"header","schema_version":"chunk_jsonl_v1","version_id":"...","chunking_profile":"..."}
```

Then one JSON object per chunk. Future chunker changes will be much easier to manage.

## 26. “No embeddings persisted to R2” is good, but consider embedding checksums

I agree with not storing embeddings in R2. But for replay/debugging, you may want lightweight metadata:

```text
embedding_model
embedding_dimensions
input_text_hash
vector_id
embedding_provider_request_id
```

This lets you diagnose whether a Vectorize vector corresponds to the expected chunk text without storing the vector itself.

## 27. Query schema response shape could be tighter

This shape:

```ts
answer: z.union([z.string(), z.record(z.unknown())])
```

is fine for transport, but operationally you probably want:

```ts
answer: {
  mode: 'text' | 'structured';
  text?: string;
  object?: unknown;
  raw?: string;
}
```

The current union forces clients to branch on runtime type. A tagged object is easier for SDKs, OpenAPI, and future streaming.

## 28. `input_tokens` and `output_tokens` should separate retrieval and synthesis

The audit response includes `input_tokens` and `output_tokens`. For RAG, that can mean several different things:

```text
embedding input tokens
context tokens
prompt tokens
completion tokens
reranker tokens
```

I would make it explicit:

```ts
tokens: {
  embedding_input: number;
  synthesis_input: number;
  synthesis_output: number;
  context: number;
}
```

This will matter for cost and optimization.

## 29. Provider-key refs need one canonical format

The doc uses `provider_key_ref: "openai-prod"` in the examples, but earlier phases discussed provider key IDs and labels. Decide whether the public contract accepts:

```text
pkey_...
provider:label
label only
```

I would accept only IDs in write paths where possible:

```json
"provider_key_id": "pkey_..."
```

Labels are convenient but ambiguous over time. If you keep labels, resolve them to exact IDs at job creation and store the resolved ID in `config_json`.

## 30. Add explicit deletion/reindex behavior

You have `replace_existing_vectors`, but the actual delete path is not described. If a document is re-ingested with changed content, old chunks and old vectors must be handled deliberately.

Define:

```text
replace_existing_vectors=true:
  delete vectors for document_id + version_id + embedding_profile before upsert
  delete/rewrite chunks for version_id + chunking_profile

replace_existing_vectors=false:
  upsert deterministic chunk IDs only
```

Vectorize deletion by metadata filter may have operational constraints; verify that the intended delete primitive exists and document fallback behavior.

## What I would require before tagging Phase 3 complete

I would make these mandatory:

1. Resolve the `document_versions` versus embedding-profile versioning conflict.
2. Replace ETag-based content hashing with explicit SHA-256.
3. Add an ingestion job lease/lock model.
4. Strengthen internal route auth beyond a static bearer token, or at least add replay protection.
5. Make internal write endpoints validate job/tenant ownership on every call.
6. Add stage attempt history instead of overwriting logs.
7. Fix `text-embedding-3-large-1536` profile naming/dimensions.
8. Define deterministic chunk IDs without calling them ULIDs.
9. Clarify partial ingestion invariants.

## What I would require before tagging Phase 4 complete

Mandatory before close:

1. Preserve fused rank order after D1 hydration.
2. Use `Promise.allSettled` or explicitly justify all-or-nothing retrieval.
3. Expand audit fields for dense/sparse candidate counts and retrieval degradation.
4. Resolve best-effort R2 mirror versus “exists for every row” acceptance conflict.
5. Write query events for failures, not only successful/partial responses.
6. Define redaction/retention policy for `request_config`.
7. Make response `answer` a tagged object instead of a raw union, unless client simplicity is not a concern.
8. Treat citation validation as syntax integrity, not faithfulness.

My overall read: **the plan is architecturally sound and implementation-ready, but it has a few semantic conflicts that should be fixed before coding further.** The largest one is source versioning versus embedding/indexing versioning. If you solve that cleanly now, the rest of the system will be much easier to evolve in Phase 5.
