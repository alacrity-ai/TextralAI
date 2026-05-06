# Fix Plan 08 — Pinecone namespace mapping

> **Status:** design draft. Authored 2026-05-06 ahead of the
> Pinecone PE call. Resolves a conceptual conflation in the Pinecone
> adapter where a Textral namespace maps to a Pinecone *index*
> instead of a Pinecone *namespace*. Sister docs: `docs/v3/PHASE-1_DETAILED_DESIGN.md`
> §3 (the original `VectorStore` interface) and `docs/fixes/01_VECTOR_STORE_FIX_PLAN.md`.

---

## 1. Goal

Make the Pinecone adapter use Pinecone's **native namespace** for
multi-tenant partitioning, so many Textral namespaces can share one
Pinecone index — which is the canonical Pinecone multi-tenancy
pattern. Today every Textral namespace requires its own Pinecone
index, which is operator-hostile, expensive, and unidiomatic.

The Qdrant and Vectorize adapters are unaffected. The fix is
isolated to the Pinecone path.

---

## 2. The bug

### 2.1 What we ship today

```
Textral namespace (slug=short-stories-pinecone)
  └── vector_backend  = pinecone
  └── vector_index_name = https://textral-index-…pinecone.io  # the host URL
```

When the adapter writes/reads vectors, it does so against Pinecone's
*default* namespace inside that index. Operators see this in the
Pinecone dashboard: every Textral namespace's vectors land in the
unnamed `__default__` (or empty-string) namespace of whatever index
they pointed `vector_index_name` at.

### 2.2 Why that's wrong

Three vector stores; three different isolation primitives:

| Store | "Container" | "Tenancy primitive" | Idiomatic mapping for a Textral namespace |
|---|---|---|---|
| Vectorize | one global index | metadata filter | many Textral namespaces → 1 Vectorize index, isolated by `tenant_id` filter |
| Qdrant | collection | per-collection | 1 Textral namespace → 1 Qdrant collection (current behavior) |
| Pinecone | index | **namespace** | many Textral namespaces → 1 Pinecone index, isolated by **native Pinecone namespace** (NOT what we do) |

A Pinecone customer who looks at our integration today sees that
we've ignored Pinecone's namespace primitive entirely. That's
exactly what every naive integration does, and exactly what
Pinecone PEs flag.

### 2.3 Cost + ops impact

- One Pinecone index per Textral namespace = N serverless instances
  for N tenants/scopes. Pinecone bills per index.
- Operators have to pre-provision an index per Textral namespace
  via the Pinecone dashboard. With native namespaces, it's one
  index, lifecycle managed by Textral.
- `delete_namespace` on Pinecone today would have to delete an
  entire index. With native namespaces, it's a `DELETE` against
  one namespace inside a long-lived shared index — O(1), reversible
  by re-ingest if needed.

---

## 3. The right model

### 3.1 Schema

`Namespace` gains an optional **`vector_namespace`** field. Meaningful
only when `vector_backend === 'pinecone'`. Defaults to the Textral
slug if omitted.

```ts
export const Namespace = z.object({
  // …existing fields…
  vector_backend: VectorBackend,
  vector_index_name: z.string().nullable(),
  vector_namespace: z.string().nullable(),  // NEW
});
```

**Naming choice — `vector_namespace`, not `pinecone_namespace`:** the
field is provider-neutral on the schema even though only the Pinecone
adapter reads it today. Future adapters (e.g., a multi-tenant Qdrant
mode using payload-based partitioning) can adopt the same field.

### 3.2 Uniqueness

`(vector_backend, vector_index_name, vector_namespace)` should be
unique inside a tenant. Two Textral namespaces sharing the same
Pinecone index + Pinecone-namespace would write to the same vectors
and silently corrupt each other.

Enforce in the route handler (pre-insert check); skip a DB-level
constraint to avoid SQLite + Postgres divergence on partial-unique
index syntax. TOCTOU window is acceptable — the read-then-write race
loses a few μs and the second writer sees a 409 from a downstream
constraint anyway (the `(tenant_id, slug)` unique already exists).

### 3.3 Default behavior

- `vector_backend === 'pinecone'`, `vector_namespace` omitted →
  default to the Textral slug. So `slug=lighthouse-tales` becomes
  Pinecone namespace `lighthouse-tales` automatically. Sensible
  default; operator can override.
- `vector_backend === 'qdrant'` or `'vectorize'`, `vector_namespace`
  passed → ignored, persisted as `null`. Don't reject — the field is
  forward-compat.
- `vector_namespace` validation: same shape as `slug` (lowercase,
  digits, hyphens, 2–63 chars; Pinecone's namespace name limit is
  forgiving).

---

## 4. Architecture

### 4.1 Files

**Edit:**

