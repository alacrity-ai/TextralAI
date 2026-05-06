"""YAML loader for corpus profiles.

Container deploys COPY packages/corpus-profiles/profiles/*.yaml into
the image at /app/profiles. Tests can override with the
TEXTRAL_CORPUS_PROFILES_DIR env var. The loader walks several
candidate paths to be robust against WORKDIR layout drift.
"""

from __future__ import annotations

import os
from pathlib import Path

import yaml

from .schema import CorpusProfile


def _candidate_dirs() -> list[Path]:
    """Search order:

    1. ``TEXTRAL_CORPUS_PROFILES_DIR`` env var (explicit override —
       honored first so tests and ad-hoc local runs can point at any
       location).
    2. ``<cwd>/profiles`` — Container layout: WORKDIR is /app and the
       Dockerfile COPYs profiles to ./profiles.
    3. parents-of-this-file walk: from app/corpus_profiles/loader.py,
       the YAMLs live one or two parents up depending on WORKDIR
       semantics. Tries both.
    4. Workspace fallback for local pytest runs:
       ../../../packages/corpus-profiles/profiles relative to this file.
    """
    candidates: list[Path] = []
    env_override = os.environ.get('TEXTRAL_CORPUS_PROFILES_DIR')
    if env_override:
        candidates.append(Path(env_override))
    candidates.append(Path.cwd() / 'profiles')
    here = Path(__file__).resolve()
    candidates.append(here.parents[2] / 'profiles')   # WORKDIR=/app, COPY app ./app
    candidates.append(here.parents[1] / 'profiles')   # WORKDIR=/app, COPY app/* .
    # Workspace local fallback: apps/ingest/app/corpus_profiles/loader.py
    # → repo root is parents[4]; profiles live at packages/corpus-profiles/profiles.
    candidates.append(here.parents[4] / 'packages' / 'corpus-profiles' / 'profiles')
    return candidates


def _resolve_profiles_dir() -> Path:
    for candidate in _candidate_dirs():
        if candidate.is_dir():
            return candidate
    raise RuntimeError(
        'Corpus profiles directory not found in any of: '
        + ', '.join(str(c) for c in _candidate_dirs())
    )


_REGISTRY: dict[str, CorpusProfile] = {}


def _load_all() -> None:
    if _REGISTRY:
        return
    profiles_dir = _resolve_profiles_dir()
    yaml_files = sorted(profiles_dir.glob('*.yaml'))
    if not yaml_files:
        raise RuntimeError(f'No profile YAMLs in {profiles_dir}')
    for yaml_path in yaml_files:
        raw = yaml.safe_load(yaml_path.read_text(encoding='utf-8'))
        try:
            profile = CorpusProfile.model_validate(raw)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f'Invalid corpus profile {yaml_path.name}: {e}') from e
        if profile.id in _REGISTRY:
            raise RuntimeError(f'Duplicate corpus profile id: {profile.id}')
        _REGISTRY[profile.id] = profile
    if 'generic' not in _REGISTRY:
        raise RuntimeError('Missing required profile: generic')


def reset() -> None:
    """Test helper: drop the registry so the next call re-loads."""
    _REGISTRY.clear()


def get_profile(profile_id: str) -> CorpusProfile | None:
    _load_all()
    return _REGISTRY.get(profile_id)


def get_profile_or_raise(profile_id: str) -> CorpusProfile:
    p = get_profile(profile_id)
    if p is None:
        known = ', '.join(sorted(_REGISTRY.keys()))
        raise RuntimeError(f'Unknown corpus profile: {profile_id}. Known: {known}')
    return p


def list_profiles() -> list[CorpusProfile]:
    _load_all()
    return list(_REGISTRY.values())
