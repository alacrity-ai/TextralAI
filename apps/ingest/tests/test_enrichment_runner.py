"""Enrichment runner — topo sort, model resolution, skip-on-dep,
required-vs-optional failure surface, deterministic chunk IDs."""

from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest
import respx

from app.cdm.model import Block, CanonicalDocument
from app.chunkers.generic import Chunk
from app.clients.worker import WorkerClient
from app.corpus_profiles import loader as ploader
from app.corpus_profiles.schema import (
    CorpusProfile,
    EnrichmentPassDef,
    EnrichmentSection,
    InferenceModelRef,
    PromptDefaults,
    RetrievalDefaults,
    RerankConfig,
    ChunkingProfileConfig,
)
from app.enrichment.runner import (
    _artifact_chunk_id,
    _resolve_pass_model,
    _topo_sort,
    run_enrichment,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
PROFILES_DIR = REPO_ROOT / 'packages' / 'corpus-profiles' / 'profiles'

SECRET = 's'
BASE = 'http://w'


@pytest.fixture(autouse=True)
def _force_profiles_dir() -> None:
    os.environ['TEXTRAL_CORPUS_PROFILES_DIR'] = str(PROFILES_DIR)
    ploader.reset()


def test_artifact_chunk_id_format() -> None:
    cid = _artifact_chunk_id('ver_01ABCDEFG123456789012345YZ', 'character_dossier', 0)
    # chk_ + 30-char version_id + _e + 8-hex = 44 chars (well under
    # Vectorize's 64-byte ID cap)
    assert cid.startswith('chk_ver_01ABCDEFG123456789012345YZ_e')
    assert len(cid) == 4 + 30 + 2 + 8
    # Deterministic: same triple → same id.
    cid2 = _artifact_chunk_id('ver_01ABCDEFG123456789012345YZ', 'character_dossier', 0)
    assert cid == cid2
    # Different sequence → different id.
    assert cid != _artifact_chunk_id('ver_01ABCDEFG123456789012345YZ', 'character_dossier', 1)


def test_topo_sort_orders_dependencies() -> None:
    a = EnrichmentPassDef(id='a', scope='document', artifact_namespace='x', produces=['x.a'])
    b = EnrichmentPassDef(
        id='b', scope='document', artifact_namespace='x', produces=['x.b'], depends_on=['a'],
    )
    c = EnrichmentPassDef(
        id='c', scope='document', artifact_namespace='x', produces=['x.c'], depends_on=['b'],
    )
    sorted_ = _topo_sort([c, a, b])
    assert [p.id for p in sorted_] == ['a', 'b', 'c']


def test_topo_sort_detects_cycle() -> None:
    a = EnrichmentPassDef(
        id='a', scope='document', artifact_namespace='x', produces=['x.a'], depends_on=['b'],
    )
    b = EnrichmentPassDef(
        id='b', scope='document', artifact_namespace='x', produces=['x.b'], depends_on=['a'],
    )
    with pytest.raises(RuntimeError, match='Cycle'):
        _topo_sort([a, b])


def test_resolve_pass_model_request_overrides_profile() -> None:
    profile = ploader.get_profile_or_raise('narrative')
    pass_def = next(p for p in profile.enrichment.passes if p.id == 'character_dossier')
    request_default = InferenceModelRef(provider='openai', model='gpt-test-default')
    request_override = InferenceModelRef(provider='openai', model='gpt-test-override')

    # Per-pass request override wins
    m = _resolve_pass_model(
        pass_def, profile, {pass_def.id: request_override}, request_default,
    )
    assert m.model == 'gpt-test-override'

    # No per-pass override → request default wins over profile pass model
    m = _resolve_pass_model(pass_def, profile, {}, request_default)
    assert m.model == 'gpt-test-default'

    # No request anywhere → profile pass model wins (character_dossier sets gpt-4o)
    m = _resolve_pass_model(pass_def, profile, {}, None)
    assert m.model == 'gpt-4o'


def test_resolve_pass_model_falls_back_to_profile_default() -> None:
    profile = ploader.get_profile_or_raise('narrative')
    # section_summary has no pass-level model, so falls back to profile default.
    pass_def = next(p for p in profile.enrichment.passes if p.id == 'section_summary')
    m = _resolve_pass_model(pass_def, profile, {}, None)
    assert m.model == 'gpt-4o-mini'


def test_resolve_pass_model_raises_when_no_model_anywhere() -> None:
    # Build a profile with NO enrichment.default_model and a pass with no model override.
    pass_def = EnrichmentPassDef(
        id='nomodel',
        scope='document',
        artifact_namespace='x',
        produces=['x.nomodel'],
    )
    profile = CorpusProfile(
        id='no-model-profile',
        chunking=ChunkingProfileConfig(),
        enrichment=EnrichmentSection(enabled=True, passes=[pass_def]),
        retrieval_defaults=RetrievalDefaults(
            artifact_types=['passage', 'x.nomodel'],
            rerank=RerankConfig(enabled=False),
        ),
        prompt_defaults=PromptDefaults(),
    )
    with pytest.raises(RuntimeError, match='No model resolvable'):
        _resolve_pass_model(pass_def, profile, {}, None)


def _passage(idx: int, text: str = 'body') -> Chunk:
    return Chunk(id=f'chk_ver_test_{idx:05d}', ord=idx, section_path='/', text=text)


@respx.mock
async def test_run_enrichment_skips_when_disabled() -> None:
    profile = ploader.get_profile_or_raise('generic')
    client = WorkerClient(base_url=BASE, secret=SECRET)
    out = await run_enrichment(
        worker=client,
        job_id='job_x',
        tenant_id='ten_x',
        namespace_id='ns_x',
        document_id='doc_x',
        version_id='ver_test',
        version_index_id='vidx_x',
        embedding_profile='openai-text-embedding-3-large-1536',
        chunking_profile='generic',
        embedding_dimensions=1536,
        profile=profile,
        request_default_model=None,
        request_pass_overrides={},
        cdm=CanonicalDocument(document_id='doc_x', version_id='ver_test'),
        passages=[],
    )
    assert out == {}
    await client.aclose()


@respx.mock
async def test_run_enrichment_skips_pass_when_dependency_fails() -> None:
    """Build a profile with two passes; A is required but raises in the
    runner's view (we'll mock /internal/providers/chat to 503), B
    depends on A. After A's failure (logged as failed because we use
    required=False), B must be 'skipped'."""
    pass_a = EnrichmentPassDef(
        id='character_dossier',  # actually registered, but we'll force a fail
        scope='document',
        artifact_namespace='narrative',
        produces=['narrative.character_dossier'],
        required=False,
    )
    pass_b = EnrichmentPassDef(
        id='theme',
        scope='document',
        artifact_namespace='narrative',
        produces=['narrative.theme'],
        depends_on=['character_dossier'],
        required=False,
    )
    profile = CorpusProfile(
        id='test-profile',
        chunking=ChunkingProfileConfig(),
        enrichment=EnrichmentSection(
            enabled=True,
            default_model=InferenceModelRef(provider='openai', model='gpt-4o-mini'),
            passes=[pass_a, pass_b],
        ),
        retrieval_defaults=RetrievalDefaults(
            artifact_types=['passage', 'narrative.character_dossier', 'narrative.theme'],
            rerank=RerankConfig(enabled=False),
        ),
    )

    # Mock all stage-attempt + chat calls.
    respx.post(url__regex=rf'^{BASE}/internal/jobs/.*/stage-attempt$').mock(
        return_value=httpx.Response(200, json={'ok': True}),
    )
    respx.post(f'{BASE}/internal/providers/chat').mock(
        return_value=httpx.Response(503, json={'error': {'code': 'PROVIDER_UNAVAILABLE'}}),
    )

    client = WorkerClient(base_url=BASE, secret=SECRET)
    out = await run_enrichment(
        worker=client,
        job_id='job_x',
        tenant_id='ten_x',
        namespace_id='ns_x',
        document_id='doc_x',
        version_id='ver_test',
        version_index_id='vidx_x',
        embedding_profile='openai-text-embedding-3-large-1536',
        chunking_profile='generic',
        embedding_dimensions=1536,
        profile=profile,
        request_default_model=None,
        request_pass_overrides={},
        cdm=CanonicalDocument(
            document_id='doc_x',
            version_id='ver_test',
            blocks=[Block(id='p_0', type='paragraph', section_path='/', text='Once upon a time.')],
        ),
        passages=[_passage(0, 'Once upon a time.')],
    )
    # A failed (503 in chat propagates as ENRICHMENT_PASS_FAILED), B was skipped because A is its dep.
    assert out['character_dossier'] == 'failed'
    assert out['theme'] == 'skipped'
    await client.aclose()
