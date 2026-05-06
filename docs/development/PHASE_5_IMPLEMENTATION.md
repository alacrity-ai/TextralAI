# Phase 5 — Implementation Steps

> Companion to `docs/2-PHASES.md`. Concrete, ordered steps for Phase 5
> (corpus profiles + enrichment + reranker enablement).
>
> A dev should be able to follow this document end-to-end and finish
> Phase 5 without making design decisions or asking questions. Where
> the design doc left a choice open, this document picks one.

---

**At completion, you will have:** five corpus profiles (`generic`,
`narrative`, `legal`, `support`, `technical`) loaded from a single
canonical YAML source by both the Worker and the Container; a
namespace's `corpus_profile` drives sensible defaults for chunking,
enrichment, retrieval, and prompts; the request body still overrides
any field; an `enrich` stage runs profile-declared enrichment passes
in topological order and produces `chunks` rows of distinct
`artifact_type` (e.g. `narrative.character_dossier`,
`legal.clause`); the reranker (Voyage default, Cohere available) is
wired into the retrieval pipeline with graceful fallback to RRF
top-K on provider failure; per-layer context budgets are honored so
e.g. a `narrative` query reserves 60% of the context window for
passages and 20% each for `section_summary` and `character_dossier`.

By the end of Phase 5, a novel and a lease document each ingest with
profile-appropriate enrichment, and queries against them surface
profile-appropriate artifact types. `audit.reranker` carries
`enabled`, `executed`, and `fallback_reason` so SDK consumers can
distinguish "not requested" from "requested but fell back."

---

## Revisions applied per `feedback/PHASE_5_FEEDBACK.md`

This doc has been revised to address every accepted item in that
feedback file. Summary (the body has been edited inline):

1. **Embedding profile name disambiguated.** The
   `textral-dev-openai-text-embedding-3-large-1536-cosine` index name
   is intentional and matches the deployed reality from Phase 3+4
   (Vectorize V2 caps at 1536 dim; we pass `dimensions: 1536` to
   OpenAI to truncate). The doc now calls this out explicitly rather
   than letting the name look ambiguous. (§What-NOT)
2. **Model precedence inverted.** Request-level overrides win over
   profile defaults — consistent with the rest of the API. New chain:
   `per-pass request override > request-level enrichment.default_model
   > profile pass model > profile enrichment.default_model`.
   (§locked-in choices, §5.6.2)
3. **Pass-array replacement is a documented footgun.** Adding
   `request.enrichment.passes` replaces the profile's pass list
   wholesale; consumers must supply the complete desired list. Called
   out at the merge spec and at the `/ingest` route docs. (§5.1.4)
4. **Unknown chunker fails at boot.** Removed the runtime fallback to
   `generic`; the profile schema now enums valid chunker IDs. A typo
   crashes profile validation. (§5.1.2, §5.8.3)
5. **Enrichment chunk IDs are short and don't blow Vectorize's
   64-byte limit.** Format is `chk_<version_id>_e<8-hex-hash>` (43
   chars) instead of the proposed open-ended composite. The hash is
   `sha256(version_id + ':' + pass_id + ':' + sequence)[0:8]`,
   deterministic across replays. (§5.6.2)
6. **Pass id taxonomy locked.** `pass_id` is snake_case with no dot
   (`clause_extraction`); `artifact_type` is namespaced dot form
   (`legal.clause`). YAMLs already follow this; the doc now states it
   as a rule. (§locked-in choices)
7. **Document-scope artifacts carry source lineage.**
   `EnrichmentArtifact` gains a `source_chunk_ids: list[str]` field
   that the runner stores in the chunk's `metadata` JSON (no schema
   change required). Document-scope passes that synthesize across the
   whole document MUST populate it. (§5.6.1)
8. **Document-scope passes have a hard input token cap.** New
   `default_model.max_input_tokens` (default 100k) governs the pass
   input budget. Passes either map-reduce or truncate-and-log;
   `INPUT_TOO_LARGE_FOR_PASS` is fatal for `required=true` passes,
   recorded as a partial failure for `required=false`. (§locked-in
   choices, §5.7)
9. **Reranker quota fallback is `actionable`.** The audit shape adds
   `actionable: boolean`. `PROVIDER_QUOTA_EXHAUSTED` and
   `PROVIDER_KEY_NOT_FOUND` set it `true` (operator should top up /
   re-register a key); `PROVIDER_UNAVAILABLE` and `PROVIDER_TIMEOUT`
   set it `false` (transient). (§5.9.3, contracts/query.ts)
10. **Per-layer budget rules cleaned up.** A chunk larger than its
    layer cap is admitted iff the layer would otherwise be empty
    (Option A); leftover budget on the last layer is unused, not
    wrapped. (§5.10.2)
11. **Live e2e covers two non-generic profiles.** The Phase-3+4
    `scripts/test-live.ts` is extended to ingest a tiny narrative
    fixture AND a tiny legal fixture; the test asserts pass-specific
    artifact types appear. (§5.12)
12. **Required-pass failure → version_indexes.status='failed', not
    'partial'.** Avoids the "failed job exposes partial index"
    confusion. (§5.11.2)
13. **Profile invariants test.** Beyond schema validation, every
    YAML's referential integrity is checked: `passage` is in
    `artifact_types`; every `produces[*]` appears in either
    `artifact_types` or is intentionally query-disabled; every
    `layer_budgets`/`layer_order` key is in `artifact_types`; every
    `depends_on` references a real pass id; every pass id is
    registered in the Container. (§5.1.5)
14. **Rerank config refinement.** Zod + Pydantic both enforce
    "if `enabled=true`, `provider` and `model` are required."
    (§5.1.2, §5.5.2)
15. **Python loader path is robust.** Reads
    `TEXTRAL_CORPUS_PROFILES_DIR` env var first; falls back to a
    runtime walk that tries `/app/profiles` and the parents-relative
    path. Documented in 5.5.3.

Items I did NOT take from the feedback:

- *Replace the index name with `large-3072-cosine`.* The 1536 name
  reflects the actually-deployed Vectorize V2 index. Renaming would
  require re-provisioning every dev artifact. The clarification note
  (item 1 above) addresses the ambiguity concern without churn.
- *Change profile examples from `gpt-4o-mini` / `gpt-4o`.* These are
  the model strings Phase 2 + the live e2e validate against today.
  The "gpt-5.x" naming in earlier docs was anticipatory; the live
  pipeline uses the 4o family.

---

## What Phase 5 specifically does NOT do

Calling these out so the scope stays bounded:

