"""Enrichment runner.

Topo-sorts profile passes, dispatches each via the registry, embeds +
indexes the artifacts via the same /internal/providers/embed +
/internal/chunks/batch flow Phase 3 ships, and records per-pass
attempts under stage='enrich.<pass_id>'.

Failure modes:
  * required pass raises → re-raised; the outer job_runner catches
    and converts to a fatal stage failure.
  * optional pass raises → logged, outcomes[pass_id]='failed', the
    runner continues to the next pass.
  * upstream dependency failed/skipped → outcomes[pass_id]='skipped'.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections import defaultdict
from typing import Any, Callable

from .._chunk_id_guard import assert_chunk_id_size
from ..cdm.tokens import count_tokens
from ..chunkers.generic import Chunk
from ..clients.worker import WorkerClient
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


def registered_pass_ids() -> list[str]:
    return sorted(_REGISTRY.keys())


def get_pass(pass_id: str) -> EnrichmentPass:
    if pass_id not in _REGISTRY:
        raise RuntimeError(f'Pass not registered: {pass_id}')
    return _REGISTRY[pass_id]()


# Auto-discover submodule imports. Each submodule's __init__.py calls
# register_pass(...) for the passes it defines. We don't import the
# submodules at the top of this file because they import from this
# module — circular import risk. Walk the package tree at runtime so
# that adding a new pass directory only requires creating the dir,
# not editing this list.
def _lazy_load_registry() -> None:
    if _REGISTRY:
        return
    import importlib
    import pkgutil
    pkg = importlib.import_module(__package__)
    for mod_info in pkgutil.iter_modules(pkg.__path__):
        if not mod_info.ispkg:
            # Top-level modules under enrichment/ (runner.py, types.py,
            # __init__.py). Skip — only sub-packages register passes.
            continue
        importlib.import_module(f'{__package__}.{mod_info.name}')


def _topo_sort(passes: list[EnrichmentPassDef]) -> list[EnrichmentPassDef]:
    """Kahn's algorithm. Cycles raise."""
    indeg: dict[str, int] = {p.id: 0 for p in passes}
    deps: dict[str, list[str]] = defaultdict(list)
    for p in passes:
        for d in p.depends_on:
            if d in indeg:
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
    """Resolve in this strict order (request beats profile):

      1. request.enrichment.passes[pass_id].model
      2. request.enrichment.default_model
      3. profile.enrichment.passes[pass_id].model
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
    raise RuntimeError(f'No model resolvable for enrichment pass {pass_def.id}')


def _artifact_chunk_id(version_id: str, pass_id: str, sequence: int) -> str:
    """Deterministic, short, replay-safe chunk id for enrichment
    artifacts. Format: ``chk_<version_id>_e<8-hex-hash>``.

    Total length: 4 + 30 + 1 + 8 = 43 chars (well under Vectorize's
    64-byte ID cap). The hash is sha256 of the unique triple, so
    re-runs with the same inputs produce the same id.
    """
    h = hashlib.sha256(f'{version_id}:{pass_id}:{sequence}'.encode('utf-8')).hexdigest()[:8]
    cid = f'chk_{version_id}_e{h}'
    assert_chunk_id_size(cid)
    return cid


async def _stage_attempt(
    worker: WorkerClient,
    job_id: str,
    stage: str,
    status: str,
    *,
    started_at: int,
    completed_at: int | None = None,
    metadata: dict | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
    attempt: int = 1,
) -> None:
    body: dict[str, Any] = {
        'stage': stage,
        'attempt': attempt,
        'status': status,
        'started_at': started_at,
    }
    if completed_at is not None:
        body['completed_at'] = completed_at
        body['duration_ms'] = completed_at - started_at
    if metadata is not None:
        body['metadata'] = metadata
    if error_code is not None:
        body['error_code'] = error_code
    if error_message is not None:
        body['error_message'] = error_message
    await worker.post_json(f'/internal/jobs/{job_id}/stage-attempt', body)


async def _index_artifacts(
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
    pass_def: EnrichmentPassDef,
    artifacts: list[EnrichmentArtifact],
) -> tuple[int, int]:
    """Embed + index a list of artifacts. Returns (indexed, missing)."""
    if not artifacts:
        return 0, 0

    # Embed all texts in one /internal/providers/embed call (the route
    # batches internally per provider limits).
    texts = [a.text for a in artifacts]
    embed_res = await worker.post_json(
        '/internal/providers/embed',
        {'job_id': job_id, 'input': texts},
    )
    vectors = embed_res.get('vectors', [])
    request_id = embed_res.get('request_id')

    chunk_records: list[dict[str, Any]] = []
    upsert_records: list[dict[str, Any]] = []
    missing = 0
    for idx, art in enumerate(artifacts):
        chunk_id = _artifact_chunk_id(version_id, pass_def.id, idx)
        embedded = idx < len(vectors)
        if not embedded:
            missing += 1
        merged_metadata = dict(art.metadata)
        if art.source_chunk_ids:
            merged_metadata['source_chunk_ids'] = list(art.source_chunk_ids)
        merged_metadata['sequence'] = idx
        text_hash = hashlib.sha256(art.text.encode('utf-8')).hexdigest()
        chunk_records.append(
            {
                'id': chunk_id,
                'tenant_id': tenant_id,
                'namespace_id': namespace_id,
                'document_id': document_id,
                'version_id': version_id,
                'version_index_id': version_index_id,
                'artifact_type': art.artifact_type,
                'section_path': art.section_path,
                'ord': idx,
                'text': art.text,
                'metadata': merged_metadata,
                'embedding_profile': embedding_profile,
                'chunking_profile': chunking_profile,
                'embedding_status': 'embedded' if embedded else 'missing',
                'embedding_input_hash': text_hash,
                'embedding_provider_request_id': request_id if embedded else None,
                'embedding_dimensions': embedding_dimensions if embedded else None,
                'parent_chunk_id': art.parent_chunk_id,
                'enrichment_pass_id': pass_def.id,
            },
        )
        if embedded:
            upsert_records.append(
                {
                    'id': chunk_id,
                    'values': vectors[idx],
                    'metadata': {
                        'tenant_id': tenant_id,
                        'namespace_id': namespace_id,
                        'document_id': document_id,
                        'version_id': version_id,
                        'version_index_id': version_index_id,
                        'artifact_type': art.artifact_type,
                    },
                },
            )

    # Batch the writes (D1 binding limits at ~5000 statements; we
    # send N=200 at a time to leave headroom).
    inserted = 0
    for i in range(0, len(chunk_records), 200):
        batch = chunk_records[i : i + 200]
        res = await worker.post_json(
            '/internal/chunks/batch',
            {'job_id': job_id, 'chunks': batch},
        )
        inserted += int(res.get('inserted', len(batch)))

    for i in range(0, len(upsert_records), 200):
        batch = upsert_records[i : i + 200]
        await worker.post_json(
            '/internal/vectorize/upsert',
            {'job_id': job_id, 'vectors': batch},
        )

    return inserted, missing


def _build_chat_callable(
    worker: WorkerClient,
    *,
    job_id: str,
    model: InferenceModelRef,
):
    """Currently a placeholder. Full chat plumbing is a Phase 6 wiring
    item; for the runner skeleton we expose a callable that the passes
    will use once the back-channel exposes /internal/providers/chat
    (mirrors /internal/providers/embed)."""

    async def chat(prompt: str) -> tuple[str, dict]:
        res = await worker.post_json(
            '/internal/providers/chat',
            {
                'job_id': job_id,
                'messages': [{'role': 'user', 'content': prompt}],
                'model_override': {
                    'provider': model.provider,
                    'model': model.model,
                    **({'provider_key_ref': model.provider_key_ref} if model.provider_key_ref else {}),
                },
            },
        )
        text = res.get('content') or ''
        usage = res.get('usage') or {}
        return text, usage

    return chat


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
    cdm: Any,           # CanonicalDocument; typed loose to dodge cycles
    passages: list[Chunk],
) -> dict[str, str]:
    """Returns {pass_id: 'completed' | 'skipped' | 'failed'}."""
    if not profile.enrichment.enabled or not profile.enrichment.passes:
        return {}

    _lazy_load_registry()

    ordered = _topo_sort(profile.enrichment.passes)
    upstream: dict[str, list[EnrichmentArtifact]] = {}
    outcomes: dict[str, str] = {}

    for pass_def in ordered:
        # Skip if any dependency failed/was skipped.
        bad_deps = [
            d for d in pass_def.depends_on
            if outcomes.get(d) in (None, 'failed', 'skipped')
        ]
        if bad_deps:
            outcomes[pass_def.id] = 'skipped'
            await _stage_attempt(
                worker,
                job_id,
                f'enrich.{pass_def.id}',
                'skipped',
                started_at=int(time.time() * 1000),
                metadata={'reason': 'upstream dependency failed or skipped', 'deps': bad_deps},
            )
            continue

        started_at = int(time.time() * 1000)
        await _stage_attempt(
            worker, job_id, f'enrich.{pass_def.id}', 'started', started_at=started_at,
        )

        try:
            resolved_model = _resolve_pass_model(
                pass_def, profile, request_pass_overrides, request_default_model,
            )
            chat = _build_chat_callable(worker, job_id=job_id, model=resolved_model)
            ctx = EnrichmentContext(
                cdm=cdm,
                passages=passages,
                profile_id=profile.id,
                pass_def=pass_def,
                resolved_model=resolved_model,
                chat=chat,
                upstream_artifacts=upstream,
            )
            handler = get_pass(pass_def.id)

            # Document-scope input cap. The pass itself decides what to
            # do with the cap (map_reduce / truncate / fail); the
            # runner just makes the cap *discoverable* via
            # ctx.pass_def.max_input_tokens. For the truncate strategy
            # we expose a pre-truncated passage list to the pass.
            if pass_def.scope == 'document':
                budget = pass_def.max_input_tokens
                running = 0
                truncated_passages: list[Chunk] = []
                for ch in passages:
                    cost = count_tokens(ch.text)
                    if running + cost > budget:
                        if pass_def.oversize_strategy == 'fail':
                            raise RuntimeError(
                                f'INPUT_TOO_LARGE_FOR_PASS: pass={pass_def.id} '
                                f'budget={budget} actual≥{running + cost}'
                            )
                        if pass_def.oversize_strategy == 'truncate':
                            break
                        # map_reduce: pass sees full list; pass author
                        # implements partial+combine. We pass through
                        # the full list and the pass decides what to do.
                    truncated_passages.append(ch)
                    running += cost
                if pass_def.oversize_strategy == 'truncate':
                    ctx = EnrichmentContext(
                        cdm=cdm,
                        passages=truncated_passages,
                        profile_id=profile.id,
                        pass_def=pass_def,
                        resolved_model=resolved_model,
                        chat=chat,
                        upstream_artifacts=upstream,
                    )

            artifacts = await handler.run(ctx)

            indexed, missing = await _index_artifacts(
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
                worker,
                job_id,
                f'enrich.{pass_def.id}',
                'completed',
                started_at=started_at,
                completed_at=int(time.time() * 1000),
                metadata={
                    'artifact_count': len(artifacts),
                    'indexed': indexed,
                    'missing': missing,
                },
            )
        except Exception as e:  # noqa: BLE001
            error_code = 'INPUT_TOO_LARGE_FOR_PASS' if 'INPUT_TOO_LARGE_FOR_PASS' in str(e) else 'ENRICHMENT_PASS_FAILED'
            await _stage_attempt(
                worker,
                job_id,
                f'enrich.{pass_def.id}',
                'failed',
                started_at=started_at,
                completed_at=int(time.time() * 1000),
                error_code=error_code,
                error_message=str(e),
            )
            if pass_def.required:
                raise
            outcomes[pass_def.id] = 'failed'

    # Don't leave noisy unused.
    _ = asyncio  # silence unused import (kept for potential gather() patterns)
    return outcomes
