"""Cross-runtime parity check.

The TS Zod loader and the Python Pydantic loader must produce
structurally equivalent profile data. Drift surfaces here as a diff.

We compare canonicalized JSON (sorted keys) of the validated +
default-applied profile bodies. Any field-default or shape divergence
between the two schemas breaks this test.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.corpus_profiles import loader as ploader


REPO_ROOT = Path(__file__).resolve().parents[3]
PROFILES_DIR = REPO_ROOT / 'packages' / 'corpus-profiles' / 'profiles'
TS_PARITY_DUMP = REPO_ROOT / 'packages' / 'corpus-profiles' / 'test' / '_canonical.json'
TS_MERGE_DUMP = REPO_ROOT / 'packages' / 'corpus-profiles' / 'test' / '_merge_canonical.json'

# Mirrors MERGE_MATRIX in packages/corpus-profiles/test/parity.test.ts.
# The two lists must stay in lock-step: same id → same {base, override}.
_MERGE_MATRIX: list[dict] = [
    {'id': 'generic_no_override', 'base': 'generic', 'override': {}},
    {
        'id': 'generic_chunking_target_bump',
        'base': 'generic',
        'override': {'chunking': {'target_tokens': 1200}},
    },
    {
        'id': 'narrative_disable_enrichment',
        'base': 'narrative',
        'override': {'enrichment': {'enabled': False}},
    },
    {
        'id': 'narrative_replace_passes_with_empty',
        'base': 'narrative',
        'override': {'enrichment': {'passes': []}},
    },
    {
        'id': 'generic_rerank_on_top_n_5',
        'base': 'generic',
        'override': {
            'retrieval_defaults': {
                'rerank': {
                    'enabled': True,
                    'provider': 'voyage',
                    'model': 'rerank-2',
                    'top_n': 5,
                },
            },
        },
    },
    {
        'id': 'generic_artifact_types_extended',
        'base': 'generic',
        'override': {
            'retrieval_defaults': {
                'artifact_types': ['passage', 'narrative.section_summary'],
            },
        },
    },
    {
        'id': 'legal_layer_budgets_partial_merge',
        'base': 'legal',
        'override': {'retrieval_defaults': {'layer_budgets': {'legal.clause': 2.0}}},
    },
    {
        'id': 'generic_prompt_defaults_system_replace',
        'base': 'generic',
        'override': {'prompt_defaults': {'system': 'Custom system prompt for tests.'}},
    },
]


def _python_canonical() -> dict:
    os.environ['TEXTRAL_CORPUS_PROFILES_DIR'] = str(PROFILES_DIR)
    ploader.reset()
    profiles = sorted(ploader.list_profiles(), key=lambda p: p.id)
    # exclude_none matches Zod's "absent optional" serialization: Zod
    # parsed.optional() values that weren't supplied don't appear in
    # the validated object; Pydantic Optional defaults to None and
    # would render as "key": null. Drop them here so the canonical
    # JSON forms match.
    return {p.id: p.model_dump(mode='json', exclude_none=True) for p in profiles}


@pytest.mark.skipif(
    not TS_PARITY_DUMP.exists(),
    reason='TS canonical dump not present; run `pnpm --filter @textral/corpus-profiles test parity` first',
)
def test_python_matches_ts_canonical() -> None:
    py = _python_canonical()
    ts = json.loads(TS_PARITY_DUMP.read_text(encoding='utf-8'))
    if py != ts:
        # Show a focused diff for the first divergent profile.
        for k in sorted(set(py) | set(ts)):
            if py.get(k) != ts.get(k):
                py_dump = json.dumps(py.get(k), sort_keys=True, indent=2)
                ts_dump = json.dumps(ts.get(k), sort_keys=True, indent=2)
                pytest.fail(
                    f'parity diverges on profile {k!r}:\nPython:\n{py_dump}\n\nTS:\n{ts_dump}',
                )


def test_python_canonical_round_trips() -> None:
    """Sanity: dumping + reloading the Python form is a fixed point."""
    a = _python_canonical()
    b = _python_canonical()
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def _python_merge_canonical() -> dict:
    from app.corpus_profiles.merge import merge_profile

    os.environ['TEXTRAL_CORPUS_PROFILES_DIR'] = str(PROFILES_DIR)
    ploader.reset()
    out: dict = {}
    for entry in _MERGE_MATRIX:
        base = ploader.get_profile_or_raise(entry['base'])
        merged = merge_profile(base, entry['override'])
        out[entry['id']] = merged.model_dump(mode='json', exclude_none=True)
    return out


@pytest.mark.skipif(
    not TS_MERGE_DUMP.exists(),
    reason='TS merge dump not present; run `pnpm --filter @textral/corpus-profiles test parity` first',
)
def test_python_merge_matches_ts_canonical() -> None:
    py = _python_merge_canonical()
    ts = json.loads(TS_MERGE_DUMP.read_text(encoding='utf-8'))
    assert set(py) == set(ts), (
        f'merge matrix id sets diverge — TS-only: {set(ts) - set(py)}, '
        f'Python-only: {set(py) - set(ts)}'
    )
    if py != ts:
        for k in sorted(set(py) | set(ts)):
            if py.get(k) != ts.get(k):
                py_dump = json.dumps(py.get(k), sort_keys=True, indent=2)
                ts_dump = json.dumps(ts.get(k), sort_keys=True, indent=2)
                pytest.fail(
                    f'merge parity diverges on case {k!r}:\nPython:\n{py_dump}\n\nTS:\n{ts_dump}',
                )


# Hint to maintainers if they only run pytest.
if __name__ == '__main__':
    print('Generate TS canonical dump first:', TS_PARITY_DUMP, file=sys.stderr)
    print('  pnpm --filter @textral/corpus-profiles test parity', file=sys.stderr)
    subprocess.call(['pytest', __file__])
