"""Container-side profile loader. Reads the same YAMLs the Worker
loads (resolved via TEXTRAL_CORPUS_PROFILES_DIR or workspace fallback)
and validates with Pydantic."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.corpus_profiles import loader as ploader
from app.corpus_profiles.schema import CorpusProfile


REPO_ROOT = Path(__file__).resolve().parents[3]
PROFILES_DIR = REPO_ROOT / 'packages' / 'corpus-profiles' / 'profiles'


@pytest.fixture(autouse=True)
def _force_profiles_dir() -> None:
    os.environ['TEXTRAL_CORPUS_PROFILES_DIR'] = str(PROFILES_DIR)
    ploader.reset()


def test_loads_every_shipped_profile() -> None:
    ids = sorted(p.id for p in ploader.list_profiles())
    assert ids == ['generic', 'legal', 'narrative', 'support', 'technical']


def test_get_profile_returns_pydantic_model() -> None:
    p = ploader.get_profile('narrative')
    assert isinstance(p, CorpusProfile)
    assert p is not None
    assert p.enrichment.enabled is True
    assert p.retrieval_defaults.rerank.enabled is True


def test_unknown_profile_raises() -> None:
    with pytest.raises(RuntimeError, match='Unknown corpus profile'):
        ploader.get_profile_or_raise('not-a-profile')


def test_legal_profile_uses_clause_aware_chunker() -> None:
    p = ploader.get_profile_or_raise('legal')
    assert p.chunking.profile == 'legal_clause_aware'
    pass_ids = sorted(x.id for x in p.enrichment.passes)
    assert pass_ids == ['clause_extraction', 'obligation_extraction']


def test_rerank_enabled_profiles_have_provider_and_model() -> None:
    for p in ploader.list_profiles():
        if p.retrieval_defaults.rerank.enabled:
            assert p.retrieval_defaults.rerank.provider is not None
            assert p.retrieval_defaults.rerank.model is not None
