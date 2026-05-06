"""narrative.scene — split sections into scenes by structural markers.

Section-scope. Detects ``* * *`` and blank-line clusters as scene
breaks, emits one artifact per scene with `artifact_type='narrative.scene'`.

Depends on `section_summary` only to ensure ordering; the scene pass
itself does not consume the summaries (yet — Phase 7 may pass them
in for context).
"""

from __future__ import annotations

import re

from ..runner import register_pass
from ..types import EnrichmentArtifact, EnrichmentContext, EnrichmentPass


_SCENE_BREAK = re.compile(r'(?:\s*[\*\-_]\s*){3,}')


class Scene(EnrichmentPass):
    async def run(self, ctx: EnrichmentContext) -> list[EnrichmentArtifact]:
        artifacts: list[EnrichmentArtifact] = []
        sequence = 0
        for ch in ctx.passages:
            scene_pieces = _SCENE_BREAK.split(ch.text)
            for idx, piece in enumerate(scene_pieces):
                stripped = piece.strip()
                if len(stripped) < 60:
                    continue
                artifacts.append(
                    EnrichmentArtifact(
                        artifact_type='narrative.scene',
                        section_path=ch.section_path,
                        text=stripped,
                        metadata={
                            'scene_index_in_section': idx,
                            'sequence': sequence,
                            'source_passage_section_path': ch.section_path,
                        },
                        parent_chunk_id=ch.id,
                        source_chunk_ids=[ch.id],
                    ),
                )
                sequence += 1
        return artifacts


register_pass('scene', Scene)
