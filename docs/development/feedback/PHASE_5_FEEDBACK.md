This Phase 5 doc is directionally strong. It is doing the right thing for this phase: profiles, enrichment, reranker enablement, context-layer budgets, and profile-driven defaults. It also explicitly constrains scope: no new embedding profiles, no eval bench, no streaming, no tenant-scoped overrides, no migration tooling, no new Vectorize provisioning. That scope discipline is good. 

My feedback below is focused on red flags and obvious fixes, not expanding the phase.

## High-level read

This is implementation-worthy. The structure is sensible:

```text
5.1–5.2  profile package + YAML registry
5.3      minimal schema migration
5.4      Worker-side profile resolution
5.5      Container-side profile loading
5.6–5.8  enrichment runner, passes, chunkers
5.9      reranker integration
5.10     per-layer context budget
5.11     dispatch / transition / audit wiring
5.12     close-out
```

The big win is that you are treating corpus profiles as declarative behavior rather than burying those defaults in application code. The YAML registry drives chunking, enrichment, retrieval, prompt defaults, reranking, and context budgets; request overrides still win. That is the right center of gravity for a configurable RAG service. 

## Red flags / critiques

### 1. Contradiction: “no new embedding profiles” vs index name

You say Phase 5 reuses the `openai-text-embedding-3-large-1536-cosine` index. But earlier design and Phase 0/1 provisioning used `text-embedding-3-large` as **3072 dimensions**, while `text-embedding-3-small` is 1536. Your Phase 1 doc provisions:

```text
textral-dev-openai-text-embedding-3-large-3072-cosine
```

not `large-1536`. 

This is likely just a typo, but it is a dangerous typo because embedding dimension/index naming is one of your core correctness invariants.

Fix the Phase 5 sentence to one of:

```text
openai-text-embedding-3-large-3072-cosine
```

or, if you intentionally shortened dimensions, make that an explicit embedding profile with a clear name. Do not let “large-1536” exist ambiguously.

---

### 2. Model precedence is surprising

You specify:

```text
Per-pass model override > profile-level default_model > request-level default_model
```

That means a request-level override cannot override the profile default. That is counterintuitive in a system whose broader invariant is “request body overrides profile defaults.” You also say request overrides sit on top of the profile via deep merge. 

I would make precedence:

```text
per-pass request override
> request-level enrichment.default_model
> profile pass model
> profile enrichment.default_model
```

If you do not want to support per-pass request overrides yet, then use:

```text
request-level default_model
> profile pass model
> profile default_model
```

The current rule makes profiles more authoritative than the request, which conflicts with the API philosophy.

---

### 3. Profile merge semantics and enrichment passes may produce footguns

Array replacement is defensible. You even explain why concatenation is too magical. 

But for enrichment passes, replacing the whole `passes` array means a caller who wants to disable one pass must respecify all the remaining passes correctly. That is acceptable for now, but I would add one explicit warning in the doc:

```text
If request.enrichment.passes is supplied, it replaces the profile's pass list entirely.
Consumers must supply the complete desired pass list.
```

This avoids future “why did my narrative profile stop producing section summaries?” confusion.

No need to build a removal DSL now.

---

### 4. “Unknown chunker falls through to generic” conflicts with validation

In Step 5.8.3, you say unknown chunker falls through to generic. Then you also say the profile schema validates `chunking.profile` via an enum. These conflict.

I would choose fail-fast:

```text
Unknown chunker profile should fail profile validation at boot.
Runtime fallback to generic should not happen for profile-declared chunkers.
```

Silent fallback is risky because a typo like `legal_clause_awre` would produce generic chunks and degrade legal retrieval without an obvious failure. Since profiles are code-owned YAML, boot-time failure is better.

---

### 5. `chunk_id` form is not compatible with previous ULID conventions

You propose deterministic enrichment chunk IDs:

```text
chk_<version_id>_e_<pass_id>_<sequence>
```

This is human-debuggable, but likely violates your ID conventions if prior code assumes prefixed ULID-ish IDs. It also creates very long IDs, and if `version_id` includes `ver_...`, the result becomes nested-prefix-ish.

Safer:

```text
chunk_id = chunk_<hash/version-pass-seq-short>
```

or:

```text
chunk_id = chk_<deterministic ULID-compatible/hash prefix>
metadata.dedupe_key = sha256(version_id + pass_id + sequence + artifact_text_hash)
```

The important part is deterministic replay, not human readability. Keep IDs short and consistent.

---

### 6. Enrichment pass id format is inconsistent

You say pass id format is “snake-case identifier,” but examples include dotted IDs such as `legal.clause` elsewhere, while YAML pass IDs use `clause_extraction`, `obligation_extraction`, etc. 

I would clarify the taxonomy:

```text
pass_id: snake_case, no dot
artifact_type: namespaced dot form, e.g. legal.clause
```

Examples:

```text
pass_id = clause_extraction
artifact_type = legal.clause
```

That separation is already mostly present; the doc just needs to be stricter.

---

### 7. Enrichment output can become ungrounded unless artifacts preserve source lineage

Your `EnrichmentArtifact` includes `parent_chunk_id`, but for document-scope artifacts like character dossiers/themes, `parent_chunk_id` is `NULL`. That is okay structurally, but it creates a citation risk: a document-scope artifact may become a synthesized statement without clear source chunks.

Minimal fix: add optional `source_chunk_ids: list[str]` to `EnrichmentArtifact`.

```python
@dataclass
class EnrichmentArtifact:
    artifact_type: str
    section_path: str
    text: str
    metadata: dict
    parent_chunk_id: str | None = None
    source_chunk_ids: list[str] = field(default_factory=list)
```

You do not need a new table in Phase 5. You can store it in metadata JSON for now:

