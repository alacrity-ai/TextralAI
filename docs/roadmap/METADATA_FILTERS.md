# Metadata-Filtered Retrieval

Today retrieval against a namespace is unfiltered: the query searches every chunk. Real corpora have structure — policies tagged by year, code by repo, tickets by team — and customers expect to scope queries.

`/query { filter: { tag: "policy", year: 2024 } }` is table-stakes for enterprise corpora.

## Why

- **Multi-tenant within a tenant.** Customers want one namespace per "domain" with metadata-scoped views (`product=A` vs `product=B`).
- **Time-bounded queries.** "Latest policies" needs `year >= 2024` filtering; today you'd need separate namespaces per year.
- **Permission scoping.** "Only return chunks the requesting user can see" requires metadata filters at retrieval time.
- **Faceted UX.** Sandbox / embed widget can't expose tag/category filters without this.

## Scope

In:
- Arbitrary key-value metadata at chunk ingest time (extends today's `section_path`-only model).
- Filter parameter on `/query`: AND/OR/equality/range support, validated by Zod.
- Filter applied to **both** dense and sparse arms (consistency invariant — see Open Questions).
- Audit reflects the applied filter.
- MCP `query` tool exposes the filter.

Out (v1):
- Full vectorize/pinecone filter syntax exposure (they differ; we should normalize).
- Updating chunk metadata after ingest (immutable for v1; reingest to change).
- Document-level metadata distinct from chunk-level. Maybe v2.

## Sketch

- D1 schema: add a `metadata` JSON column to `chunks` (or a `chunk_metadata` table for indexability — TBD by query patterns).
- Sparse arm: translate filter to a SQL `WHERE` clause against the metadata column (FTS5-compatible).
- Dense arm: translate filter to Vectorize's metadata filter syntax (and Pinecone's, for the Pinecone backend). Provider abstraction owns the translation.
- Filter contract in `@textral/contracts`:
  ```
  { filter: { and: [{ tag: { eq: "policy" } }, { year: { gte: 2024 } }] } }
  ```
  Mongo-style, since both Vectorize and Pinecone accept Mongo-flavored filters natively.
- Ingest: accept `metadata` per chunk in the chunking output, or per-document defaults that get inherited.

## Acceptance Criteria

- Ingest a doc with metadata `{ tag: "policy", year: 2024 }`; metadata reaches both D1 and the vector backend.
- `POST /query { filter: { tag: { eq: "policy" } } }` returns only matching chunks.
- AND/OR/eq/neq/gt/gte/lt/lte/in supported.
- Both dense and sparse arms respect the filter (no leakage from one arm).
- Filter mismatch (filtering for a field that doesn't exist) returns empty cleanly with `retrieval_status: "empty"` rather than an error.
- Audit shows the applied filter verbatim.

## Open Questions

- **Mongo-style or our own DSL?** Mongo-style is most-portable to Vectorize and Pinecone; our own DSL is cleaner but adds translation surface.
- **Filter on FTS5 sparse arm — performance?** D1 indexed JSON queries are passable but not great. Worth benchmarking before committing to `metadata` JSON column vs. dedicated columns for high-cardinality fields.
- **Metadata mutability.** If a customer wants to retag chunks without reingesting, we need an `update-metadata` endpoint. Out of scope for v1 but worth deciding upfront.
- **Filter validation against schema.** Should we enforce a per-namespace metadata schema (rejecting unknown fields), or be schemaless?

## Related

- [`CONNECTOR_MARKETPLACE.md`](./CONNECTOR_MARKETPLACE.md) — connectors will be the largest consumer (auto-tag by source).
- [`EMBED_WIDGET.md`](./EMBED_WIDGET.md) — faceted UX in the widget depends on metadata filters.
