# Query Cookbook — expansion plan

> The Query section in the rendered docs only shows a single body
> shape today. A reader can't tell from the docs how to: get
> structured JSON output, stream tokens, narrow to a subset of
> documents, override the system prompt, tune the context budget, or
> recover from a `cannot_answer` degradation. This doc plans the
> expansion + how each example is validated.

## What's missing today

- **Structured output** is documented as a knob but has no body shape
  or response example. A reader cannot tell that schemas with a
  `citations` field round-trip differently from text mode.
- **Streaming** is mentioned but no end-to-end SSE consumer pattern.
- **`document_ids` filter** is in the schema but not in any sample.
- **`prompt.system` / `prompt.developer`** override behavior isn't
  shown anywhere — a reader doesn't know the platform appends a
  mandatory citation suffix to whatever they pass.
- **`context.max_context_tokens`** + the budget vs model context
  trade-off isn't discussed.
- **`retrieval.artifact_types`** for narrative/legal corpora is
  mentioned in the corpus-profile docs but not as a query-knob
  example.
- **Reranker on / off** has no side-by-side example.
- **Failure-recovery** — `degradation_level=cannot_answer`,
  `audit.synthesis_status=failed`, `audit.reranker.executed=false` —
  has no consumer-side handler example.

## Audience + outcome

A reader landing on the Query tag should be able to copy any of the
cookbook patterns, replace `{{TENANT_API_KEY}}` and `{{WORKER_URL}}`,
and have it work on first try. Each pattern earns its place by
demonstrating a knob the previous patterns didn't show.

## Cookbook patterns (8)

| # | Pattern | Demonstrates |
|---|---------|--------------|
| 1 | **Basic Q&A** | minimal RAG body, hybrid retrieval, citation array, audit shape |
| 2 | **Structured output (simple)** | `output.mode='structured'` + a one-level schema; how the response `answer.object` differs from text mode |
| 3 | **Structured output (nested + citations)** | a schema declaring an array property and a `citations: [{chunk_id, quote}]` field; how the platform filters citations to chunks actually retrieved |
| 4 | **Streaming (SSE consumer pattern)** | `?stream=sse`; the `token` / `done` event types; how to parse SSE frames in TypeScript and Python |
| 5 | **Reranker enabled** | `retrieval.rerank` not currently a request-body knob (it's profile-driven), so this pattern shows how to pick the namespace whose profile turns rerank on, and how `audit.reranker.executed` reads back |
| 6 | **Document subset** | `document_ids: [...]` to scope retrieval to specific documents; useful when a tenant has many docs in one namespace |
| 7 | **Custom system prompt** | `prompt.system` overriding the corpus-profile default; the platform's mandatory citation suffix still applies |
| 8 | **Cannot-answer handling** | what the response looks like when retrieval finds nothing or the synthesizer fails; how a consumer should branch on `degradation_level` |

## Doc surface — where each piece lives

- **Query tag description** (in `tag-descriptions.ts`): expand from
  ~250 words to ~600 with the pattern matrix table + one paragraph
  per pattern + a 3-paragraph deep-dive on structured output (because
  it's the most often-requested feature with the steepest learning
  curve).
- **`POST /v1/query` operation `description`**: extend the existing
  block with explicit pointers to each pattern.
- **`POST /v1/query` `x-codeSamples`**: add 6 new samples (the 8
  patterns minus #5 + #6 which are pure body variations covered in
  the description). Each sample is curl + TypeScript + Python.
- **`POST /v1/query` `examples`** on the request body: 4 named
  examples (basic / structured-simple / structured-nested /
  streaming) so Scalar's request-body picker shows them as a
  dropdown.

## Validation harness

Each pattern is validated end-to-end against deployed dev before
shipping. Provision script:

```text
1. Bootstrap a test tenant via /v1/admin/bootstrap (read token from
   apps/api/.secrets.dev.env).
2. Register an OpenAI BYOK with label "default" using the key in
   DO_NOT_COMMIT.md.
3. Create namespace "cookbook" with corpus_profile=narrative
   (so reranker patterns work too).
4. Upload + finalize + ingest apps/api/test/fixtures/narrative-tiny.md.
5. Wait 25s for Vectorize propagation.
6. Run each pattern against /v1/query; capture the response.
7. Diff each response against expectations:
   - 200 status
   - degradation_level matches expectation per pattern
   - structured patterns: object shape conforms to schema
   - streaming pattern: token frames + done frame
   - cannot-answer pattern: degradation_level='cannot_answer'
8. Tear down the test tenant (skip — leave for repeat use).
```

The validator script lives at
`apps/api/scripts/validate-cookbook.ts`. Each pattern is a self-
contained block with a name + body + assertions; the script exits
non-zero if any pattern fails.

## Acceptance

- Validator script runs green against deployed dev.
- Reader can land on the Query tag and answer:
  - "How do I get JSON output?" → see pattern #2/#3 in the cookbook.
  - "How do I stream?" → see pattern #4.
  - "What about narrowing to specific docs?" → see pattern #6.
  - "What if it fails?" → see pattern #8.
- New `x-codeSamples` are validated by the docs-regression test
  (already pins flagship operations).

## Out of scope

- A separate `/docs/cookbook` page (Scalar OSS doesn't support
  multi-page; the tag description is the canonical place).
- Server-side pre-filtering by metadata fields beyond `document_ids`
  (not exposed in the request shape today).
- Custom embedding-pre-processing knobs.

---

## Appendix — actual structured-output mechanics (from reading the code)

For `output.mode='structured'` with a JSON schema:

1. The platform forwards the schema as
   `response_format: {type: 'json_schema', schema: <yours>, strict: true}`
   to the upstream model. (Currently only OpenAI / Anthropic-compat
   support strict structured output reliably.)
2. The upstream model returns a JSON document conforming to the
   schema (or fails — `degradation_level='partial'`,
   `synthesis_status='failed'`, the raw output preserved in
   `answer.raw`).
3. The platform validates the response against the schema using
   `@cfworker/json-schema` (2020-12 draft).
4. **If the schema includes a `citations` array** at the top level,
   the platform reads it, filters entries whose `chunk_id` doesn't
   match the retrieved set, and:
   - Replaces the structured object's `citations` field with the
     filtered list.
   - Resolves each filtered chunk_id back into the response shape's
     top-level `citations` array (`{n, chunk_id, section_path,
     quote?}`).
5. **If the schema omits `citations`**, the structured object passes
   through unchanged but the top-level `citations` array is empty.
   (`audit.citation_integrity='missing'`, `degradation_level` may
   become `no_citations`.)

Recommended pattern: include `citations` in the schema *unless* you
explicitly don't want citations (e.g., extracting data where
provenance is downstream).

The `citation_quality` judge in the eval contract rewards present
+ precise citations — so production schemas should almost always
include the `citations` field.
