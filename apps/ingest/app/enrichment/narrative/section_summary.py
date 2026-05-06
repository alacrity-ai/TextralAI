"""narrative.section_summary — one summary per section path.

Section-scope. For each section_path at depth ≤ 2 the chunker
respected, concatenate the passages and ask the LLM for a 2-4
sentence summary. The result becomes one artifact of
`artifact_type='narrative.section_summary'`.

`parent_chunk_id` is intentionally NULL — the summary spans multiple
passages, no single parent. Lineage lives in `source_chunk_ids`.
"""

from __future__ import annotations

from collections import OrderedDict

from ..runner import register_pass
from ..types import EnrichmentArtifact, EnrichmentContext, EnrichmentPass


_MIN_SECTION_TOKENS = 50
_PROMPT = (
    'Summarize the following passages in 2 to 4 sentences. Preserve key entities '
    'and any numeric facts; avoid speculation.\n\nPassages:\n{body}'
)


def _group_by_section(
    passages: list,  # list[Chunk]
    boundary_depth: int = 2,
) -> 'OrderedDict[str, list]':
    """Adjacent passages sharing the same section_path go in one
    group. The boundary semantics match chunk.py's grouping rule."""
    groups: 'OrderedDict[str, list]' = OrderedDict()
    for ch in passages:
        groups.setdefault(ch.section_path, []).append(ch)
    return groups


class SectionSummary(EnrichmentPass):
    async def run(self, ctx: EnrichmentContext) -> list[EnrichmentArtifact]:
        artifacts: list[EnrichmentArtifact] = []
        groups = _group_by_section(ctx.passages)
        for section_path, chunks_in_section in groups.items():
            body = '\n\n'.join(c.text for c in chunks_in_section)
            if len(body.split()) < _MIN_SECTION_TOKENS // 4:
                # Too short to be worth summarizing. Skip silently.
                continue
            text, _usage = await ctx.chat(_PROMPT.format(body=body))
            text = text.strip()
            if not text:
                continue
            artifacts.append(
                EnrichmentArtifact(
                    artifact_type='narrative.section_summary',
                    section_path=section_path,
                    text=text,
                    metadata={'section_path': section_path, 'passage_count': len(chunks_in_section)},
                    parent_chunk_id=None,
                    source_chunk_ids=[c.id for c in chunks_in_section],
                ),
            )
        return artifacts


register_pass('section_summary', SectionSummary)