- **No new embedding profile bundles.** Phase 5 reuses the
  Phase 3+4 deploy's Vectorize index, named
  `textral-{env}-openai-text-embedding-3-large-1536-cosine`. The
  `1536` is intentional — OpenAI `text-embedding-3-large` defaults to
  3072 dim, but Vectorize V2 caps a single-vector dim at 1536, so the
  Worker passes `dimensions: 1536` to the OpenAI embed call to
  truncate at the provider. (See PHASE_3_4_IMPLEMENTATION.md
  Prerequisites #9 + Appendix C.4 for the full chain of reasoning.)
  All enrichment artifacts in a namespace embed under that same
  profile. Per-artifact-type embedding models multiply Vectorize
  indexes by N; Phase 7 revisits that lever if the eval bench shows
  it's worth the operational cost.
- **No tenant-scoped profile overrides.** Profiles are global YAML.
  Phase 6+ adds tenant-scoped overrides if customers actually ask.
- **No streaming for synthesis.** Sync responses only; streaming
  ships in Phase 6.
- **No eval bench.** Phase 7 builds the small reference corpus +
  expected-results harness. Phase 5's reranker work is the *lever*;
  the bench that measures it lands later.
- **No legacy migration tooling for Phase 4-shipped indexes.** Any
  `version_index` ingested without enrichment in Phase 4 stays
  exactly as-is; re-ingestion is the upgrade path.
- **No new Secrets Store cutover.** The KV-backed `pkey/*` shim from
  Phase 3+4 Appendix C.2 stays in place. Phase 5 does not block on it.
- **No new Vectorize index provisioning.** Phase 5 reuses what's
  there.

---

## Prerequisites recap

These are already true at the end of Phase 3+4:

- `chunks` table has `artifact_type`, `embedding_status`,
  `embedding_input_hash`, `embedding_provider_request_id`,
  `embedding_dimensions`. Triggers keep `chunks_fts` in sync on
  insert/update/delete. (Phase 3.1)
- `ingestion_jobs.enrichment_config` (JSON) and
  `ingestion_jobs.enrichment_status` (TEXT) exist. (Phase 3.1)
- Worker exposes `/internal/providers/embed` and `/internal/chunks/batch`
  HMAC-authenticated; the Container POSTs to them. (Phase 3.4.3 +
  Phase 3.4.4 + Phase 3+4 Appendix C.5)
- Worker owns retrieval; the Container is ingestion-only. The
  retrieval pipeline emits `audit.reranker = { enabled: false, ... }`
  in every Phase 4 response — locking the field name + position so
  Phase 5 flips `enabled: true` without changing response shape.
  (Phase 4.5.2, 4.8.1)
- Both Voyage and Cohere rerank providers exist behind the
  `RerankProvider` interface. (Phase 2.6)
- Live e2e (`make test-live`) is green against deployed dev.

Operational prereqs:

- `pnpm` and Node 24.
- The dev deploy from Phase 3+4 is intact (D1, R2, KV, Vectorize V2,
  Workers AI binding, Container DO, queue + DLQ).
- `OPENAI_API_KEY` (for the enrichment LLM in `narrative` and
  `legal` profiles' default model).
- `VOYAGE_API_KEY` (registered as a BYOK key under the seed tenant
  for live rerank tests).

---

## Locked-in technology choices

### Profile loading

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Source of truth | **YAML in `packages/corpus-profiles/profiles/*.yaml`** | One file per profile, no compile step required. |
| Worker loader | **TS module that reads + Zod-validates at import time** | Validation crashes the Worker at boot if a profile is malformed. No silent drift to runtime. |
| Container loader | **Python module that reads + Pydantic-validates at uvicorn startup** | Same crash-at-boot semantics. The Container's Dockerfile COPYs the YAMLs into the image at build time. |
| Schema parity | **A `profile-parity.test.ts` and `test_profile_parity.py` load every shipped profile through both validators and assert equivalence on a structural diff** | Catches a Zod-vs-Pydantic drift before it ships. |
| Profile registration | **The `corpus_profiles` table from `1-DESIGN.md` §5.1 is NOT created** | The registry lives in code (the YAML files). D1 only stores the *name* (`namespaces.corpus_profile`); the YAML registry resolves it. |
| Hot reload | **None — restart the Worker and Container to pick up YAML changes** | Profile churn is rare. Adds operational complexity for negative value. |
| Override merging | **Deep merge: profile defaults bottom, request body top** | Predictable. Arrays (e.g. `enrichment.passes`) replace wholesale; scalars override. |

### Enrichment

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Stage placement | **New stage `enrich` runs after `index`** | Passages are already indexed when enrichment starts. Enrichment artifacts get the same embed→index treatment, so a partial-enrichment outcome doesn't corrupt the passage index. |
| Per-pass attempts | **`ingest_stage_attempts` rows with `stage='enrich.<pass_id>'`** | Reuses the existing schema; per-pass forensics for free. The `enrich` umbrella is a virtual concept — there's no `stage='enrich'` row. |
| Pass interface | **`EnrichmentPass.run(ctx) -> list[Chunk]`** | Each pass returns the artifact chunks it produced. The runner indexes them. |
| Pass scope | **Declared in YAML: `chunk \| section \| document`** | Runner gathers inputs accordingly: per chunk, per heading-level section, or once per document. |
| Pass dependency model | **Topological sort by `depends_on`** | A pass with a failed dependency is recorded `status='skipped'` and contributes nothing. |
| Required vs optional | **YAML `required: bool`** (default `false`) | `required=true` failure → fatal stage failure → job fails. `required=false` failure → log + continue, surface in `enrichment_status='partial'`. |
| Per-pass model | **`request.enrichment.passes[id].model` > `request.enrichment.default_model` > `profile.enrichment.passes[id].model` > `profile.enrichment.default_model`** | Request beats profile (consistent with the rest of the API); within each scope, per-pass beats default. The runner walks this chain top-to-bottom and uses the first non-null value. Missing all four raises. |
| Pass-side embedding | **Each enrichment pass produces text only**; the runner embeds + indexes via the same `/internal/providers/embed` + `/internal/chunks/batch` path passages use | Single embed pipeline. The pass author writes pure text-extraction logic; the runner owns transport + persistence. |
| Embedding profile | **Same as the namespace's** — all artifacts in a namespace share one profile | Multiplying Vectorize indexes per artifact type is a future-Phase decision. |
| Parent lineage | **New column `chunks.parent_chunk_id` (nullable, REFERENCES chunks(id))** | NULL for passages and document-scope artifacts; set for chunk- and section-scope artifacts. |
| Pass id format | **Snake-case identifier, no dot**: `clause_extraction`, `obligation_extraction`, `section_summary`, `character_dossier` | Pass IDs are stage-attempt keys (`enrich.<pass_id>`); a dot would conflict with the existing `stage` separator. |
| Artifact type format | **Namespaced dot form**: `legal.clause`, `narrative.section_summary`, `support.step` | Passages are the unprefixed `passage`. The dot-namespace gives us cheap collision avoidance across profiles. |
| `artifact_type` ↔ pass relationship | **One pass produces one or more `artifact_type` values**; declared on the pass via `produces: list[str]`. Each entry must start with `${artifact_namespace}.` | The pass id is the pivot for stage attempts; `artifact_type` is the pivot for retrieval. Two different identifiers because they index different concerns. |
| Failure surface | **`ingestion_jobs.enrichment_status ∈ {'none','full','partial','failed'}`** | Set when all passes are done. `none` if no enrichment configured. `full` all required + optional passes succeeded. `partial` if any optional failed. `failed` if any required failed (the job is also `status='failed'`). |
| Replay | **The runner skips passes whose latest stage-attempt is `'completed'`** | Same idempotency contract as the Phase 3 stages; rerunning a job replays only the failed passes. |
| Document-scope inputs | **The pass receives all chunks in the version, ordered by `(section_path, ord)`, capped at `max_input_tokens`** | Predictable input shape. Cross-section reasoning (character dossier, theme) gets a coherent view. |
| Document-scope input cap | **`max_input_tokens` per pass; default 100,000; profile YAML can override** | Prevents a 500-page novel from becoming a 500k-token API call. The runner counts tokens (cl100k_base) before invoking the pass. |
| Cap-exceeded behavior | **Three explicit options chosen per pass**: `map_reduce` (default — pass implements its own partial+combine), `truncate` (head-N tokens, log truncation in `ingest_stage_attempts.metadata.truncated_input=true`), or `fail` (raise `INPUT_TOO_LARGE_FOR_PASS`). YAML field: `oversize_strategy` | Eliminates "concatenate the whole document" implicit blow-up. Each pass author makes a deliberate choice. |
| Required + INPUT_TOO_LARGE | If the pass declared `required=true` and oversize_strategy=`fail` triggers → fatal stage failure | Same precedence as any other required-pass failure. |
| Optional + INPUT_TOO_LARGE | If `required=false` and oversize_strategy=`fail` triggers → `outcomes[pass_id]='failed'` with error_code=`INPUT_TOO_LARGE_FOR_PASS`; job continues | Surfaced as `enrichment_status='partial'`. |
| Section-scope inputs | **Adjacent chunks sharing the same section_path at depth ≤ 2** | Same boundary the chunker uses — sections are coherent units. |
| Pass output cardinality | **Multiple chunks per pass run**; e.g. `character_dossier` produces one chunk per character | The runner indexes them in a batch. |
| Pass output text | **Plain text**; metadata (e.g. character_name, role, scene_id) goes in the chunk's `metadata` JSON field | Searchable via FTS5 + queryable via Vectorize. Metadata fields are filterable per Phase 4 plumbing. |
| Per-pass token accounting | **Logged in `ingest_stage_attempts.metadata.tokens = { input, output }`** | Phase 6 cost accounting will sum across passes. |

### Retrieval extensions

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Reranker invocation point | **After RRF fusion, before context assembly** | RRF gives a fused candidate set; the reranker rescores with cross-encoder semantics; context assembly works on the post-rerank order. |
| Reranker request shape | **`{query, documents: [chunk.text], top_n}`** — same shape Voyage and Cohere expect | The retrieval pipeline maps internally between chunk_id ↔ document index. |
| Reranker top-N default | **12** (per profile YAML; per-request override supported) | Phase 4's RRF returned up to 30; reranker filters down. |
| Reranker fallback | **On provider 5xx, quota, or timeout → use the RRF top-K (i.e. skip rerank)**; record `fallback_reason` and `actionable` in the audit | Never block a query on reranker availability. The point of reranking is precision, not feasibility. |
| Audit shape | **Extended**: `audit.reranker = { enabled, executed, provider?, model?, top_n?, latency_ms?, fallback_reason?, actionable? }` | `enabled` is what was requested; `executed` is what actually happened; `actionable` flags fallback reasons that need operator attention (`PROVIDER_QUOTA_EXHAUSTED`, `PROVIDER_KEY_NOT_FOUND` → `true`; `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT` → `false`). Backwards-compatible: `enabled: false, executed: false` is the Phase 4 shape. |
| Per-layer budget | **Profile YAML declares `retrieval.layer_budgets: { artifact_type: fraction }`**; fractions normalize to 1.0 if they don't sum exactly | Profile expresses the *intent*; the assembler honors it within the available budget. |
| Per-layer budget normalization | **If a profile declares fractions summing to e.g. 0.95, normalize to 1.0** | Prevents accidental under-allocation when a profile author misses a few percent. |
| Per-request override | **`request.context.layer_budgets`** merges by key over the profile values | Same precedence as everywhere else. |
| Underfill spill | **If a layer's budget is partially consumed (no more candidates of that type), the leftover spills to the next-declared layer in the profile** | Avoids returning a context that's e.g. 75% full when the corpus has slightly fewer character_dossier chunks than budgeted. |
| Layer ordering in context | **Profile YAML declares the order in `retrieval.layer_order`**; defaults to declaration order in `layer_budgets` | The synthesizer sees layers in the order the profile says they should appear (passages first, summaries second, etc). Citation numbering `[N]` increments across layers. |
| `retrieval.artifact_types` | **Now sourced from the profile by default**, can be overridden per-request | Phase 4 always passed `['passage']`. Phase 5 trusts the profile. |
| Re-rank model defaults per profile | **Defined in profile YAML**: e.g. `narrative` → Voyage rerank-2; `legal` → Voyage rerank-2; `generic` → disabled | Sensible defaults; per-request override always wins. |
| Reranker provider key resolution | **Same `provider_key_ref` flow as embedding/inference** | Reuse Phase 2.7's resolver. |

---

## Naming and locations

```
packages/corpus-profiles/             ← NEW workspace package
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                      ← public API: getProfile, listProfiles, mergeProfile
│   ├── loader.ts                     ← reads YAML at module init
│   ├── schema.ts                     ← Zod schemas for the profile shape
│   └── merge.ts                      ← deep-merge with array-replace semantics
├── profiles/                         ← YAML, single source of truth for both apps
│   ├── generic.yaml
│   ├── narrative.yaml
│   ├── legal.yaml
│   ├── support.yaml
│   └── technical.yaml
└── test/
    ├── load.test.ts                  ← validates every shipped profile parses
    ├── merge.test.ts                 ← override semantics
    └── parity.test.ts                ← TS-side counterpart of the Python parity test

apps/api/src/
├── retrieval/
│   ├── rerank.ts                     ← NEW — Voyage/Cohere invocation + fallback
│   ├── context-assembly.ts           ← EXTENDED — per-layer budget + layer ordering
│   ├── profile-resolver.ts           ← NEW — namespace.corpus_profile + request merge
│   └── (existing files: hybrid.ts, fts5-query.ts, vectorize-query.ts, rrf.ts, profile-gate.ts, tokenizer.ts)
├── routes/
│   ├── query.ts                      ← EXTENDED — invokes profile-resolver before retrieval
│   └── documents.ts                  ← EXTENDED — `/ingest` merges profile defaults
└── ingestion/
    └── dispatch.ts                   ← EXTENDED — config_json carries the merged profile

apps/api/migrations/
└── 0003_phase5_enrichment.sql        ← parent_chunk_id + enrichment_pass_id

apps/api/test/
├── profile-resolver.test.ts          ← merge semantics, namespace resolution
├── rerank.test.ts                    ← provider success / 5xx fallback
├── rerank-fallback.test.ts           ← integration: hybrid → rerank fail → context still assembles
├── context-assembly-budget.test.ts   ← per-layer budget enforcement + spill
└── (existing query-route.test.ts gets new cases)

apps/ingest/Dockerfile                ← EXTENDED — COPY ../../packages/corpus-profiles/profiles
apps/ingest/profiles/                 ← BUILD-TIME COPY (gitignored, present in image only)

apps/ingest/app/
├── corpus_profiles/
│   ├── __init__.py
│   ├── loader.py                     ← reads profiles/ at uvicorn startup
│   ├── schema.py                     ← Pydantic schemas mirroring the Zod shape
│   └── merge.py                      ← deep-merge mirror of the TS implementation
├── enrichment/
│   ├── __init__.py
│   ├── runner.py                     ← topo sort + dispatch + per-pass logging
│   ├── types.py                      ← EnrichmentPass, EnrichmentContext
│   ├── narrative/
│   │   ├── __init__.py
│   │   ├── section_summary.py
│   │   ├── scene.py
│   │   ├── character_dossier.py
│   │   └── theme.py
│   ├── legal/
│   │   ├── __init__.py
│   │   ├── clause.py
│   │   └── obligation.py
│   ├── support/
│   │   ├── __init__.py
│   │   └── troubleshooting_step.py
│   └── technical/
│       ├── __init__.py
│       └── endpoint_reference.py
├── chunkers/
│   ├── (existing) generic.py
│   ├── code_aware.py                 ← NEW — never split inside fenced blocks
│   └── legal_clause_aware.py         ← NEW — clause boundaries
└── stages/
    └── enrich.py                     ← NEW — stage orchestrator

apps/ingest/tests/
├── test_profile_loader.py
├── test_profile_parity.py            ← Python-side counterpart of TS parity test
├── test_enrichment_runner.py         ← topo sort + skip + replay
├── test_enrichment_section_summary.py
├── test_enrichment_clause.py
├── test_chunker_code_aware.py
└── test_chunker_legal_clause.py
```

---

# Step 5.1 — Profile package + loader (Worker side)

**Goal:** A new `@textral/corpus-profiles` package validates and
exports every shipped profile. The Worker imports `getProfile(id)` and
gets a typed object, never a raw YAML.

## 5.1.1 Workspace package

**Files**
- `packages/corpus-profiles/package.json`
- `packages/corpus-profiles/tsconfig.json`
- `packages/corpus-profiles/src/index.ts`
- `packages/corpus-profiles/src/loader.ts`
- `packages/corpus-profiles/src/schema.ts`
- `packages/corpus-profiles/src/merge.ts`

**`package.json`**:

```json
{
  "name": "@textral/corpus-profiles",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest"
  },
  "dependencies": {
    "@textral/contracts": "workspace:*",
    "yaml": "^2.7.0",
    "zod": "^3.23.0"
  }
}
```

The Worker (and any future TS consumer) depends on it via
`workspace:*`. The Container does NOT depend on it — Python ports the
schema separately (5.5).

## 5.1.2 Zod schema

**File**: `packages/corpus-profiles/src/schema.ts`

```ts
import { z } from 'zod';

/** The chunker IDs the Container's stages/chunk.py dispatch knows
 *  about. A typo in a profile YAML crashes the Worker at boot rather
 *  than silently falling back to `generic`. */
export const ChunkerId = z.enum(['generic', 'code_aware', 'legal_clause_aware']);

export const ChunkingProfileConfig = z.object({
  profile: ChunkerId.default('generic'),
  target_tokens: z.number().int().positive().default(600),
  overlap_tokens: z.number().int().nonnegative().default(80),
  boundary_depth: z.number().int().nonnegative().default(2),
});

export const InferenceModelRef = z.object({
  provider: z.enum(['openai', 'anthropic', 'workers_ai', 'cohere', 'voyage']),
  model: z.string().min(1),
  provider_key_ref: z.string().optional(),
});

export const PassId = z.string().regex(
  /^[a-z][a-z0-9_]*$/,
  'pass id must be snake_case, no dot',
);

export const EnrichmentPassDef = z
  .object({
    id: PassId,
    scope: z.enum(['chunk', 'section', 'document']),
    required: z.boolean().default(false),
    depends_on: z.array(PassId).default([]),
    /** Per-pass model override; falls through to profile default. */
    model: InferenceModelRef.optional(),
    /** Vendor namespace prefix the pass writes under, e.g. 'narrative'. */
    artifact_namespace: z.string().min(1),
    /** Concrete artifact_type values this pass produces. Each must
     *  start with `${artifact_namespace}.` (enforced in superRefine
     *  on the parent profile). */
    produces: z.array(z.string().min(1)).min(1),
    /** Max input tokens the pass may consume in one invocation.
     *  Document-scope passes use this to cap full-document blowups. */
    max_input_tokens: z.number().int().positive().default(100_000),
    /** What happens when input tokens exceed max_input_tokens.
     *  - 'map_reduce' (default): the pass implements partial+combine
     *  - 'truncate': head-N tokens, ingest_stage_attempts.metadata
     *    records truncated_input=true
     *  - 'fail': raise INPUT_TOO_LARGE_FOR_PASS (fatal if required) */
    oversize_strategy: z.enum(['map_reduce', 'truncate', 'fail']).default('map_reduce'),
  })
  .superRefine((p, ctx) => {
    for (const at of p.produces) {
      if (!at.startsWith(`${p.artifact_namespace}.`)) {
        ctx.addIssue({
          code: 'custom',
          message: `produces[${at}] must start with ${p.artifact_namespace}.`,
        });
      }
    }
  });

export const RerankConfig = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(['voyage', 'cohere']).optional(),
    model: z.string().optional(),
    top_n: z.number().int().positive().default(12),
    provider_key_ref: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    // If reranking is on, provider+model are mandatory. Avoids a
    // non-null assertion at the call site, and gives the YAML author
    // a clear boot-time error if they enable rerank without naming
    // a provider.
    if (cfg.enabled) {
      if (!cfg.provider) {
        ctx.addIssue({ code: 'custom', message: 'rerank.provider is required when enabled' });
      }
      if (!cfg.model) {
        ctx.addIssue({ code: 'custom', message: 'rerank.model is required when enabled' });
      }
    }
  });

export const RetrievalDefaults = z.object({
  strategy: z.literal('hybrid_rrf').default('hybrid_rrf'),
  artifact_types: z.array(z.string()).min(1),
  rerank: RerankConfig,
  layer_budgets: z.record(z.string(), z.number().min(0).max(1)).default({}),
  layer_order: z.array(z.string()).default([]),
});

export const PromptDefaults = z.object({
  system: z.string().optional(),
  developer: z.string().optional(),
});

export const CorpusProfile = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  chunking: ChunkingProfileConfig,
  enrichment: z.object({
    enabled: z.boolean().default(false),
    default_model: InferenceModelRef.optional(),
    passes: z.array(EnrichmentPassDef).default([]),
  }),
  retrieval_defaults: RetrievalDefaults,
  prompt_defaults: PromptDefaults.default({}),
});
export type CorpusProfile = z.infer<typeof CorpusProfile>;
```

## 5.1.3 Loader

**File**: `packages/corpus-profiles/src/loader.ts`

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { CorpusProfile } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(__dirname, '..', 'profiles');

function loadAll(): Map<string, CorpusProfile> {
  const out = new Map<string, CorpusProfile>();
  for (const file of readdirSync(PROFILES_DIR)) {
    if (!file.endsWith('.yaml')) continue;
    const raw = parseYaml(readFileSync(join(PROFILES_DIR, file), 'utf8'));
    const parsed = CorpusProfile.parse(raw);
    if (out.has(parsed.id)) {
      throw new Error(`Duplicate corpus profile id: ${parsed.id}`);
    }
    out.set(parsed.id, parsed);
  }
  if (!out.has('generic')) {
    throw new Error('Missing required profile: generic');
  }
  return out;
}

const REGISTRY: ReadonlyMap<string, CorpusProfile> = loadAll();

export function getProfile(id: string): CorpusProfile | undefined {
  return REGISTRY.get(id);
}

export function listProfiles(): CorpusProfile[] {
  return Array.from(REGISTRY.values());
}

export function getProfileOrThrow(id: string): CorpusProfile {
  const p = REGISTRY.get(id);
  if (!p) throw new Error(`Unknown corpus profile: ${id}`);
  return p;
}
```

The loader runs at module-import time. A malformed profile crashes
the Worker at boot — exactly what we want. Cloudflare Workers cache
the import, so this is paid once per cold start.

## 5.1.4 Merge helper

**File**: `packages/corpus-profiles/src/merge.ts`

```ts
import type { CorpusProfile } from './schema.js';

/** Deep merge: scalars and objects from `override` win; arrays
 *  replace wholesale (no concatenation). Mirrors the Python impl.
 *
 *  IMPORTANT footgun: if `override.enrichment.passes` is supplied,
 *  it REPLACES the profile's pass list entirely. A request that wants
 *  to disable one pass must respecify the complete remaining pass
 *  list. The /ingest route's OpenAPI description calls this out
 *  explicitly to avoid "why did my narrative profile stop producing
 *  section summaries?" confusion.
 */
export function mergeProfile(
  base: CorpusProfile,
  override: Partial<CorpusProfile>,
): CorpusProfile {
  return {
    ...base,
    ...override,
    chunking: { ...base.chunking, ...(override.chunking ?? {}) },
    enrichment: { ...base.enrichment, ...(override.enrichment ?? {}) },
    retrieval_defaults: {
      ...base.retrieval_defaults,
      ...(override.retrieval_defaults ?? {}),
      rerank: {
        ...base.retrieval_defaults.rerank,
        ...(override.retrieval_defaults?.rerank ?? {}),
      },
      layer_budgets: {
        ...base.retrieval_defaults.layer_budgets,
        ...(override.retrieval_defaults?.layer_budgets ?? {}),
      },
    },
    prompt_defaults: { ...base.prompt_defaults, ...(override.prompt_defaults ?? {}) },
  };
}
```

## 5.1.5 Tests

- `packages/corpus-profiles/test/load.test.ts` — every shipped
  profile loads without throwing; `getProfile('generic')` returns the
  generic profile; `listProfiles()` includes all five.
- `packages/corpus-profiles/test/merge.test.ts` — overriding
  `chunking.target_tokens` preserves `overlap_tokens`; overriding
  `enrichment.passes` replaces the array wholesale; overriding
  `retrieval_defaults.layer_budgets` merges by key.
- `packages/corpus-profiles/test/invariants.test.ts` — for each
  shipped profile, assert all of:
  - `retrieval_defaults.artifact_types` includes `'passage'`.
  - Every entry in `enrichment.passes[*].produces` appears in
    `retrieval_defaults.artifact_types`. (A pass producing an
    artifact type that's not in the retrieval set means we ingest
    artifacts that nobody can query — almost always a typo.)
  - Every key in `retrieval_defaults.layer_budgets` appears in
    `retrieval_defaults.artifact_types`.
  - Every entry in `retrieval_defaults.layer_order` appears in
    `retrieval_defaults.artifact_types`.
  - Every key in `enrichment.passes[*].depends_on` references an
    actual pass id within the same profile.
  - Sum of `layer_budgets` values is ≥ 0.99 and ≤ 1.01 (small
    tolerance; the loader normalizes anyway, but a profile that
    declares 0.5 total is almost certainly a typo).
- `packages/corpus-profiles/test/registry-coverage.test.ts` — every
  pass id in every profile appears in the Container's enrichment
  registry. We can't import the Python registry from TS, so this
  test instead consults a hand-maintained JSON manifest at
  `apps/ingest/app/enrichment/_registry.json`. The Python side
  generates that manifest at boot and a CI check confirms it's in
  sync (5.5.5 below).

**Acceptance**
- `pnpm --filter @textral/corpus-profiles test` green.
- `pnpm --filter @textral/corpus-profiles typecheck` clean.

---

# Step 5.2 — Profile YAMLs

Five profiles ship in MVP. Each YAML is the canonical source.

## 5.2.1 `generic.yaml`

```yaml
id: generic
description: Passages-only fallback profile. No enrichment.
chunking:
  profile: generic
  target_tokens: 600
  overlap_tokens: 80
  boundary_depth: 2
enrichment:
  enabled: false
  passes: []
retrieval_defaults:
  strategy: hybrid_rrf
  artifact_types: [passage]
  rerank:
    enabled: false
    top_n: 12
  layer_budgets:
    passage: 1.0
  layer_order: [passage]
prompt_defaults:
  system: |
    You are a helpful assistant answering questions from the provided context.
```

## 5.2.2 `narrative.yaml`

```yaml
id: narrative
description: Long-form fiction. Multi-layer enrichment + rerank.
chunking:
  profile: generic
  target_tokens: 700
  overlap_tokens: 100
  boundary_depth: 1
enrichment:
  enabled: true
  default_model:
    provider: openai
    model: gpt-4o-mini
  passes:
    - id: section_summary
      scope: section
      required: false
      artifact_namespace: narrative
      produces: [narrative.section_summary]
    - id: scene
      scope: section
      required: false
      depends_on: [section_summary]
      artifact_namespace: narrative
      produces: [narrative.scene]
    - id: character_dossier
      scope: document
      required: false
      artifact_namespace: narrative
      produces: [narrative.character_dossier]
      model:
        provider: openai
        model: gpt-4o
    - id: theme
      scope: document
      required: false
      depends_on: [character_dossier]
      artifact_namespace: narrative
      produces: [narrative.theme]
retrieval_defaults:
  strategy: hybrid_rrf
  artifact_types:
    - passage
    - narrative.section_summary
    - narrative.scene
    - narrative.character_dossier
  rerank:
    enabled: true
    provider: voyage
    model: rerank-2
    top_n: 12
  layer_budgets:
    passage: 0.6
    narrative.section_summary: 0.2
    narrative.character_dossier: 0.2
  layer_order:
    - passage
    - narrative.section_summary
    - narrative.character_dossier
prompt_defaults:
  system: |
    You are answering questions about a long narrative work. Cite the
    specific chunk markers grounding your answer. Distinguish between
    direct quotation, paraphrase, and analysis.
```

## 5.2.3 `legal.yaml`

```yaml
id: legal
description: Contracts + leases. Clause-aware chunking.
chunking:
  profile: legal_clause_aware
  target_tokens: 500
  overlap_tokens: 50
  boundary_depth: 2
enrichment:
  enabled: true
  default_model:
    provider: openai
    model: gpt-4o-mini
  passes:
    - id: clause_extraction
      scope: chunk
      required: false
      artifact_namespace: legal
      produces: [legal.clause]
    - id: obligation_extraction
      scope: document
      required: false
      depends_on: [clause_extraction]
      artifact_namespace: legal
      produces: [legal.obligation]
retrieval_defaults:
  strategy: hybrid_rrf
  artifact_types: [passage, legal.clause, legal.obligation]
  rerank:
    enabled: true
    provider: voyage
    model: rerank-2
    top_n: 12
  layer_budgets:
    passage: 0.4
    legal.clause: 0.4
    legal.obligation: 0.2
  layer_order: [legal.clause, legal.obligation, passage]
prompt_defaults:
  system: |
    You are answering questions about a legal document. Distinguish
    contractual language from your own analysis. Cite the specific
    clause IDs that ground your answer.
```

## 5.2.4 `support.yaml`

```yaml
id: support
description: Customer-support knowledge bases. Step-extraction.
chunking:
  profile: generic
  target_tokens: 400
  overlap_tokens: 60
  boundary_depth: 2
enrichment:
  enabled: true
  default_model:
    provider: openai
    model: gpt-4o-mini
  passes:
    - id: troubleshooting_step
      scope: section
      required: false
      artifact_namespace: support
      produces: [support.step]
retrieval_defaults:
  strategy: hybrid_rrf
  artifact_types: [passage, support.step]
  rerank:
    enabled: true
    provider: voyage
    model: rerank-2
    top_n: 8
  layer_budgets:
    passage: 0.5
    support.step: 0.5
  layer_order: [support.step, passage]
prompt_defaults:
  system: |
    You are answering customer-support questions. Prefer step-by-step
    instructions when the corpus contains them. Cite the source.
```

## 5.2.5 `technical.yaml`

```yaml
id: technical
description: API docs + code references. Code-aware chunking.
chunking:
  profile: code_aware
  target_tokens: 700
  overlap_tokens: 80
  boundary_depth: 2
enrichment:
  enabled: true
  default_model:
    provider: openai
    model: gpt-4o-mini
  passes:
    - id: endpoint_reference
      scope: section
      required: false
      artifact_namespace: technical
      produces: [technical.endpoint]
retrieval_defaults:
  strategy: hybrid_rrf
  artifact_types: [passage, technical.endpoint]
  rerank:
    enabled: true
    provider: voyage
    model: rerank-2
    top_n: 12
  layer_budgets:
    passage: 0.6
    technical.endpoint: 0.4
  layer_order: [technical.endpoint, passage]
prompt_defaults:
  system: |
    You are answering technical / API questions. When the corpus
    includes code or endpoint references, prefer those over prose.
```

**Acceptance**
- `getProfile('narrative').enrichment.passes.length === 4`.
- `getProfile('generic').enrichment.enabled === false`.
- `listProfiles().map(p => p.id).sort()` is `['generic','legal',
  'narrative','support','technical']`.

---

# Step 5.3 — Migration 0003

**File**: `apps/api/migrations/0003_phase5_enrichment.sql`

```sql
-- Phase 5: enrichment artifact lineage + provenance.
ALTER TABLE chunks ADD COLUMN parent_chunk_id TEXT REFERENCES chunks(id);
ALTER TABLE chunks ADD COLUMN enrichment_pass_id TEXT;

-- Per-pass query: how many artifacts of type X from pass Y for version Z?
CREATE INDEX IF NOT EXISTS idx_chunks_pass
  ON chunks(version_id, enrichment_pass_id, artifact_type);

-- Lineage lookup: which artifacts derive from a given passage?
CREATE INDEX IF NOT EXISTS idx_chunks_parent
  ON chunks(parent_chunk_id);
```

`enrichment_status` and `enrichment_config` already exist from
migration 0002. We do NOT add a new `enrichment_outcomes` table; the
`ingest_stage_attempts` rows with `stage LIKE 'enrich.%'` are the
source of truth.

**Migration test**
- `apps/api/test/schema.test.ts` (existing) — extend the assertion
  set to include the two new columns + the two new indexes.

**Acceptance**
- `make migrate-dev` applies 0003 cleanly against the dev D1.
- A post-migration sanity check via `wrangler d1 execute` confirms
  the columns exist and the indexes are present.

---

# Step 5.4 — Profile resolver (Worker)

**Goal:** A single helper resolves the corpus profile a request is
operating under, applies request-body overrides, and returns the
merged shape that downstream code reads.

**Files**
- `apps/api/src/retrieval/profile-resolver.ts`
- `apps/api/test/profile-resolver.test.ts`

**Behavior**

```ts
export async function resolveCorpusProfile(args: {
  env: Env;
  tenant_id: string;
  namespace_slug: string;
  request_overrides?: Partial<CorpusProfile>;
}): Promise<CorpusProfile> {
  // 1. Resolve namespace.
  const ns = await getNamespaceBySlug(args.env.DB, args.tenant_id, args.namespace_slug);
  if (!ns) throw new TextralError('NAMESPACE_NOT_FOUND', 404, ...);

  // 2. Look up the profile by name.
  const profile = getProfileOrThrow(ns.corpus_profile);

  // 3. Merge request overrides on top.
  return args.request_overrides
    ? mergeProfile(profile, args.request_overrides)
    : profile;
}
```

The resolver is invoked from two call sites:

- **Ingest dispatch** (`POST /v1/documents/{id}/ingest`) — merges the
  request's `chunking` + `enrichment` into the profile, persists the
  merged config_json.
- **Query** (`POST /v1/query`) — merges `retrieval`, `prompt`,
  `output`, and `context.layer_budgets` into the profile defaults.

The `IngestRequest` and `QueryRequest` Zod contracts (Phase 3 + 4)
already accept partial config; this just adds a layer of profile
defaults underneath.

**Tests**
- A namespace with `corpus_profile='narrative'` returns the narrative
  profile.
- A request that overrides `retrieval.rerank.enabled=false` produces
  a merged profile with `enabled=false` AND the rest of the
  narrative profile's values intact.
- An override of `enrichment.passes` replaces the array (not merge).
- A namespace with `corpus_profile='unknown'` raises a 500 with a
  clear message — namespaces should have been validated at create
  time (5.4.1 below).

## 5.4.1 Namespace creation validates `corpus_profile`

**File**: `apps/api/src/routes/namespaces.ts` (extended)

The existing namespace-create handler accepts any string for
`corpus_profile`. Tighten it: validate against `listProfiles()` and
return 400 `UNKNOWN_CORPUS_PROFILE` for unknowns.

**Test**
- `POST /v1/namespaces` with `corpus_profile='wrongname'` returns
  400 with details listing the valid choices.

---

# Step 5.5 — Profile loader (Container)

**Goal:** The Container loads the same YAMLs the Worker loads, with
a Pydantic schema mirror.

## 5.5.1 Dockerfile build context + COPY

**File**: `apps/ingest/Dockerfile`

```dockerfile
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
# NEW — corpus profile YAMLs come from the workspace package.
# Wrangler containers' build context is `apps/ingest`; we set up a
# build symlink in CI / make build-ingest before running wrangler so
# the path resolves. See Makefile.
COPY profiles ./profiles

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

`profiles/` inside `apps/ingest/` is a build-time copy from
`packages/corpus-profiles/profiles/`. We do NOT commit it.

**Makefile addition**:

```makefile
build-ingest: ## Build the Container image (mirrors corpus-profiles into ingest/profiles/)
	rm -rf apps/ingest/profiles
	cp -r packages/corpus-profiles/profiles apps/ingest/profiles
	cd apps/api && npx wrangler containers build ../ingest -t textral-ingest:dev
```

`apps/ingest/.gitignore`: add `profiles/`.

## 5.5.2 Pydantic schema

**File**: `apps/ingest/app/corpus_profiles/schema.py`

```python
from __future__ import annotations
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

class ChunkingProfileConfig(BaseModel):
    model_config = ConfigDict(extra='forbid')
    profile: str = 'generic'
    target_tokens: int = 600
    overlap_tokens: int = 80
    boundary_depth: int = 2

class InferenceModelRef(BaseModel):
    model_config = ConfigDict(extra='forbid')
    provider: Literal['openai', 'anthropic', 'workers_ai', 'cohere', 'voyage']
    model: str
    provider_key_ref: Optional[str] = None

class EnrichmentPassDef(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str
    scope: Literal['chunk', 'section', 'document']
    required: bool = False
    depends_on: list[str] = Field(default_factory=list)
    model: Optional[InferenceModelRef] = None
    artifact_namespace: str
    produces: list[str]

class RerankConfig(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool
    provider: Optional[Literal['voyage', 'cohere']] = None
    model: Optional[str] = None
    top_n: int = 12
    provider_key_ref: Optional[str] = None

class RetrievalDefaults(BaseModel):
    model_config = ConfigDict(extra='forbid')
    strategy: Literal['hybrid_rrf'] = 'hybrid_rrf'
    artifact_types: list[str]
    rerank: RerankConfig
    layer_budgets: dict[str, float] = Field(default_factory=dict)
    layer_order: list[str] = Field(default_factory=list)

class PromptDefaults(BaseModel):
    model_config = ConfigDict(extra='forbid')
    system: Optional[str] = None
    developer: Optional[str] = None

class EnrichmentSection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool = False
    default_model: Optional[InferenceModelRef] = None
    passes: list[EnrichmentPassDef] = Field(default_factory=list)

class CorpusProfile(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str
    description: Optional[str] = None
    chunking: ChunkingProfileConfig
    enrichment: EnrichmentSection
    retrieval_defaults: RetrievalDefaults
    prompt_defaults: PromptDefaults = Field(default_factory=PromptDefaults)
```

`extra='forbid'` is the Python equivalent of Zod's strict mode —
extra fields raise.

## 5.5.3 Loader

**File**: `apps/ingest/app/corpus_profiles/loader.py`

The path resolution is a known footgun in Container deploys (the
exact `__file__` ancestry depends on whether the WORKDIR is `/app`
and how the COPY laid things down). We use a three-step search,
documented inline:

```python
from __future__ import annotations
import os
from pathlib import Path
import yaml

from .schema import CorpusProfile


def _candidate_dirs() -> list[Path]:
    """Search order:

      1. $TEXTRAL_CORPUS_PROFILES_DIR (explicit override; honored
         first so test runs and ad-hoc local dev can point at any
         location).
      2. <WORKDIR>/profiles — the canonical Container layout
         (Dockerfile WORKDIR is /app; COPY profiles ./profiles puts
         the YAMLs at /app/profiles).
      3. parents-of-this-file walk: from app/corpus_profiles/loader.py,
         the YAMLs live one or two parents up depending on whether
         `app` is a directory inside the WORKDIR or *is* the WORKDIR.
         Tries both.
    """
    candidates: list[Path] = []
    env_override = os.environ.get('TEXTRAL_CORPUS_PROFILES_DIR')
    if env_override:
        candidates.append(Path(env_override))
    cwd_workdir = Path.cwd() / 'profiles'
    candidates.append(cwd_workdir)
    here = Path(__file__).resolve()
    candidates.append(here.parents[2] / 'profiles')   # WORKDIR=/app, COPY app ./app
    candidates.append(here.parents[1] / 'profiles')   # WORKDIR=/app, COPY app/* .
    return candidates


def _resolve_profiles_dir() -> Path:
    for candidate in _candidate_dirs():
        if candidate.is_dir():
            return candidate
    raise RuntimeError(
        'Corpus profiles directory not found in any of: '
        + ', '.join(str(c) for c in _candidate_dirs())
    )


_REGISTRY: dict[str, CorpusProfile] = {}


def _load_all() -> None:
    if _REGISTRY:
        return
    profiles_dir = _resolve_profiles_dir()
    yaml_files = sorted(profiles_dir.glob('*.yaml'))
    if not yaml_files:
        raise RuntimeError(f'No profile YAMLs in {profiles_dir}')
    for yaml_path in yaml_files:
        raw = yaml.safe_load(yaml_path.read_text(encoding='utf-8'))
        profile = CorpusProfile.model_validate(raw)
        if profile.id in _REGISTRY:
            raise RuntimeError(f'Duplicate corpus profile id: {profile.id}')
        _REGISTRY[profile.id] = profile
    if 'generic' not in _REGISTRY:
        raise RuntimeError('Missing required profile: generic')


def get_profile(profile_id: str) -> CorpusProfile | None:
    _load_all()
    return _REGISTRY.get(profile_id)


def get_profile_or_raise(profile_id: str) -> CorpusProfile:
    p = get_profile(profile_id)
    if p is None:
        raise RuntimeError(f'Unknown corpus profile: {profile_id}')
    return p


def list_profiles() -> list[CorpusProfile]:
    _load_all()
    return list(_REGISTRY.values())
```

The pytest harness sets `TEXTRAL_CORPUS_PROFILES_DIR` to point at
`packages/corpus-profiles/profiles/` so tests run without needing the
Container's build-time COPY.

The Container instructs uvicorn to load profiles eagerly at startup
so a malformed YAML crashes the boot:

**File**: `apps/ingest/app/main.py` (extended)

```python
from .corpus_profiles.loader import list_profiles

app = FastAPI(title='textral-ingest', version='0.2.0')

@app.on_event('startup')
async def _eager_load_profiles() -> None:
    profiles = list_profiles()
    print(f'[boot] loaded {len(profiles)} corpus profiles', flush=True)
```

## 5.5.4 Registry-coverage manifest

The TS-side invariants test (5.1.5) needs to know "is this pass id
registered in the Container?" without importing Python. We solve
that with a tiny generated JSON manifest.

**Files**
- `apps/ingest/scripts/dump_registry.py` — prints the registered
  pass ids as JSON.
- `apps/ingest/app/enrichment/_registry.json` — committed file,
  always in sync.
- CI step `pytest tests/test_registry_in_sync.py` — runs the dump
  script and asserts the committed file matches its output.

```python
# apps/ingest/scripts/dump_registry.py
import json
import sys

from app.enrichment.runner import _REGISTRY  # populated by submodule imports

print(json.dumps(sorted(_REGISTRY.keys()), indent=2))
```

The TS test imports `_registry.json` and cross-references against
every profile's pass list:

```ts
import registry from '../../../apps/ingest/app/enrichment/_registry.json';
for (const profile of listProfiles()) {
  for (const pass of profile.enrichment.passes) {
    expect(registry).toContain(pass.id);
  }
}
```

This catches "I added a pass to the YAML but forgot to register it
in the runner" before deploy. The cost is one regenerated JSON file
per pass id you add — trivial.

## 5.5.5 Parity test

**Files**
- `packages/corpus-profiles/test/parity.test.ts`
- `apps/ingest/tests/test_profile_parity.py`

The TS-side parity test loads every profile through the TS loader,
serializes to a stable canonical JSON (sorted keys), and writes the
result to `packages/corpus-profiles/test/_canonical.json`. The
Python parity test loads the same profiles through the Python loader,
serializes the same way, and asserts the JSON matches. Drift between
Zod and Pydantic shows up here as a diff.

**Acceptance**
- `pnpm --filter @textral/corpus-profiles test parity` green.
- `make test-ingest` (which now includes
  `tests/test_profile_parity.py`) green.

---

# Step 5.6 — Enrichment runner

**Goal:** A single dispatcher that runs the profile's enrichment
passes in topological order, indexes their output, and records
per-pass attempts.

**Files**
- `apps/ingest/app/enrichment/types.py`
- `apps/ingest/app/enrichment/runner.py`
- `apps/ingest/app/stages/enrich.py`

## 5.6.1 Pass interface

**File**: `apps/ingest/app/enrichment/types.py`

```python
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Protocol

from ..cdm.model import CanonicalDocument
from ..chunkers.generic import Chunk
from ..corpus_profiles.schema import EnrichmentPassDef, InferenceModelRef


@dataclass
class EnrichmentArtifact:
    """One artifact produced by a pass.
    Becomes a chunks row with artifact_type set; embedded + indexed
    by the runner via the Worker's /internal/* endpoints."""
    artifact_type: str
    section_path: str
    text: str
    metadata: dict
    # Direct lineage: NULL for passages and document-scope artifacts;
    # set for chunk- and section-scope artifacts derived from a single
    # parent passage.
    parent_chunk_id: str | None = None
    # Document-scope synthesis lineage. A character_dossier or theme
    # is a synthesized statement that summarizes across many passages;
    # this list names them, so the citation chain stays auditable
    # even when parent_chunk_id is null. The runner copies this list
    # into the chunk row's metadata JSON before indexing.
    source_chunk_ids: list[str] = field(default_factory=list)


@dataclass
class EnrichmentContext:
    """Inputs the runner hands to a pass.

    `passages` is always the full Layer-1 chunk list (read-only); a
    pass-scope filter (chunk / section / document) determines which
    subset the pass actually iterates."""
    cdm: CanonicalDocument
    passages: list[Chunk]
    profile_id: str
    pass_def: EnrichmentPassDef
    resolved_model: InferenceModelRef
    # Other pass outputs already produced this run (keyed by pass id),
    # in case a downstream pass needs them.
    upstream_artifacts: dict[str, list[EnrichmentArtifact]] = field(default_factory=dict)


class EnrichmentPass(Protocol):
    """Pure text-extraction. The runner owns transport + persistence."""
    async def run(self, ctx: EnrichmentContext) -> list[EnrichmentArtifact]: ...
```

## 5.6.2 Pass registry

**File**: `apps/ingest/app/enrichment/runner.py`

```python
from __future__ import annotations
import time
from collections import defaultdict
from typing import Awaitable, Callable

from ..clients.worker import WorkerClient, WorkerError
from ..corpus_profiles.schema import (
    CorpusProfile,
    EnrichmentPassDef,
    InferenceModelRef,
)
from .types import EnrichmentArtifact, EnrichmentContext, EnrichmentPass

# Pass id → factory. Populated by submodule imports below.
_REGISTRY: dict[str, Callable[[], EnrichmentPass]] = {}

def register_pass(pass_id: str, factory: Callable[[], EnrichmentPass]) -> None:
    if pass_id in _REGISTRY:
        raise RuntimeError(f'Pass already registered: {pass_id}')
    _REGISTRY[pass_id] = factory

# Eager registration via submodule imports.
from .narrative import section_summary, scene, character_dossier, theme  # noqa: E402,F401
from .legal import clause, obligation                                    # noqa: E402,F401
from .support import troubleshooting_step                                # noqa: E402,F401
from .technical import endpoint_reference                                # noqa: E402,F401


def _topo_sort(passes: list[EnrichmentPassDef]) -> list[EnrichmentPassDef]:
    """Kahn's algorithm. Cycles raise."""
    indeg: dict[str, int] = {p.id: 0 for p in passes}
    deps: dict[str, list[str]] = defaultdict(list)
    for p in passes:
        for d in p.depends_on:
            deps[d].append(p.id)
            indeg[p.id] = indeg.get(p.id, 0) + 1
    by_id = {p.id: p for p in passes}
    queue = [pid for pid, n in indeg.items() if n == 0]
    out: list[EnrichmentPassDef] = []
    while queue:
        pid = queue.pop(0)
        out.append(by_id[pid])
        for downstream in deps[pid]:
            indeg[downstream] -= 1
            if indeg[downstream] == 0:
                queue.append(downstream)
    if len(out) != len(passes):
        raise RuntimeError('Cycle in enrichment passes depends_on graph')
    return out


def _resolve_pass_model(
    pass_def: EnrichmentPassDef,
    profile: CorpusProfile,
    request_pass_overrides: dict[str, InferenceModelRef],
    request_default_model: InferenceModelRef | None,
) -> InferenceModelRef:
    """Resolve in this strict order (request beats profile; within
    each scope, per-pass beats default):

      1. request.enrichment.passes[pass_id].model
      2. request.enrichment.default_model
      3. profile.enrichment.passes[pass_id].model  (i.e. pass_def.model)
      4. profile.enrichment.default_model

    Missing all four raises — passes need a model.
    """
    if pass_def.id in request_pass_overrides:
        return request_pass_overrides[pass_def.id]
    if request_default_model is not None:
        return request_default_model
    if pass_def.model is not None:
        return pass_def.model
    if profile.enrichment.default_model is not None:
        return profile.enrichment.default_model
    raise RuntimeError(
        f'No model resolvable for enrichment pass {pass_def.id}'
    )


async def run_enrichment(
    *,
    worker: WorkerClient,
    job_id: str,
    tenant_id: str,
    namespace_id: str,
    document_id: str,
    version_id: str,
    version_index_id: str,
    embedding_profile: str,
    chunking_profile: str,
    embedding_dimensions: int,
    profile: CorpusProfile,
    request_default_model: InferenceModelRef | None,
    request_pass_overrides: dict[str, InferenceModelRef],
    cdm,                        # CanonicalDocument; typed loose to avoid cycles
    passages: list,              # list[Chunk]
) -> dict[str, str]:
    """Returns a dict {pass_id: 'completed' | 'skipped' | 'failed'}.

    Per-pass logic:
      - record stage_attempt 'started'
      - resolve model
      - call pass.run(ctx)
      - embed each produced artifact via /internal/providers/embed
      - index via /internal/chunks/batch
      - record stage_attempt 'completed' (with metadata.tokens)

    On a pass failure:
      - if required: re-raise (the job becomes 'failed')
      - else: record stage_attempt 'failed', set outcome='failed'
    """
    if not profile.enrichment.enabled or not profile.enrichment.passes:
        return {}

    ordered = _topo_sort(profile.enrichment.passes)
    upstream: dict[str, list[EnrichmentArtifact]] = {}
    outcomes: dict[str, str] = {}

    for pass_def in ordered:
        # Skip if any dependency failed/was skipped.
        if any(outcomes.get(dep) in (None, 'failed', 'skipped') for dep in pass_def.depends_on):
            outcomes[pass_def.id] = 'skipped'
            await _stage_attempt(
                worker, job_id, f'enrich.{pass_def.id}', 'skipped',
                started_at=int(time.time() * 1000),
                metadata={'reason': 'upstream dependency failed or skipped'},
            )
            continue

        started_at = int(time.time() * 1000)
        await _stage_attempt(
            worker, job_id, f'enrich.{pass_def.id}', 'started',
            started_at=started_at,
        )

        try:
            resolved_model = _resolve_pass_model(
                pass_def, profile, request_pass_overrides, request_default_model,
            )
            ctx = EnrichmentContext(
                cdm=cdm,
                passages=passages,
                profile_id=profile.id,
                pass_def=pass_def,
                resolved_model=resolved_model,
                upstream_artifacts=upstream,
            )
            handler = _REGISTRY[pass_def.id]()
            artifacts = await handler.run(ctx)

            # Index the artifacts: embed + write chunks rows.
            indexed_count = await _index_artifacts(
                worker=worker,
                job_id=job_id,
                tenant_id=tenant_id,
                namespace_id=namespace_id,
                document_id=document_id,
                version_id=version_id,
                version_index_id=version_index_id,
                embedding_profile=embedding_profile,
                chunking_profile=chunking_profile,
                embedding_dimensions=embedding_dimensions,
                pass_def=pass_def,
                artifacts=artifacts,
            )

            outcomes[pass_def.id] = 'completed'
            upstream[pass_def.id] = artifacts
            await _stage_attempt(
                worker, job_id, f'enrich.{pass_def.id}', 'completed',
                started_at=started_at,
                metadata={'artifact_count': indexed_count},
            )
        except Exception as e:  # noqa: BLE001
            await _stage_attempt(
                worker, job_id, f'enrich.{pass_def.id}', 'failed',
                started_at=started_at,
                error_code='ENRICHMENT_PASS_FAILED',
                error_message=str(e),
            )
            if pass_def.required:
                raise
            outcomes[pass_def.id] = 'failed'

    return outcomes


async def _index_artifacts(...): ...
async def _stage_attempt(...): ...
```

The two helpers are thin wrappers around `worker.post_json` to
`/internal/jobs/{id}/stage-attempt` and the existing
`/internal/providers/embed` + `/internal/chunks/batch` flow Phase 3
already shipped. Each artifact gets a deterministic, short chunk id:

```
chk_<version_id>_e<8-hex-hash>
```

where `<8-hex-hash> = sha256(version_id + ':' + pass_id + ':' + sequence)[:8]`.
Total length: 4 + 30 + 1 + 8 = **43 chars**, well under Vectorize V2's
64-byte ID limit (which we tripped over in Phase 3+4 with a
prematurely composite scheme — see Appendix C of that doc).

Properties:

- **Deterministic**: replay regenerates the same id from the same
  `(version_id, pass_id, sequence)` triple. Vectorize upserts and
  D1 INSERT-OR-REPLACE both stay idempotent.
- **Distinguishable**: the `e` letter after the second `_` flags
  enrichment artifacts vs the passage id form `chk_<version_id>_<ord:05d>`
  (no `e`). A glance is enough.
- **Short**: avoids the 64-byte cap.

The `pass_id` and the artifact sequence within the pass are recorded
in the chunk row's `enrichment_pass_id` column and `metadata.sequence`
field respectively, so the human-readable triple is still available
without bloating the id.

## 5.6.3 The `enrich` stage in the job runner

**File**: `apps/ingest/app/workers/job_runner.py` (extended)

```python
STAGES = ['fetch', 'normalize', 'chunk', 'embed', 'index', 'enrich']
```

The new `enrich` arm:

```python
elif stage == 'enrich':
    profile = get_profile_or_raise(config['corpus_profile'])
    if not profile.enrichment.enabled:
        await _record_attempt_complete(
            worker, job_id, 'enrich', attempt_number, started_at,
            metadata={'enrichment': 'disabled'},
        )
        continue

    # Request-side overrides come from the merged config_json the
    # dispatcher persisted (5.11.1). The runner needs both: the
    # default model the request set (if any) and the per-pass
    # overrides the request set (if any).
    request_enrichment = config.get('enrichment', {}) or {}
    request_default_model = _parse_model(request_enrichment.get('default_model'))
    request_pass_overrides = {
        p['id']: _parse_model(p['model'])
        for p in (request_enrichment.get('passes') or [])
        if p.get('model') is not None
    }
    outcomes = await run_enrichment(
        worker=worker,
        job_id=job_id,
        tenant_id=job['tenant_id'],
        namespace_id=ns['id'],
        document_id=job['document_id'],
        version_id=job['version_id'],
        version_index_id=job['version_index_id'],
        embedding_profile=embedding_profile,
        chunking_profile=chunking_profile,
        embedding_dimensions=embedding_dimensions,
        profile=profile,
        request_default_model=request_default_model,
        request_pass_overrides=request_pass_overrides,
        cdm=cdm_for_chunk,        # already loaded
        passages=chunks_list,
    )
    enrichment_status = _summarize_outcomes(outcomes)
    await _record_attempt_complete(
        worker, job_id, 'enrich', attempt_number, started_at,
        metadata={'outcomes': outcomes, 'summary': enrichment_status},
    )
```

`_summarize_outcomes`:
- `'none'` if no passes (enrichment.enabled=false).
- `'full'` if all passes are `'completed'`.
- `'partial'` if any are `'failed'` or `'skipped'` (but no required failed).
- `'failed'` is reached only via the raised-exception path, which the
  outer try/except in run_job converts to a fatal stage failure.

The Worker's `/internal/jobs/{id}/transition` handler is extended
(5.7.2) to persist the summary into `ingestion_jobs.enrichment_status`.

## 5.6.4 Tests

- `apps/ingest/tests/test_enrichment_runner.py`:
  - `_topo_sort` orders A → B → C correctly when C depends on B,
    B depends on A.
  - Cycle detection raises.
  - A failed `required=true` pass raises (caller would mark the job
    failed).
  - A failed `required=false` pass records the failure and continues
    to the next pass.
  - A pass whose dependency failed is `'skipped'` (not run, not
    counted as failed).
  - Resolved model: per-pass overrides profile default; profile
    default overrides request default; missing all three raises.

**Acceptance**
- `make test-ingest` green for the new tests.

---

# Step 5.7 — Per-profile enrichment passes

Each pass is a small, focused module. They do NOT touch the Worker
back-channel — the runner does. They produce text + metadata.

## 5.7.1 `narrative.section_summary`

**File**: `apps/ingest/app/enrichment/narrative/section_summary.py`

**Behavior**: For each section path at depth ≤ 2, concatenate the
passages, ask the LLM for a 2–4 sentence summary, return one
artifact with `artifact_type='narrative.section_summary'`,
`section_path` = the section's path, `metadata.section_path`
duplicated for filterability, `parent_chunk_id` left NULL (the
artifact synthesizes multiple passages — no single parent).

Cost guard: skip sections with fewer than 50 tokens of body text.

**Test**
- 3-section input (`/preface`, `/ch1`, `/ch2`); the pass produces 3
  artifacts; their `section_path` values match.
- Mocked LLM returning a known summary text per call: the artifact
  text matches.

## 5.7.2 `narrative.scene`

**Behavior**: Per section, split into "scenes" by detecting
scene breaks (`* * *` markers, blank-line clusters). One artifact per
detected scene with `artifact_type='narrative.scene'`. Depends on
`section_summary` only to ensure ordering — scene synthesis can use
the section summary as context for the LLM call.

`metadata.scene_id`, `metadata.scene_index_in_section`.

## 5.7.3 `narrative.character_dossier`

**Behavior**: Document-scope. Identify named characters across the
whole document. One artifact per character. `artifact_type='narrative.character_dossier'`,
`metadata.character_name`, `metadata.first_appearance_section_path`.

Per-pass model: `gpt-4o` (more reasoning needed for cross-document
identity resolution).

## 5.7.4 `narrative.theme`

**Behavior**: Document-scope. Up to 5 thematic statements. Depends on
`character_dossier` (themes often reference characters).

## 5.7.5 `legal.clause`

**File**: `apps/ingest/app/enrichment/legal/clause.py`

**Behavior**: Chunk-scope. For each passage, ask the LLM to extract
the clause's gist as a single sentence + a clause id (the existing
section_path serves). One artifact per passage that the LLM
classifies as containing a clause. `parent_chunk_id` set to the
source passage. `metadata.clause_topic`, `metadata.parties_referenced`.

## 5.7.6 `legal.obligation`

**Behavior**: Document-scope. Identify obligations across the
document, citing clauses. Depends on `clause_extraction`.
`metadata.obligation_type` (`payment`, `notice`, `delivery`, …),
`metadata.party`, `metadata.clauses_cited`.

## 5.7.7 `support.troubleshooting_step`

**Behavior**: Section-scope. Identify numbered or imperative
sentences as troubleshooting steps. One artifact per step.

## 5.7.8 `technical.endpoint_reference`

**Behavior**: Section-scope. Identify HTTP endpoint or function
references (`GET /api/v1/...`, `POST /v1/users`, `function foo(...)`)
within the section. One artifact per reference.

**Acceptance**
- `make test-ingest` green for one focused test per pass: it can
  produce N artifacts of the right `artifact_type` from a known
  fixture text, with mocked LLM calls.

---

# Step 5.8 — Code-aware and legal-clause-aware chunkers

The two new chunkers replace the generic chunker only when their
profile says so; the generic chunker still ships and is the default.

## 5.8.1 `code_aware`

**File**: `apps/ingest/app/chunkers/code_aware.py`

**Behavior**: Same sliding-window budget logic as the generic
chunker, but the boundary detector knows about Markdown fenced code
blocks (` ``` ` / ` ~~~ `) and refuses to split inside one. If a
fenced block is itself larger than `target_tokens`, the chunk
contains the whole block (overrides the budget for that one chunk
rather than truncating mid-language).

**Test**
- Input with a 1500-token fenced code block in a 700-target profile:
  the chunk containing the block is ~1500 tokens (oversize but
  intact). Chunks before/after respect the budget normally.

## 5.8.2 `legal_clause_aware`

**File**: `apps/ingest/app/chunkers/legal_clause_aware.py`

**Behavior**: Treats clause numbers (`1.`, `1.1`, `(a)`, etc.) as
hard boundaries. A clause shorter than `target_tokens` becomes its
own chunk. A clause longer than `target_tokens` falls through to the
generic sliding-window logic but never crosses into another
top-level clause.

**Test**
- Input with 5 numbered clauses (each ~150 tokens) in a 500-target
  profile: 5 chunks, one per clause.
- Input with 1 numbered clause of 1200 tokens: 2-3 chunks, all with
  the same `section_path` and a metadata flag on the chunker side
  (`metadata.continuation: true` for the second chunk onward, useful
  for retrieval-time stitching).

## 5.8.3 Chunker registry — fail-fast

The container's chunker dispatch already lives in
`apps/ingest/app/stages/chunk.py`. Extend it:

```python
_CHUNKERS = {
    'generic': chunkers.generic.chunk_document,
    'code_aware': chunkers.code_aware.chunk_document,
    'legal_clause_aware': chunkers.legal_clause_aware.chunk_document,
}

def select_chunker(profile_name: str):
    if profile_name not in _CHUNKERS:
        raise RuntimeError(
            f'Unknown chunking profile: {profile_name!r}. '
            f'Valid: {sorted(_CHUNKERS)}'
        )
    return _CHUNKERS[profile_name]
```

**Fail-fast, no fallback.** Both layers enforce this:

- The profile YAML schema (5.1.2) constrains `chunking.profile` to
  `ChunkerId` — a typo like `legal_clause_awre` fails Zod validation
  at Worker boot.
- The Pydantic mirror does the same on the Container side.
- The Container's runtime `select_chunker` raises if it ever sees
  an unknown name (defense in depth — should be unreachable).

Silent fallback to `generic` would let a typo produce
generic-chunked legal documents and degrade legal retrieval without
an obvious failure. Profiles are code-owned YAML; boot-time failure
is correct.

**Acceptance**
- `make test-ingest` green for both new chunkers.

---

# Step 5.9 — Reranker integration (Worker)

**Goal:** The retrieval pipeline calls Voyage rerank when the merged
profile says so, falls back to fused top-K on provider failure, and
emits an audit field that distinguishes "not requested" from
"requested but fell back."

## 5.9.1 The rerank invocation

**File**: `apps/api/src/retrieval/rerank.ts`

```ts
export interface RerankInput {
  query: string;
  documents: Array<{ chunk_id: string; text: string }>;
  top_n: number;
  config: {
    provider: 'voyage' | 'cohere';
    model: string;
    provider_key_ref?: string;
    provider_key_id?: string;
  };
  tenant_id: string;
  query_event_id: string;
}

export interface RerankResult {
  /** chunk_ids in the new order, top first. Length ≤ top_n. */
  reordered: string[];
  meta: {
    executed: true;
    provider: 'voyage' | 'cohere';
    model: string;
    top_n: number;
    latency_ms: number;
  };
}

export interface RerankFallback {
  meta: {
    executed: false;
    provider: 'voyage' | 'cohere';
    model: string;
    top_n: number;
    latency_ms: number;
    fallback_reason: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_QUOTA_EXHAUSTED' | 'PROVIDER_TIMEOUT' | 'PROVIDER_KEY_NOT_FOUND' | 'EMPTY_INPUT';
  };
}

export async function maybeRerank(env: Env, input: RerankInput): Promise<RerankResult | RerankFallback> {
  const start = Date.now();
  if (input.documents.length === 0) {
    return { meta: { executed: false, provider: input.config.provider, model: input.config.model, top_n: input.config.top_n ?? 0, latency_ms: 0, fallback_reason: 'EMPTY_INPUT' } };
  }
  const key = await resolveProviderKeyForQuery(env, input.tenant_id, input.config.provider, input.config.provider_key_id, input.config.provider_key_ref);
  if (!key) {
    return { meta: { executed: false, /* ... */ fallback_reason: 'PROVIDER_KEY_NOT_FOUND', latency_ms: Date.now() - start } };
  }
  const provider = resolveProvider(env, { provider: input.config.provider, api_key: key.raw_key, request_metadata: { tenant_id: input.tenant_id, query_event_id: input.query_event_id, provider_key_id: key.id } });
  if (!provider.rerank) {
    return { meta: { executed: false, /* ... */ fallback_reason: 'PROVIDER_UNAVAILABLE' } };
  }
  const result = await provider.rerank.rerank({
    model: input.config.model,
    query: input.query,
    documents: input.documents.map((d) => d.text),
    top_n: input.top_n,
  }, provider.options);

  if (result.outcome !== 'success' && result.outcome !== 'degraded_success') {
    const reason = mapErrorToReason(result.error);  // maps 5xx → PROVIDER_UNAVAILABLE, etc.
    return { meta: { executed: false, /* ... */ fallback_reason: reason } };
  }
  // The provider returns indices into the documents array; map back to chunk_ids.
  const reordered = result.value.results.slice(0, input.top_n).map((r) => input.documents[r.index]!.chunk_id);
  return {
    reordered,
    meta: { executed: true, provider: input.config.provider, model: input.config.model, top_n: input.top_n, latency_ms: Date.now() - start },
  };
}
```

## 5.9.2 Wiring into the query path

**File**: `apps/api/src/routes/query.ts` (extended)

Insert between hybrid retrieval and context assembly:

```ts
const fusedTopK = retrieval.candidates.slice(0, /* something like 30 */);
const rerankCfg = mergedProfile.retrieval_defaults.rerank;
let candidatesForContext = fusedTopK;
let rerankAudit: RerankAudit;

if (rerankCfg.enabled) {
  const docs = await hydrateRerankInputs(env, fusedTopK.map(c => c.chunk_id));
  const r = await maybeRerank(env, {
    query: body.query,
    documents: docs,
    top_n: rerankCfg.top_n,
    config: { provider: rerankCfg.provider!, model: rerankCfg.model!, ...keyRef },
    tenant_id: tenantId,
    query_event_id: qevId,
  });
  if ('reordered' in r) {
    const order = new Map(r.reordered.map((id, i) => [id, i]));
    candidatesForContext = fusedTopK
      .filter(c => order.has(c.chunk_id))
      .sort((a, b) => order.get(a.chunk_id)! - order.get(b.chunk_id)!);
  }
  rerankAudit = {
    enabled: true,
    executed: r.meta.executed,
    provider: r.meta.provider,
    model: r.meta.model,
    top_n: r.meta.top_n,
    latency_ms: r.meta.latency_ms,
    ...(r.meta.executed === false ? { fallback_reason: r.meta.fallback_reason } : {}),
  };
} else {
  rerankAudit = { enabled: false, executed: false };
}
```

The audit shape extension is fully backwards compatible: Phase 4
emitted `{enabled:false, provider:null, model:null, top_n:null}`;
Phase 5 emits the same shape when disabled, plus the new
`executed`+ optional `fallback_reason`.

## 5.9.3 Audit contract update

**File**: `packages/contracts/src/query.ts`

Replace `RerankerAudit` with:

```ts
export const RerankerFallbackReason = z.enum([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_QUOTA_EXHAUSTED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_KEY_NOT_FOUND',
  'EMPTY_INPUT',
]);
export type RerankerFallbackReason = z.infer<typeof RerankerFallbackReason>;

/** Reasons that suggest operator action (vs transient blips). The
 *  audit emits `actionable: true` for these so dashboards can surface
 *  them distinctly without parsing the reason string. */
export const ACTIONABLE_FALLBACK_REASONS: ReadonlySet<RerankerFallbackReason> = new Set([
  'PROVIDER_QUOTA_EXHAUSTED',
  'PROVIDER_KEY_NOT_FOUND',
]);

export const RerankerAudit = z.object({
  enabled: z.boolean(),
  executed: z.boolean(),
  provider: z.enum(['voyage', 'cohere']).nullable().optional(),
  model: z.string().nullable().optional(),
  top_n: z.number().int().nullable().optional(),
  latency_ms: z.number().int().nullable().optional(),
  fallback_reason: RerankerFallbackReason.nullable().optional(),
  /** True when the fallback reason represents a state an operator
   *  should act on (out of quota, missing key) vs a transient blip
   *  (timeout, 5xx). Always present when `executed: false`. */
  actionable: z.boolean().nullable().optional(),
});
```

`enabled: false, executed: false` is the Phase 4 shape. SDK
consumers that ignore the new fields keep working; consumers that
inspect them learn whether the rerank ran.

## 5.9.4 Tests

- `apps/api/test/rerank.test.ts`:
  - Stub Voyage success → `executed: true`, candidates reordered.
  - Stub Voyage 503 → `executed: false`, fallback to RRF top-K, audit
    has `fallback_reason: 'PROVIDER_UNAVAILABLE'`.
  - Stub Voyage 429 → `fallback_reason: 'PROVIDER_QUOTA_EXHAUSTED'`.
  - Provider key not registered → `fallback_reason: 'PROVIDER_KEY_NOT_FOUND'`.
  - Empty candidates → `fallback_reason: 'EMPTY_INPUT'`, no provider call.
- `apps/api/test/rerank-fallback.test.ts` (integration):
  - End-to-end query with rerank fail; the response is still 200,
    citations still valid, `audit.reranker.executed === false`,
    `degradation_level === 'full'` (rerank fallback is not a
    degradation; it's a precision tradeoff).

**Acceptance**
- All tests green.
- Existing `query-route.test.ts` stays green (Phase 4 fixtures use
  the generic profile → rerank disabled → behavior unchanged).

---

# Step 5.10 — Per-layer context budget

**Goal:** Context assembly honors the merged profile's
`retrieval_defaults.layer_budgets` and `layer_order`.

**File**: `apps/api/src/retrieval/context-assembly.ts` (extended)

## 5.10.1 New API

```ts
export interface AssembleArgs {
  env: Env;
  candidates: FusedHit[];                 // post-rerank order; .chunk_id authoritative
  max_context_tokens: number;
  /** Per-layer fractional budgets. Keys are artifact_type values. */
  layer_budgets: Record<string, number>;
  /** Order in which layers are emitted in the formatted context. */
  layer_order: string[];
}
```

## 5.10.2 Algorithm

1. **Hydrate** all candidate chunks via the existing
   `WHERE id IN (...)` query (Phase 4 §4.4) — re-sort by the
   candidate order (preserved from rerank or RRF).

2. **Normalize** `layer_budgets` to fractions summing to 1.0. (If a
   profile YAML's fractions sum to e.g. 0.95, scale every entry by
   `1.0 / 0.95` so they sum to exactly 1.0.)

3. **Bucket** hydrated chunks by `artifact_type`. Within each bucket,
   the order is the candidate order (i.e. the rerank/RRF rank).

4. **Compute per-layer caps** in tokens:
   `cap_layer = floor(max_context_tokens * fraction_layer)`.

5. **Greedy include** per layer in `layer_order`, top of bucket
   first. For each chunk:
   - **If the running layer total + chunk tokens ≤ cap**, include.
   - **If the chunk by itself exceeds the cap** (rare, but possible
     for a single oversized summary or dossier), include it iff the
     layer is otherwise empty AND there's enough remaining
     `max_context_tokens` budget overall. Counted as "oversize-admit"
     in the audit. Otherwise skip the chunk.
   - **Otherwise** stop the layer.

6. **Spill carryover**. If a layer's bucket was exhausted before
   filling its cap, the unused tokens are added to the *next* layer's
   cap (in `layer_order`). This is why we walk in declared order —
   spill is sequential, not redistributed.

7. **Last-layer underfill is not wrapped.** If the final layer's
   bucket is exhausted with budget left over, the leftover is unused.
   The total context will be smaller than `max_context_tokens` —
   that's acceptable; padding with off-topic chunks would be worse.

8. **Emit** in `layer_order`, with the existing `[N]` numbering
   incrementing across layers.

The "oversize-admit" rule (step 5) is Option A from the feedback:
admit a single oversized chunk only when its layer would otherwise
be empty. This guarantees every requested layer surfaces *something*
when retrieval found a candidate for it; the alternative (Option B,
strict cap) would let a profile silently produce zero of an artifact
type just because the only candidate happened to be 1.05× the cap.

## 5.10.3 Why not weighted-round-robin?

Round-robin sounds fair but it interleaves layers in the formatted
context in a way that confuses the synthesizer. Layer-by-layer
emission with explicit ordering keeps the prompt readable and the
citation numbering stable.

## 5.10.4 Tests

- `apps/api/test/context-assembly-budget.test.ts`:
  - **Even allocation**: 6000-token budget, profile with `passage:
    0.5, section_summary: 0.3, character_dossier: 0.2`,
    `layer_order: [passage, section_summary, character_dossier]`. 5
    candidates per layer at 600 tokens each. Result: 5 passages
    (3000 tokens), 3 summaries (1800), 2 dossiers (1200). All caps
    respected; total exactly 6000.
  - **Empty bucket spill**: same setup, but the `character_dossier`
    bucket has 0 candidates. The 1200-token cap spills to the
    next-declared layer — but `character_dossier` is the LAST layer,
    so it's lost (last-layer underfill is unused).
  - **Empty mid-layer spill**: re-order profile to
    `[passage, character_dossier, section_summary]`. Empty
    `character_dossier` bucket. The 1200 spills to `section_summary`.
    Result: 5 passages (3000) + 0 dossiers + 5 summaries (3000) =
    6000 tokens, with `section_summary`'s effective cap = 1800 + 1200
    = 3000.
  - **Oversize-admit (Option A)**: `character_dossier` cap is 1200,
    but the only retrieved dossier is 1500 tokens. The layer is
    otherwise empty → admit the chunk. Audit field
    `audit.context.oversize_admits = 1`. The 1500 tokens come out
    of the overall `max_context_tokens` budget; subsequent layers
    see a slightly tighter remaining pool.
  - **Oversize-skip**: `character_dossier` cap is 1200, the only
    dossier is 1500 tokens, but the running total + 1500 would
    exceed `max_context_tokens` (other layers already filled the
    pool). Skip the chunk; audit `oversize_skips = 1`.

**Acceptance**
- All tests green.
- The Phase 4 acceptance test continues to pass (`generic` profile
  has `layer_budgets: { passage: 1.0 }`, single-layer behavior is
  unchanged).

---

# Step 5.11 — Plumbing in dispatch + transition + audit

These are the small Worker-side wires that connect everything.

## 5.11.1 Dispatch persists the merged profile

**File**: `apps/api/src/ingestion/dispatch.ts` (extended)

Before INSERTing the `ingestion_jobs` row, resolve the corpus profile
+ merge with the request body, persist the merged shape into
`config_json`. The Container reads `config_json` on entry and gets a
fully-resolved view of what to do.

```ts
const ns = await getNamespaceBySlug(env.DB, tenant_id, namespace_slug);
const profile = getProfileOrThrow(ns.corpus_profile);
const merged = mergeProfile(profile, requestOverrides);
// ...
await env.DB.prepare(`INSERT INTO ingestion_jobs (..., config_json, ...) VALUES (..., ?, ...)`)
  .bind(..., JSON.stringify({ ...merged, /* embedding/inference resolved */ }), ...)
  .run();
```

Replay-safety: any future replay of this job uses the persisted
merged config, not whatever the profile YAML says today. Profile
edits don't retroactively change in-flight or finalized jobs.

## 5.11.2 Transition handler persists `enrichment_status`

**File**: `apps/api/src/routes/internal/ingest-write.ts` (extended)

The `/internal/jobs/{id}/transition` handler accepts an optional
`enrichment_status` field. The transition rules:

| Outcome | `ingestion_jobs.status` | `ingestion_jobs.enrichment_status` | `version_indexes.status` |
|---|---|---|---|
| All passes succeeded, no missing embeddings | `completed` | `full` | `ready` |
| All required passes succeeded, some optional failed/skipped | `completed` | `partial` | `partial` |
| Some chunks have `embedding_status='missing'` (Phase 3 partial) | `completed` | as above | `partial` |
| Any **required** pass failed | **`failed`** | `failed` | **`failed`** (NOT `partial`) |
| No enrichment configured | `completed` | `none` | `ready` (or `partial` if missing embeddings) |

The "required failed → version_indexes.status='failed'" rule
matters: a downstream query against a failed `version_index` should
treat it as not queryable, not as half-built. Half-built half-works
is the worst possible state for retrieval correctness.

```sql
UPDATE ingestion_jobs
   SET status = ?,
       enrichment_status = ?
 WHERE id = ?;

UPDATE version_indexes SET status = ? WHERE id = ?;
```

`enrichment_status` is computed from the
`ingest_stage_attempts WHERE stage LIKE 'enrich.%'` rows + the
profile's required-pass list:

```ts
function computeEnrichmentStatus(
  attempts: StageAttemptRow[],
  requiredPassIds: Set<string>,
  hasMissingEmbeddings: boolean,
): { jobStatus: 'completed' | 'failed';
     enrichmentStatus: 'none' | 'full' | 'partial' | 'failed';
     versionIndexStatus: 'ready' | 'partial' | 'failed' } {
  const enrichAttempts = attempts.filter(a => a.stage.startsWith('enrich.'));
  if (enrichAttempts.length === 0) {
    return {
      jobStatus: 'completed',
      enrichmentStatus: 'none',
      versionIndexStatus: hasMissingEmbeddings ? 'partial' : 'ready',
    };
  }
  const failedRequired = enrichAttempts
    .filter(a => a.status === 'failed')
    .some(a => requiredPassIds.has(a.stage.slice('enrich.'.length)));
  if (failedRequired) {
    return { jobStatus: 'failed', enrichmentStatus: 'failed', versionIndexStatus: 'failed' };
  }
  const anyOptionalImperfect = enrichAttempts.some(
    a => a.status === 'failed' || a.status === 'skipped',
  );
  if (anyOptionalImperfect || hasMissingEmbeddings) {
    return { jobStatus: 'completed', enrichmentStatus: 'partial', versionIndexStatus: 'partial' };
  }
  return { jobStatus: 'completed', enrichmentStatus: 'full', versionIndexStatus: 'ready' };
}
```

Note: the runner already raises on a required-pass failure (5.6.2),
which converts to a fatal stage failure in `run_job` (5.6.3). The
Container then transitions the job to `failed`. The transition
handler's required-failed branch above is what the failed transition
hits.

## 5.11.3 Query reads the profile up front

**File**: `apps/api/src/routes/query.ts` (extended)

Step 0 of the handler: resolve the profile.

```ts
const merged = await resolveCorpusProfile({
  env, tenant_id: tenantId, namespace_slug: body.namespace,
  request_overrides: extractProfileOverrides(body),
});
```

`extractProfileOverrides` pulls `retrieval`, `prompt`, and
`context.layer_budgets` from the request body and reshapes them into
a `Partial<CorpusProfile>`.

The rest of the handler reads from `merged` instead of the request
body directly — except for fields the profile doesn't speak to
(`embedding`, `inference`, `output`, `query`, `document_ids`, etc.).

## 5.11.4 Tests

- `apps/api/test/profile-resolver.test.ts`: profile + override merge.
- `apps/api/test/dispatch-merged-config.test.ts`: ingestion job's
  `config_json` contains the merged profile.
- `apps/api/test/query-profile-defaults.test.ts`:
  - Namespace with `corpus_profile='narrative'` but request without
    `retrieval.artifact_types` → retrieval queries
    `[passage, narrative.section_summary, narrative.scene,
    narrative.character_dossier]`.
  - Same namespace, request explicitly setting
    `retrieval.artifact_types: [passage]` → retrieval queries only
    passages.

**Acceptance**
- All tests green.

---

# Step 5.12 — Mandatory close items

Run these before declaring Phase 5 done.

1. **Migration applied to dev D1.**
   `make migrate-dev` → 0003 reflected in `wrangler d1 execute`.
2. **Build and deploy.**
   `make build-ingest && make deploy-dev` succeed; the Container
   image now contains `/app/profiles/*.yaml`.
3. **Test sweep.**
   - `pnpm -r typecheck` clean (corpus-profiles + api + contracts).
   - `pnpm -r lint` clean.
   - `pnpm -r test` green; new packages produce green test runs.
   - `make test-ingest` green; pytest count visibly higher.
4. **Live e2e covers TWO non-generic profiles** (narrative + legal).
   Extend `apps/api/scripts/test-live.ts`:
   - Seed THREE namespaces:
     - `default` (`corpus_profile='generic'`) — already exists.
     - `narrative` (`corpus_profile='narrative'`).
     - `legal` (`corpus_profile='legal'`).
   - **Narrative scenario.** Ingest a tiny narrative fixture
     (`apps/api/test/fixtures/narrative-tiny.md`, ~2 KB, 3 sections,
     2 named characters). Assert:
     - Job finishes with `enrichment_status` ∈ {`full`, `partial`}.
     - D1 contains chunks with `artifact_type='narrative.section_summary'`
       and `artifact_type='narrative.character_dossier'` for this
       version_id.
     - A query "who are the characters in this story?" returns a
       response with `audit.reranker.enabled === true`,
       `audit.reranker.executed ∈ {true, false}`, and at least one
       citation whose chunk has `artifact_type` starting with
       `narrative.`.
   - **Legal scenario.** Ingest a tiny legal fixture
     (`apps/api/test/fixtures/lease-tiny.md`, ~3 KB, 5 numbered
     clauses). Assert:
     - Chunks of `artifact_type='legal.clause'` exist for this
       version_id (or `legal.clause_extraction` recorded as
       `optional failure` if the LLM call genuinely failed).
     - A query "what is the rent due date?" produces an answer that
       cites at least one `legal.clause` chunk.
     - Default `retrieval.artifact_types` from the legal profile is
       `[passage, legal.clause, legal.obligation]` (not `[passage]`).
5. **Reranker fallback exercised.**
   Either temporarily rotate the Voyage key to invalid and re-run
   the live test (expect `executed: false, fallback_reason:
   'PROVIDER_UNAVAILABLE'`), or write a deliberate fault-injection
   test in vitest. The key is to *prove* the fallback path runs in
   production code, not just in unit tests.
6. **Profile parity test green in both runtimes.**
   `pnpm --filter @textral/corpus-profiles test parity` green AND
   `cd apps/ingest && python -m pytest tests/test_profile_parity.py`
   green AND the canonical JSON they compare against is identical.
7. **Audit shape regression check.**
   `audit.reranker` is the new tagged shape; existing Phase 4
   integration tests that asserted `enabled: false, provider: null`
   etc. continue to pass. If any test asserts the absence of
   `executed`, update it to assert `executed: false` instead — the
   field is now mandatory.
8. **README + Makefile.**
   - `README.md` quickstart mentions `profiles/` and the build copy.
   - `Makefile` `build-ingest` target copies the profiles before
     running wrangler containers build.
   - `apps/ingest/.gitignore` lists `profiles/`.
9. **Doc updates.**
   - `1-DESIGN.md` §9 (Corpus Profiles) — note that the `legal`
     example YAML in the design doc is illustrative; the canonical
     YAMLs ship in `packages/corpus-profiles/profiles/`.
   - `2-PHASES.md` — checkboxes against Phase 5 sub-steps as they
     land.
   - `SECRETS.md` — add `VOYAGE_API_KEY` (BYOK) to the external
     section if not already there.

When every item above is checked, Phase 5 is shippable.

---

# Appendix A — Updated file map

```
packages/corpus-profiles/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── loader.ts
│   ├── schema.ts
│   └── merge.ts
├── profiles/
│   ├── generic.yaml
│   ├── narrative.yaml
│   ├── legal.yaml
│   ├── support.yaml
│   └── technical.yaml
└── test/
    ├── load.test.ts
    ├── merge.test.ts
    └── parity.test.ts

apps/api/migrations/
├── 0001_baseline.sql
├── 0002_documents_jobs_chunks.sql
└── 0003_phase5_enrichment.sql              ← NEW

apps/api/src/
├── retrieval/
│   ├── rerank.ts                           ← NEW (5.9)
│   ├── profile-resolver.ts                 ← NEW (5.4)
│   ├── context-assembly.ts                 ← EXTENDED (5.10)
│   └── (existing files unchanged)
├── routes/
│   ├── query.ts                            ← EXTENDED (5.11.3)
│   ├── documents.ts                        ← EXTENDED (5.11.1)
│   └── internal/ingest-write.ts            ← EXTENDED (5.11.2)
├── ingestion/
│   └── dispatch.ts                         ← EXTENDED (5.11.1)
└── (existing structure preserved)

apps/api/test/
├── profile-resolver.test.ts                ← NEW
├── rerank.test.ts                          ← NEW
├── rerank-fallback.test.ts                 ← NEW
├── context-assembly-budget.test.ts         ← NEW
├── dispatch-merged-config.test.ts          ← NEW
├── query-profile-defaults.test.ts          ← NEW
└── (existing tests preserved)

apps/ingest/Dockerfile                      ← EXTENDED (5.5.1)
apps/ingest/profiles/                       ← BUILD-TIME COPY (gitignored)

apps/ingest/app/
├── corpus_profiles/
│   ├── __init__.py
│   ├── loader.py
│   ├── schema.py
│   └── merge.py
├── enrichment/
│   ├── __init__.py
│   ├── runner.py
│   ├── types.py
│   ├── narrative/
│   │   ├── __init__.py
│   │   ├── section_summary.py
│   │   ├── scene.py
│   │   ├── character_dossier.py
│   │   └── theme.py
│   ├── legal/
│   │   ├── __init__.py
│   │   ├── clause.py
│   │   └── obligation.py
│   ├── support/
│   │   ├── __init__.py
│   │   └── troubleshooting_step.py
│   └── technical/
│       ├── __init__.py
│       └── endpoint_reference.py
├── chunkers/
│   ├── (existing) generic.py
│   ├── code_aware.py                       ← NEW
│   └── legal_clause_aware.py               ← NEW
├── stages/
│   └── enrich.py                           ← NEW
└── workers/job_runner.py                   ← EXTENDED (5.6.3)

apps/ingest/tests/
├── test_profile_loader.py                  ← NEW
├── test_profile_parity.py                  ← NEW
├── test_enrichment_runner.py               ← NEW
├── test_enrichment_section_summary.py      ← NEW
├── test_enrichment_clause.py               ← NEW
├── test_chunker_code_aware.py              ← NEW
├── test_chunker_legal_clause.py            ← NEW
└── (existing tests preserved)

packages/contracts/src/
└── query.ts                                ← EXTENDED — RerankerAudit shape (5.9.3)
```

---

# Appendix B — One-line answers to questions a dev might still have

| Q | A |
|---|---|
| Why YAML in a workspace package and not a D1 table? | The registry rarely changes and version-controls cleanly. A D1 table would force a migration for every profile edit and split the source of truth between code and data. The price is having to redeploy to add a profile — acceptable for MVP. |
| Why ship the profiles into the Container image instead of fetching from the Worker? | Determinism. The Container's behavior at run-time is fixed by the image it boots with. Runtime fetch introduces a window where the Worker has been redeployed with new YAMLs but the Container hasn't, and that window has nasty silent-misalignment failure modes. |
| Why a parity test instead of a single canonical JSON? | The TS world wants Zod + types; the Python world wants Pydantic + types. Generating either from the other introduces tooling debt. The parity test is cheap and catches the real bug class (schema drift) without a code-gen pipeline. |
| Why `parent_chunk_id` as a column rather than a side table? | Lineage is intrinsic to the chunk row; querying for "all artifacts derived from this passage" should not require a join. SQLite is fine with a self-referencing FK. |
| Why is the rerank fallback never a query failure? | Reranking is a precision lever, not a correctness lever. RRF top-K already produces a valid candidate set; rerank narrows it. If the reranker is unavailable, returning RRF top-K is honest and useful. The audit field tells the consumer what happened. |
| Why does enrichment run AFTER index, not interleaved? | Enrichment artifacts have to be embeddable + indexable. If enrichment is interleaved with the chunk → embed → index loop and a pass produces 0 artifacts because of a transient LLM hiccup, partial state is harder to reason about. Running it as a final stage with its own per-pass attempts gives clean replay. |
| Why does each enrichment pass produce text only and not also embeddings? | Single embed pipeline. The runner already has the `/internal/providers/embed` plumbing for passages; reusing it eliminates a second code path that could drift. The provider key resolution, AI Gateway routing, retry classification, and audit logging all stay in one place. |
| Why per-pass `model:` overrides? | Some passes (character_dossier) need stronger reasoning; others (troubleshooting_step) are pattern-extraction and run fine on a smaller model. The cost difference is non-trivial. |
| Why doesn't the profile know about embedding/inference providers? | Those are tenant- and request-level concerns (BYOK). The profile is corpus-shaped behavior; provider choice is operationally orthogonal. The request body brings the BYOK key; the profile brings the workflow. |
| Why does `legal` rank `legal.clause` before `passage` in `layer_order`? | The clause artifact is a higher-signal answer for legal queries — it's the structured extraction. Passages are the supporting evidence. Putting clauses first encourages the synthesizer to lead with them. |
| Why is `audit.reranker.enabled` separate from `audit.reranker.executed`? | A consumer needs to distinguish: "I asked for reranking and got it" vs "I asked for reranking but the provider failed and I got RRF top-K" vs "I didn't ask for reranking". Three states, two booleans. |
| What about backfilling enrichment for already-ingested documents? | Out of scope. Re-ingestion (POST /v1/documents/{id}/ingest with the same `version_id` and `mode='enrichment_only'`) is the supported path. Phase 6 adds an admin endpoint for bulk enrichment-only runs. |
| Why don't enrichment artifacts have their own embedding profile? | Operational simplicity: all artifacts in a namespace go to the same Vectorize index, so one query vector covers all artifact types. Splitting them out would require multi-index queries and more complex compatibility gating. Phase 7 revisits if eval shows it's worth it. |
| Why does `mergeProfile` replace arrays wholesale rather than concatenate? | Concat is too magical: a request can't *remove* a profile's pass without inventing a "passes_to_remove" sub-DSL. Replace-wholesale lets the request author own the array if they want to override it; otherwise the profile's array is used as-is. |
| Why is the `corpus_profiles` table from the design doc skipped? | It would duplicate the YAML registry and force a migration step for every profile edit. The YAMLs in `packages/corpus-profiles/profiles/` are the registry. `namespaces.corpus_profile` is a string FK by convention; validation happens at namespace-create time. |

---

End of Phase 5 implementation guide. Phase 6 (failure surface +
observability + streaming) picks up immediately after.
