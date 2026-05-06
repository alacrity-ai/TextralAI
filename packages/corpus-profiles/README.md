# `@textral/corpus-profiles`

The corpus profile registry — single source of truth for chunking,
enrichment, retrieval defaults, and prompt defaults across the
Worker (TS) and the Container (Python).

## Canonical form

YAML files in `./profiles/*.yaml`. **Edit those.** Each profile is
self-contained.

The compiled JSON form at `./src/_generated.ts` is regenerated from
the YAMLs by `pnpm --filter @textral/corpus-profiles gen`. The
generated file is committed so the Worker (which can't `readdirSync`
in workerd at runtime) always has the data available.

## Two validators

The profile shape is defined in two places, by design:

- **TS / Worker**: `src/schema.ts` (Zod). Loaded eagerly at module
  import; a malformed YAML crashes the Worker at boot.
- **Python / Container**: `apps/ingest/app/corpus_profiles/schema.py`
  (Pydantic). Loaded eagerly at uvicorn startup with the same
  crash semantics.

## The drift rule

**Any change to one schema MUST be made in the other in the same
PR.** The parity test
(`packages/corpus-profiles/test/parity.test.ts` +
`apps/ingest/tests/test_profile_parity.py`) catches drift via a
canonical-JSON dump comparison, but it's reactive — it fails the
build *after* the drift exists. Reviewers should fail PRs that touch
one validator without the other.

The merge-helper has a parallel rule: `src/merge.ts` (TS) and
`apps/ingest/app/corpus_profiles/merge.py` (Python) must produce
structurally equivalent results. Test parity covers that too.

## Adding a profile

1. Add `./profiles/<id>.yaml`.
2. Run `pnpm --filter @textral/corpus-profiles gen` to regenerate
   `src/_generated.ts`. Commit it.
3. Run the test sweep on both sides:
   - `pnpm --filter @textral/corpus-profiles test`
   - `cd apps/ingest && python -m pytest tests/test_profile_*.py`
4. The invariants test rejects profiles that:
   - omit `passage` from `artifact_types`
   - declare a `produces[*]` artifact_type not in `artifact_types`
   - reference a `depends_on` pass id that doesn't exist
   - have `layer_budgets` summing outside [0.99, 1.01]
   - enable `rerank` without setting `provider` and `model`

If you add a new enrichment pass, make sure the Container also
registers it in `apps/ingest/app/enrichment/runner.py:_REGISTRY`
and the registry-coverage test stays green.

## Adding a new schema field

1. Edit `src/schema.ts` (Zod).
2. Edit `apps/ingest/app/corpus_profiles/schema.py` (Pydantic) to
   match. Honor the same defaults + optionality semantics.
3. Update YAMLs that need the new field, OR leave them on the
   default.
4. Run the parity test in both runtimes:
   - TS: `pnpm --filter @textral/corpus-profiles test parity`
     (writes the canonical JSON dump)
   - Python: `cd apps/ingest && python -m pytest tests/test_profile_parity.py`
     (compares against the dump)
5. Run `pnpm --filter @textral/corpus-profiles gen` to refresh
   `_generated.ts` from the new YAMLs.

## Why two schemas

Generating one from the other (e.g. Zod → JSON Schema → Pydantic)
introduces tooling debt + loses Zod's `superRefine` and Pydantic's
`@model_validator` features. The dual maintenance cost is small
enough that we accept it; the parity test is the safety net. Phase 7
revisits if the contracts grow significantly.

## Lint coverage

The root flat ESLint config covers all `**/*.ts` files; the per-package
`lint` script runs `eslint src test`. CI runs `pnpm -r lint` which
covers both. The Python side runs ruff via the test harness.