| File | Change |
|---|---|
| `packages/contracts/src/namespace.ts` | Add `vector_namespace` to `Namespace`, `NamespaceCreate`. Strip from `NamespaceUpdate` (locked at create-time). |
| `apps/api/migrations/sqlite/0009_namespace_vector_namespace.sql` | New column. Backfill existing pinecone rows to `''` (Pinecone's default-namespace literal — preserves existing data location). |
| `apps/api/migrations/postgres/0009_namespace_vector_namespace.sql` | Same. |
| `apps/api/src/db/namespaces.ts` | Include the column on insert + the row-mapper. |
| `apps/api/src/retrieval/vector-store.ts` | `VectorBinding` gains `namespace?: string`. `vectorStoreFor` passes it into the Pinecone adapter constructor. Qdrant/Vectorize adapters receive but ignore it. |
| `apps/api/src/retrieval/adapters/pinecone.ts` | `PineconeConfig.namespace?: string`. Every Pinecone REST call (`upsert`, `query`, `delete`) includes `namespace` in the request body when set. `ensureBackingExists` is unchanged (reachability is per-index, not per-namespace). |
| `apps/api/src/routes/namespaces.ts` | Read+forward the new field on `POST /v1/namespaces`. Pre-insert uniqueness check across `(tenant_id, vector_backend, vector_index_name, vector_namespace)` for pinecone rows. Default-to-slug logic for pinecone when the field is omitted. |
| `apps/api/src/openapi/components.ts` | Surface the field on the OpenAPI schemas (auto-derived from contracts; mostly a description tweak). |
| `apps/sandbox/src/pages/Namespaces.tsx` | New input on the create form (visible only when backend=pinecone, with helper text explaining the index/namespace distinction). New column on the list table. |
| `docs/SELF_HOSTING.md` §4.2 | Update Pinecone section to document the new model: one operator-provisioned index, many Textral namespaces. |
| `apps/api/src/openapi/tag-descriptions.ts` Namespaces | Update operator-config matrix to clarify the Pinecone index/namespace mapping. |

**MCP-side:** zero changes. `create_namespace`'s input schema is
derived from `NamespaceCreate` via `zod-to-json-schema`, so the new
field appears automatically. Same for the sandbox API client and the
SDK.

### 4.2 Pinecone adapter call shape

The Pinecone REST API accepts `namespace: string` as a top-level
field on most operations. Patches to `apps/api/src/retrieval/adapters/pinecone.ts`:

```ts
async upsert(records) {
  // …
  const body: Record<string, unknown> = { vectors };
  if (this.cfg.namespace) body.namespace = this.cfg.namespace;
  await this.fetch('/vectors/upsert', { method: 'POST', body: JSON.stringify(body) });
}

async query(vector, opts) {
  // …
  const body: Record<string, unknown> = { vector, topK, filter, includeMetadata: false };
  if (this.cfg.namespace) body.namespace = this.cfg.namespace;
  await this.fetch('/query', { method: 'POST', body: JSON.stringify(body) });
}

async deleteByIds(ids) {
  // …
  const body: Record<string, unknown> = { ids };
  if (this.cfg.namespace) body.namespace = this.cfg.namespace;
  await this.fetch('/vectors/delete', { method: 'POST', body: JSON.stringify(body) });
}
```

`tenant_id` and `namespace_id` filters stay as-is (defense in depth —
even if a misconfiguration sent two Textral tenants to the same
Pinecone namespace, the filter still isolates them). The Pinecone
namespace becomes the *primary* isolation boundary; the metadata
filter is *secondary*.

### 4.3 Sandbox UI

Two changes on `apps/sandbox/src/pages/Namespaces.tsx`:

1. **Create form.** Below `vector_backend`, conditionally render a
   `Vector namespace` text input when `vector_backend === 'pinecone'`,
   with helper text:

   > Pinecone partition inside the index. Multiple Textral namespaces
   > can share one Pinecone index by using different values here.
   > Defaults to the slug.

2. **List table.** Insert a new column `vector namespace` between
   `vector_backend` and `vector_index_name`. Show `—` for non-pinecone
   rows. Renames the existing `index name` column header to
   `index / collection / host` for clarity (the user-reported
   confusion: that column means three different things across
   backends).

### 4.4 Migration

```sql
-- 0009_namespace_vector_namespace.sql (sqlite)
ALTER TABLE namespaces ADD COLUMN vector_namespace TEXT;

-- Backfill: existing pinecone rows wrote to Pinecone's default
-- (unnamed) namespace; set the column to empty string so adapter
-- code sees "no namespace, query the default" — preserves data
-- location. New pinecone namespaces created post-migration default
-- to the Textral slug.
UPDATE namespaces SET vector_namespace = '' WHERE vector_backend = 'pinecone';
```

Postgres equivalent identical (TEXT + UPDATE).

The empty-string sentinel on backfill is intentional: in the adapter,
`if (this.cfg.namespace)` skips the namespace field on the request,
preserving the call shape Pinecone uses for the default namespace.
Existing data stays addressable; new namespaces use real names.

### 4.5 Existing demo data

The `short-stories-pinecone` namespace (created during the Pinecone
PE prep run) already has data in Pinecone's default namespace. After
migration:

- Its `vector_namespace` is `''` (backfill).
- Existing vectors stay queryable (call shape unchanged).
- For the demo, **delete + re-create** with explicit
  `vector_namespace: 'lighthouse-tales'`, then ingest again. Cleaner
  story than carrying a backfilled row.

---

## 5. Anti-goals

- **No Vectorize-side changes.** Vectorize doesn't have native
  namespaces; the existing `tenant_id` metadata filter is correct.
- **No Qdrant-side changes.** The 1-collection-per-Textral-namespace
  mapping is fine for Qdrant — collections are cheap, isolation is
  hard, and Qdrant's payload-based multi-tenancy mode is a separate,
  larger design.
- **No Pinecone-index lifecycle ownership.** Operators still
  pre-create the index. Textral creates and deletes only at the
  Pinecone-namespace level inside that index. Rationale: index
  creation requires dimension/metric/serverless-tier choices we
  don't carry in our schema; deferring to the operator keeps the
  contract narrow.
- **No `vector_namespace` mutability.** Locked at create time, like
  `vector_backend` and `vector_index_name`. Switching means a new
  Textral namespace + re-ingest.

---

## 6. Migration path for an operator with existing pinecone data

For a deploy that's been running pre-fix:

1. Apply migration `0009`. All existing pinecone-backed Textral
   namespaces get `vector_namespace = ''` — no behavior change, all
   reads/writes continue against Pinecone's default namespace.
2. New namespaces created post-migration use the slug as default,
   landing vectors in a real Pinecone namespace.
3. To consolidate: re-ingest old data into a new namespace with an
   explicit `vector_namespace`, point traffic at the new one, delete
   the old.

No flag day. No data loss. Phase-able.

---

## 7. Acceptance gates

- [ ] `pnpm -r typecheck` clean.
- [ ] `pnpm --filter @textral/mcp test` green.
- [ ] Migration applies cleanly on sqlite + postgres.
- [ ] **The demo proof-of-multi-tenancy:** create two Textral
      namespaces (`lighthouse-tales`, `support-kb`) with
      `vector_backend: pinecone, vector_index_name: <same host>`,
      different `vector_namespace` values. Ingest different content
      into each via `ingest_file`. Query `lighthouse-tales` for
      something only present in `support-kb` → returns
      `degradation_level: cannot_answer` or no relevant citations
      (cross-namespace silence). Audit shows
      `embedding_profile: openai-text-embedding-3-large-1024` and the
      candidate counts confirm dense returned only the in-namespace
      vectors.
- [ ] Pinecone dashboard for `textral-index` shows the two namespaces
      side-by-side with non-zero vector counts. (This is the visual
      Pinecone PE will look at first.)
- [ ] Sandbox **Namespaces** page: new column populated, create form
      input visible when backend=pinecone.
- [ ] Existing `short-stories-pinecone` continues to round-trip.
- [ ] OpenAPI `/openapi.json` shows the new field on the
      `NamespaceCreate` and `Namespace` schemas.

---

## 8. Demo upside

Why this matters for the Pinecone PE call:

- **Native namespace usage** is what every serious Pinecone
  integration does. Showing it tells the PE we're not naive about
  their model.
- **Cost story:** "one index, many tenants" is the Pinecone-aligned
  multi-tenancy pitch. Demoing the same index serving two Textral
  namespaces is a one-glance proof.
- **Operator UX:** the demo can run `create_namespace` twice through
  MCP, against the same `vector_index_name`, with no operator console
  steps in between. That's the agent-driven multi-tenant
  provisioning story we want them to internalize.
- **Inverse of the current demo's weakness:** the user explicitly
  flagged the conflation. Shipping this fix turns that weakness into
  the punchline of the demo.

---

## 9. Open questions

None blocking. Two design notes for future-us:

1. **Do we want to namespace-by-default-to-slug, or require explicit
   pass?** Current draft defaults. Reasoning: friction is the enemy
   for first-time integrations; explicit override is always
   available. Operator who *wants* the default Pinecone namespace
   can pass `vector_namespace: ""`.
2. **Should `delete_namespace` (Phase 2 destructive tool) also drop
   the Pinecone namespace?** Yes — Pinecone's `delete-by-namespace`
   is O(1) and is the natural cleanup. Defer the implementation to
   the Phase 2 tool's design; this fix's scope ends at create + read.

---

## 10. Out of scope but worth noting

- **Pinecone Inference (`integrated` indexes)** — Pinecone now offers
  "integrated" indexes that own embedding generation server-side.
  Different model entirely (no BYOK embedding from Textral; the
  index runs the embedder). If/when we support these, it's a
  parallel adapter (`PineconeIntegratedAdapter`), not an extension
  of this fix.
- **Pinecone hosted rerank** — Pinecone has a rerank service that
  could feed into our reranker stack, replacing the current Voyage
  default. Separate design; flagged in the demo audit's
  `reranker.fallback_reason: PROVIDER_KEY_NOT_FOUND` row.
- **Sparse vectors** (Pinecone's BM25-like sparse indexes) — could
  fold into our hybrid retrieval RRF, replacing FTS5/Postgres
  full-text on the Pinecone path. Larger design.

---

End of fix plan. Acceptance is the multi-namespace demo proof
working end-to-end via MCP, observable in the Pinecone dashboard.
