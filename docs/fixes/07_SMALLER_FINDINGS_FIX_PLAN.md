# Fix Plan 07 — Smaller findings batch

> Resolves audit findings #7-#18. These are small individually but
> several are real production-safety items.

## Item-by-item

### #7 — Secrets Store: prod boot check

**Today:** `apps/api/src/lib/secrets-store.ts` silently falls back
to KV when no Secrets Store binding is present. Acceptable in dev;
silent in prod.

**Fix:**
```ts
// In getSecretsStoreClient(env):
if (env.ENV === 'prod' && !secretsStoreBinding && !env.CACHE) {
  throw new Error(
    'Secrets Store binding required in prod; KV fallback was used in dev only.',
  );
}
```
Add a `ENV === 'prod'` check that throws unless the real binding is
present. (The KV fallback stays available because the deploy doesn't
yet have a Secrets Store binding even in prod — but the check
forces a deliberate decision.)

**Tests:** unit test sets `ENV='prod'` and asserts the throw fires.

### #8 — `enrichment_status` column placement comment

**Today:** the column is on `version_indexes`; intuitively callers
expect it on `ingestion_jobs`. We hit this bug late in Phase 5.

**Fix:** add a comment block at the top of migration 0002 + a
sentence in `docs/1-DESIGN.md` §5.1 explaining the placement
("enrichment status is per-(version, profile) combo, not per-job —
two jobs against the same version_index share one status").

### #9 — `/internal/providers/chat` endpoint

**Today:** `apps/ingest/app/enrichment/runner.py:_build_chat_callable`
POSTs to `/internal/providers/chat` — but the endpoint doesn't exist.
Enrichment passes are unit-tested with mocked callables; live
enrichment can't run.

**Fix:** add the endpoint as a sibling of `/internal/providers/embed`
in `apps/api/src/routes/internal/providers.ts`. Same auth + same
provider-key resolution; calls `provider.llm.chat(...)` instead of
`embed`. Returns `{ content, usage: { input_tokens, output_tokens }, request_id }`.

**Tests:** new `apps/api/test/internal-providers-chat.test.ts`.

### #10 — `workers_ai` naming consistency

**Today:** `apps/api/src/providers/types.ts` ProviderError type has
`'workers-ai'` (dash) in one union, while everywhere else uses
`'workers_ai'` (snake_case).

**Fix:** rename to snake_case everywhere. Sweep with
`grep -rEn "'workers-ai'"` and replace.

### #11 — Audit shape into contracts

**Today:** `query.ts` has a 17-field nested object literal type
declared inline, twice. Phase 5 pulled `RerankerAudit` into
contracts; do the rest.

**Fix:** move `QueryAudit`'s success and failure shapes (already
declared in `packages/contracts/src/query.ts:QueryAudit`) — make
`finalizeAudit` return `QueryAudit` directly. Eliminate the inline
type.

### #12 — Vectorize ID 64-byte cap assertion

**Today:** generated chunk_ids are 40-44 chars but no runtime check
guards against future format changes blowing through.

**Fix:** add an assertion in
- `apps/ingest/app/enrichment/runner.py:_artifact_chunk_id`
- `apps/ingest/app/chunkers/generic.py:_chunk_id`
- `apps/ingest/app/chunkers/code_aware.py:_chunk_id`
- `apps/ingest/app/chunkers/legal_clause_aware.py:_chunk_id`

A single helper `_assert_chunk_id_size(chunk_id: str)` that raises
if `len(chunk_id.encode('utf-8')) > 64`. Add a unit test that asserts
the helper fires.

### #13 — Stage-attempt metadata size cap

**Today:** the `/internal/jobs/:id/stage-attempt` route accepts
arbitrary `metadata` JSON. A malicious Container instance could blow
through the D1 row size cap.

**Fix:** cap the JSON-stringified metadata at 16 KB in the route
handler. Reject larger payloads with
`TextralError('BAD_REQUEST', 400, 'metadata exceeds 16KB cap')`.

**Tests:** unit test that 17KB metadata returns 400.

### #14 — Test fixture files

**Today:** PHASE_5 doc references
`apps/api/test/fixtures/{narrative-tiny.md, lease-tiny.md}`. The
current `test-live-phase5.ts` inlines a small fixture. The doc
references files that don't exist.

