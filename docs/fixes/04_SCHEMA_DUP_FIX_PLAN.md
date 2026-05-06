# Fix Plan 04 — Schema duplication contract (TS Zod ↔ Python Pydantic)

> Resolves audit finding §4: the corpus profile schema lives in two
> places (Zod + Pydantic). The parity test catches drift but the
> "which side is canonical" rule is implicit.

## Goal

The lowest-cost option from the audit (option 1): document the
contract loudly. The parity test stays as the drift detector; the
maintenance rule becomes explicit and discoverable.

## Files

**New:**
- `packages/corpus-profiles/README.md` — the contract.

**Edit:**
- `apps/ingest/app/corpus_profiles/__init__.py` — add a docstring
  pointing at the README.
- `packages/corpus-profiles/src/schema.ts` — add a one-line header
  comment: "Mirrored in apps/ingest/app/corpus_profiles/schema.py;
  see ../README.md."
- `apps/ingest/app/corpus_profiles/schema.py` — same.
- `docs/1-DESIGN.md` §9 — replace the illustrative inline `legal`
  YAML with a pointer to `packages/corpus-profiles/profiles/`.

## README content (outline)

```
# @textral/corpus-profiles

The corpus profile registry. Single source of truth for
chunking + enrichment + retrieval defaults across the Worker (TS)
and the Container (Python).

## Canonical form

YAML files in `./profiles/*.yaml`. Edit those.

## Two validators

- TS / Worker: `src/schema.ts` (Zod). Loaded eagerly at module
  import; a malformed YAML crashes the Worker at boot.
- Python / Container: `apps/ingest/app/corpus_profiles/schema.py`
  (Pydantic). Loaded eagerly at uvicorn startup with the same
  crash semantics.

## The drift rule

ANY change to one schema MUST be made in the other in the same PR.
The parity test
(`packages/corpus-profiles/test/parity.test.ts` +
 `apps/ingest/tests/test_profile_parity.py`) catches drift via a
canonical-JSON dump, but it's reactive, not preventive. Reviewers
should fail PRs that touch one validator without the other.

## Adding a profile

1. Add `./profiles/<id>.yaml`.
2. Run `pnpm --filter @textral/corpus-profiles gen` to regenerate
   `src/_generated.ts`. Commit it.
3. Run the test sweep on both sides:
   - `pnpm --filter @textral/corpus-profiles test`
   - `cd apps/ingest && python -m pytest tests/test_profile_*.py`
4. The invariants test will reject profiles that:
   - omit `passage` from `artifact_types`
   - declare a `produces[*]` artifact_type not in `artifact_types`
   - reference a `depends_on` pass id that doesn't exist
   - have `layer_budgets` summing outside [0.99, 1.01]

## Adding a new field to the schema

1. Edit `src/schema.ts` (Zod).
2. Edit `apps/ingest/app/corpus_profiles/schema.py` (Pydantic) to
   match. Honor the same defaults + optionality rules.
3. Update YAMLs that need the new field, OR leave it to the default.
4. Run the parity test; the canonical JSON should match.
5. Run `pnpm gen` to refresh `_generated.ts`.
```

## Tests

- The parity test already exists. No new tests; this fix is
  documentation-only.

## Acceptance

- README exists and contains the four sections above.
- `docs/1-DESIGN.md` §9 cross-references `packages/corpus-profiles/profiles/`.
- Both schema files have a top-of-file mirror-warning comment.

## Out of scope

- Generating one schema from the other (codegen). Pencil for Phase 7
  if contracts grow.
- Building a JSON-Schema-only world. The Zod/Pydantic dual maintenance
  cost is small enough to defer the rewrite.

## Sequencing

Independent. Can be done in parallel with everything else.