```json
{
  "source_chunk_ids": ["chunk_...", "chunk_..."]
}
```

This preserves provenance without expanding scope much.

---

### 8. Full-document enrichment may blow up token budgets

Document-scope passes receive all chunks in the version, ordered by `(section_path, ord)`. That is conceptually clean, but for long documents, `character_dossier`, `theme`, and `legal.obligation` can exceed context windows or become expensive fast. 

Minimal guardrail: specify hard caps.

For example:

```text
document-scope passes must either:
  - map over sections and reduce, or
  - cap input tokens and log truncation, or
  - fail with INPUT_TOO_LARGE_FOR_PASS
```

Do not leave “concatenate the whole document” implicit. This is the biggest cost/latency risk in Phase 5.

---

### 9. Reranker fallback on quota should maybe be audited more strongly

You say reranker fallback on 5xx, quota, or timeout falls back to RRF top-K and does not count as query degradation. That is reasonable for availability. 

But quota exhaustion is not the same as a transient provider blip. If the tenant’s Voyage key is out of quota, every future query may silently skip reranking while still returning `degradation_level = full`.

I would keep `degradation_level = full`, but add a stronger audit signal:

```json
"audit": {
  "reranker": {
    "enabled": true,
    "executed": false,
    "fallback_reason": "PROVIDER_QUOTA_EXHAUSTED",
    "actionable": true
  }
}
```

No need to add user-facing errors. Just make it unmistakable in audit/SDK.

---

### 10. Per-layer context-budget spill behavior has an edge-case bug in the test description

In Step 5.10, you describe spill moving to the “next-declared layer.” But if a late layer underfills, there may be no next layer. That is fine, but the doc should state:

```text
If the last layer underfills, leftover budget is unused.
```

Also, the test example says a 1500-token dossier consumes a 1200-token allocation and produces 700 spillover. That math is inconsistent: if the chunk is admitted despite exceeding the cap, it consumes over budget; if it respects the cap, it should not be included. 

Clarify the rule for single chunks larger than cap:

Option A:

```text
A chunk larger than its layer cap may be admitted if the layer is otherwise empty.
```

Option B:

```text
A chunk larger than its layer cap is skipped unless it fits in spill-adjusted budget.
```

I recommend A, because otherwise some layers may never appear. But make it explicit.

---

### 11. Missing acceptance criterion: live e2e for one enriched doc

You have many good unit tests. But Phase 5 changes the actual RAG behavior. I would add one live smoke test, not a full eval bench:

```text
Ingest one tiny legal fixture with legal profile.
Assert:
  legal.clause chunks exist
  legal.obligation chunks exist or optional failure is recorded
  query default artifact_types includes passage + legal.clause + legal.obligation
  audit.reranker.enabled=true
```

And one narrative fixture:

```text
Ingest tiny narrative fixture.
Assert narrative.section_summary and narrative.character_dossier exist.
```

This does not expand into Phase 7 eval. It just proves the pipeline works end-to-end.

---

### 12. `version_indexes.status` update depends on required pass semantics

The transition handler says `version_indexes.status` becomes `partial` if any chunks have missing embeddings or any required enrichment pass is missing, based on `ingest_stage_attempts` rows. 

Potential issue: if a required pass fails, the job itself should fail. If the job fails, should `version_indexes.status` become `partial`, `failed`, or remain whatever it was before? The doc says both “required failure → job failed” and “required missing → version index partial.”

I would make it:

```text
required enrichment failure:
  job.status = failed
  version_indexes.status = failed or unchanged from previous ready index

optional enrichment failure:
  job.status = completed
  version_indexes.status = partial
```

Avoid “required failed but index partial” unless you truly want failed jobs to expose partial index state.

---

## Smaller obvious improvements

### Add profile invariants tests

For each YAML profile, assert:

```text
retrieval_defaults.artifact_types includes passage
every enrichment.produces artifact type appears in retrieval artifact_types or is intentionally query-disabled
every layer_budgets key appears in artifact_types
every layer_order key appears in artifact_types
every depends_on references an existing pass id
every pass id exists in the Container registry
```

These are cheap and catch profile drift.

### Add “provider required when rerank enabled” validation

`RerankConfig` permits `enabled: true` without `provider` or `model`. The code later uses non-null assertions. Add a refinement:

```ts
if enabled=true, provider and model are required
```

Same in Pydantic.

### Watch the Python loader path

`Path(__file__).resolve().parents[2] / 'profiles'` may or may not resolve to `/app/profiles` depending on package depth. Given `loader.py` lives under `app/corpus_profiles`, `parents[2]` might be `/app/app`, not `/app`. Verify this. It is a small but common container-path footgun.

### Do not let profile YAML defaults hard-code obsolete model names

The YAML uses `gpt-4o` and `gpt-4o-mini`, while your broader discussions use `gpt-5.x` style names. That is not necessarily wrong, but keep the profile examples aligned with whatever provider model catalog Phase 2 actually validates. Otherwise live tests will fail for silly reasons.

---

## Final verdict

This is a good Phase 5 plan. It is more complex than Phases 0/1 because it introduces actual RAG product behavior, but the complexity is mostly justified:

```text
profiles define defaults
enrichment is modular
rerank is optional and fallbacks are safe
context assembly becomes corpus-aware
requests can still override
```

The main changes I would make before implementation are narrow:

```text
1. Fix the embedding-profile dimension typo.
2. Clarify request-vs-profile model precedence.
3. Fail fast on unknown chunkers.
4. Add source_chunk_ids for document-scope artifacts.
5. Add token caps/map-reduce rule for document-scope enrichment.
6. Clarify required-pass failure vs version_index status.
7. Add one legal and one narrative live smoke test.
```

I would not restructure the phase. The bones are good.
