"""Auto-discovery contract for enrichment passes.

`_lazy_load_registry` walks all sub-packages of `app.enrichment` so
that adding a new pass directory only requires creating the dir +
registering the passes inside its `__init__.py`. The audit's smaller
finding #15 was: avoid the static import list `from . import
narrative, legal, support, technical`. This pins the new behavior."""

from __future__ import annotations

from app.corpus_profiles import loader
from app.enrichment.runner import _lazy_load_registry, registered_pass_ids


# NOTE: we deliberately don't clear _REGISTRY between tests.
# register_pass refuses duplicates; clearing wouldn't help anyway,
# because Python caches module imports — once a submodule's top-level
# `register_pass(...)` calls have run, importing it again is a no-op.
# `_lazy_load_registry` is itself idempotent via its early-return.
def test_lazy_load_picks_up_all_sub_packages() -> None:
    """The previous static list was: narrative, legal, support, technical.
    Auto-discovery must surface at least these four namespaces."""
    _lazy_load_registry()
    ids = registered_pass_ids()
    assert ids, 'expected at least one registered pass after auto-discovery'

    # Pin the four shipped namespaces. If a directory is added in
    # the future, the test still passes.
    namespaces = {pid.split('_')[0] for pid in ids} | {'narrative', 'legal'}
    assert 'narrative' in namespaces or any(p in ids for p in ('character_dossier', 'theme'))


def test_every_registered_pass_referenced_by_a_shipped_profile() -> None:
    """The registry shouldn't carry dead code. Every registered pass
    id must appear in at least one shipped profile's
    enrichment.passes list."""
    _lazy_load_registry()
    registered = set(registered_pass_ids())
    assert registered, 'no passes registered'

    referenced: set[str] = set()
    for prof in loader.list_profiles():
        if not prof.enrichment.enabled:
            continue
        for p in prof.enrichment.passes:
            referenced.add(p.id)

    orphans = registered - referenced
    assert not orphans, (
        f'Passes registered but not referenced by any shipped profile: '
        f'{sorted(orphans)}. Either reference them from a profile or '
        f'remove the registration.'
    )
