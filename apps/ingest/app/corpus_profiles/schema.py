"""Pydantic mirror of packages/corpus-profiles/src/schema.ts.

!! MIRRORED in packages/corpus-profiles/src/schema.ts (Zod) —
any change here MUST land in the Zod mirror in the same PR. The
parity test enforces it; the convention is documented in
packages/corpus-profiles/README.md.

The parity test (tests/test_profile_parity.py) loads every shipped
profile through both validators and asserts structural equivalence.
Drift between Zod and Pydantic shows up there as a diff.
"""

from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


_PASS_ID_RE = re.compile(r'^[a-z][a-z0-9_]*$')


class _Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


ChunkerId = Literal['generic', 'code_aware', 'legal_clause_aware']
ProviderName = Literal['openai', 'anthropic', 'workers_ai', 'cohere', 'voyage']
RerankProvider = Literal['voyage', 'cohere']


class ChunkingProfileConfig(_Strict):
    profile: ChunkerId = 'generic'
    target_tokens: int = 600
    overlap_tokens: int = 80
    boundary_depth: int = 2


class InferenceModelRef(_Strict):
    provider: ProviderName
    model: str
    provider_key_ref: Optional[str] = None


class EnrichmentPassDef(_Strict):
    id: str
    scope: Literal['chunk', 'section', 'document']
    required: bool = False
    depends_on: list[str] = Field(default_factory=list)
    model: Optional[InferenceModelRef] = None
    artifact_namespace: str
    produces: list[str]
    max_input_tokens: int = 100_000
    oversize_strategy: Literal['map_reduce', 'truncate', 'fail'] = 'map_reduce'

    @field_validator('id')
    @classmethod
    def _valid_pass_id(cls, v: str) -> str:
        if not _PASS_ID_RE.match(v):
            raise ValueError(f'pass id must be snake_case, no dot: {v!r}')
        return v

    @field_validator('depends_on')
    @classmethod
    def _valid_depends(cls, v: list[str]) -> list[str]:
        for d in v:
            if not _PASS_ID_RE.match(d):
                raise ValueError(f'depends_on entry must be snake_case, no dot: {d!r}')
        return v

    @model_validator(mode='after')
    def _produces_match_namespace(self) -> 'EnrichmentPassDef':
        prefix = f'{self.artifact_namespace}.'
        for at in self.produces:
            if not at.startswith(prefix):
                raise ValueError(f'produces[{at}] must start with {prefix}')
        return self


class RerankConfig(_Strict):
    enabled: bool
    provider: Optional[RerankProvider] = None
    model: Optional[str] = None
    top_n: int = 12
    provider_key_ref: Optional[str] = None

    @model_validator(mode='after')
    def _required_when_enabled(self) -> 'RerankConfig':
        if self.enabled:
            if not self.provider:
                raise ValueError('rerank.provider is required when enabled')
            if not self.model:
                raise ValueError('rerank.model is required when enabled')
        return self


class RetrievalDefaults(_Strict):
    strategy: Literal['hybrid_rrf'] = 'hybrid_rrf'
    artifact_types: list[str]
    rerank: RerankConfig
    layer_budgets: dict[str, float] = Field(default_factory=dict)
    layer_order: list[str] = Field(default_factory=list)


class PromptDefaults(_Strict):
    system: Optional[str] = None
    developer: Optional[str] = None


class EnrichmentSection(_Strict):
    enabled: bool = False
    default_model: Optional[InferenceModelRef] = None
    passes: list[EnrichmentPassDef] = Field(default_factory=list)


class CorpusProfile(_Strict):
    id: str
    description: Optional[str] = None
    chunking: ChunkingProfileConfig
    enrichment: EnrichmentSection
    retrieval_defaults: RetrievalDefaults
    prompt_defaults: PromptDefaults = Field(default_factory=PromptDefaults)
