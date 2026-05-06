"""Mirror of packages/corpus-profiles/src/merge.ts.

Deep merge: scalars and objects from `override` win; arrays replace
wholesale (no concatenation). Footgun: overriding ``enrichment.passes``
replaces the profile's pass list entirely.
"""

from __future__ import annotations

from typing import Any

from .schema import CorpusProfile, EnrichmentPassDef, EnrichmentSection, InferenceModelRef


def merge_profile(base: CorpusProfile, override: dict[str, Any] | None) -> CorpusProfile:
    if not override:
        return base
    merged: dict[str, Any] = base.model_dump()

    if 'chunking' in override and isinstance(override['chunking'], dict):
        merged['chunking'] = {**merged['chunking'], **override['chunking']}

    if 'enrichment' in override and isinstance(override['enrichment'], dict):
        e_over = override['enrichment']
        merged_e: dict[str, Any] = dict(merged['enrichment'])
        if 'enabled' in e_over:
            merged_e['enabled'] = e_over['enabled']
        if 'default_model' in e_over:
            merged_e['default_model'] = e_over['default_model']
        if 'passes' in e_over:
            merged_e['passes'] = e_over['passes']
        merged['enrichment'] = merged_e

    if 'retrieval_defaults' in override and isinstance(override['retrieval_defaults'], dict):
        r_over = override['retrieval_defaults']
        merged_r: dict[str, Any] = dict(merged['retrieval_defaults'])
        for scalar_or_array_key in ('strategy', 'artifact_types', 'layer_order'):
            if scalar_or_array_key in r_over:
                merged_r[scalar_or_array_key] = r_over[scalar_or_array_key]
        if 'rerank' in r_over and isinstance(r_over['rerank'], dict):
            merged_r['rerank'] = {**merged_r['rerank'], **r_over['rerank']}
        if 'layer_budgets' in r_over and isinstance(r_over['layer_budgets'], dict):
            merged_r['layer_budgets'] = {
                **merged_r['layer_budgets'],
                **r_over['layer_budgets'],
            }
        merged['retrieval_defaults'] = merged_r

    if 'prompt_defaults' in override and isinstance(override['prompt_defaults'], dict):
        merged['prompt_defaults'] = {
            **merged['prompt_defaults'],
            **override['prompt_defaults'],
        }
    return CorpusProfile.model_validate(merged)


__all__ = ['merge_profile', 'CorpusProfile', 'EnrichmentPassDef', 'EnrichmentSection', 'InferenceModelRef']