**Fix:** create the fixtures (commit them) and have
`test-live-phase5.ts` read from disk. Also create `lease-tiny.md`
for the deferred legal scenario; it's tiny anyway.

### #15 — Registry auto-discovery

**Today:** `_lazy_load_registry` is a static import list:
```python
from . import narrative, legal, support, technical
```
Adding a new pass module requires editing this line.

**Fix:** use `pkgutil.walk_packages` to auto-discover submodules of
`apps/ingest/app/enrichment/`. Each submodule's `__init__.py`
imports its passes (the registration side-effect happens then).
Add a unit test that asserts every passes registered in
`_REGISTRY` is referenced by at least one shipped profile.

### #16 — `make build-ingest` source check

**Today:** if the developer forgets to run the corpus-profiles mirror
step, `docker build` fails silently when COPY can't find the dir.

**Fix:** the Makefile already runs `cp -r packages/corpus-profiles/profiles apps/ingest/profiles`
before the wrangler build. Add a `set -e && [ -d packages/corpus-profiles/profiles ] || exit 1`
guard at the top of the recipe so the failure mode is loud.

### #17 — ESLint coverage check

**Today:** the root flat ESLint config covers all `**/*.ts`. The
per-package `lint` scripts run `eslint src test`. The new
`@textral/corpus-profiles` package's `lint` script is correct;
already verified in the audit.

**Fix:** None needed — already correct. Document in
`packages/corpus-profiles/README.md` (per fix plan §4) that lint
runs via `pnpm -r lint`.

### #18 — Merge parity test

**Today:** `mergeProfile` exists in TS and `merge_profile` in
Python. Each side has unit tests but no parity test.

**Fix:** extend `packages/corpus-profiles/test/parity.test.ts` to
also dump `mergeProfile(generic, override)` for a representative
override matrix. The Python `test_profile_parity.py` reads the
extended canonical JSON and asserts its own `merge_profile` output
matches.

## Files (full list)

**Edit:**
- `apps/api/src/lib/secrets-store.ts` (#7)
- `apps/api/migrations/0002_documents_jobs_chunks.sql` (#8 — add comment block)
- `docs/1-DESIGN.md` (#8)
- `apps/api/src/routes/internal/providers.ts` (#9)
- `apps/api/src/providers/types.ts` (#10)
- `apps/api/src/routes/query.ts` (#11)
- `apps/ingest/app/enrichment/runner.py` (#12, #15)
- `apps/ingest/app/chunkers/generic.py` (#12)
- `apps/ingest/app/chunkers/code_aware.py` (#12)
- `apps/ingest/app/chunkers/legal_clause_aware.py` (#12)
- `apps/ingest/app/enrichment/__init__.py` (#15)
- `apps/api/src/routes/internal/ingest-write.ts` (#13)
- `apps/api/scripts/test-live-phase5.ts` (#14)
- `Makefile` (#16)
- `packages/corpus-profiles/test/parity.test.ts` (#18)
- `apps/ingest/tests/test_profile_parity.py` (#18)

**New:**
- `apps/api/test/internal-providers-chat.test.ts` (#9)
- `apps/api/test/secrets-store-prod-check.test.ts` (#7)
- `apps/api/test/stage-attempt-metadata-cap.test.ts` (#13)
- `apps/ingest/tests/test_chunk_id_size_cap.py` (#12)
- `apps/ingest/tests/test_registry_coverage.py` (#15)
- `apps/api/test/fixtures/narrative-tiny.md` (#14)
- `apps/api/test/fixtures/lease-tiny.md` (#14)
- `apps/ingest/app/enrichment/_chunk_id_guard.py` (#12 — shared helper)

## Tests + acceptance

- All package test sweeps green.
- Both live e2es green.
- The 11 items above each have a unit test that exercises the new
  guard / helper / endpoint.

## Sequencing

Most of these are small, isolated, and parallelizable. Order:
1. #14 (fixture files; cheap setup)
2. #7, #13, #16 (production-safety; small but high-value)
3. #9 (chat endpoint; unblocks live enrichment)
4. #10, #15, #18 (cleanup + parity)
5. #8, #11, #12 (audit polish)
