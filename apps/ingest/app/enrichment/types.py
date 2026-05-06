"""Enrichment pass interface.

Passes produce text-only artifacts. The runner owns transport
(provider/embed/index) and persistence. Pass authors write pure
text-extraction logic; they don't touch the Worker back-channel.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol

from ..cdm.model import CanonicalDocument
from ..chunkers.generic import Chunk
from ..corpus_profiles.schema import EnrichmentPassDef, InferenceModelRef


@dataclass
class EnrichmentArtifact:
    """One artifact produced by a pass.

    Becomes a `chunks` row with `artifact_type` set; embedded +
    indexed by the runner via /internal/providers/embed and
    /internal/chunks/batch.
    """

    artifact_type: str
    section_path: str
    text: str
    metadata: dict
    # Chunk- and section-scope artifacts that derive from a single
    # parent passage set this to the source chunk id. NULL for
    # passages and document-scope artifacts.
    parent_chunk_id: str | None = None
    # Document-scope synthesis lineage. A character_dossier or theme
    # is a synthesized statement that summarizes across many passages;
    # this list names them, so the citation chain stays auditable
    # even when parent_chunk_id is NULL. The runner serializes this
    # into the chunk row's metadata JSON before indexing.
    source_chunk_ids: list[str] = field(default_factory=list)


@dataclass
class EnrichmentContext:
    """Inputs the runner hands to a pass.

    `passages` is always the full Layer-1 chunk list (read-only); a
    pass-scope filter (chunk / section / document) determines which
    subset the pass actually iterates.

    `chat` is a thin callable for the resolved model. The runner
    constructs it before invoking the pass; passes never touch the
    Worker client directly.
    """

    cdm: CanonicalDocument
    passages: list[Chunk]
    profile_id: str
    pass_def: EnrichmentPassDef
    resolved_model: InferenceModelRef
    chat: Callable[[str], Awaitable[tuple[str, dict]]]
    # Other pass outputs already produced this run (keyed by pass id).
    upstream_artifacts: dict[str, list[EnrichmentArtifact]] = field(default_factory=dict)


class EnrichmentPass(Protocol):
    """Pure text-extraction. The runner owns transport + persistence."""

    async def run(self, ctx: EnrichmentContext) -> list[EnrichmentArtifact]: ...
