"""narrative.theme — up to 5 thematic statements per document.

Document-scope. Depends on `character_dossier` so the prompt can
reference the cast.
"""

from __future__ import annotations

import re

from ..runner import register_pass
from ..types import EnrichmentArtifact, EnrichmentContext, EnrichmentPass


_PROMPT = (
    'Identify up to 5 major themes in the following narrative. Number each '
    'theme and give a single concise sentence describing it. Do not pad with '
    'commentary.\n\n'
    'Format:\n1. <theme>\n2. <theme>\n...\n\n'
    'Narrative:\n{body}'
)

_LINE = re.compile(r'^\s*(\d+)[.)]\s*(.+?)\s*$', re.MULTILINE)


class Theme(EnrichmentPass):
    async def run(self, ctx: EnrichmentContext) -> list[EnrichmentArtifact]:
        body = '\n\n'.join(p.text for p in ctx.passages)
        if not body.strip():
            return []
        text, _usage = await ctx.chat(_PROMPT.format(body=body))
        artifacts: list[EnrichmentArtifact] = []
        for m in _LINE.finditer(text):
            theme_text = m.group(2).strip()
            if not theme_text:
                continue
            artifacts.append(
                EnrichmentArtifact(
                    artifact_type='narrative.theme',
                    section_path='/',
                    text=theme_text,
                    metadata={'theme_index': int(m.group(1))},
                    parent_chunk_id=None,
                    source_chunk_ids=[p.id for p in ctx.passages],
                ),
            )
        return artifacts[:5]


register_pass('theme', Theme)
