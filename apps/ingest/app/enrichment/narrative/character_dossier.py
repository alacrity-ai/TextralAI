"""narrative.character_dossier — one dossier per named character.

Document-scope. The pass concatenates the (possibly truncated)
passage list, asks the LLM to enumerate named characters with a
short description of each, and emits one artifact per character.

`source_chunk_ids` is mandatory for document-scope synthesis: it's
how downstream queries trace a dossier statement back to its evidence.
"""

from __future__ import annotations

import re

from ..runner import register_pass
from ..types import EnrichmentArtifact, EnrichmentContext, EnrichmentPass


_PROMPT = (
    'List the named characters appearing in the following narrative. For each '
    'character, provide one paragraph of biographical detail and role in the '
    'plot. Format each entry as:\n\n'
    'NAME: <character name>\n'
    'ROLE: <role description>\n'
    '---\n\n'
    'Narrative:\n{body}'
)

_ENTRY = re.compile(
    r'NAME:\s*(?P<name>[^\n]+?)\s*\nROLE:\s*(?P<role>.+?)(?=\n---|\Z)',
    re.DOTALL,
)


class CharacterDossier(EnrichmentPass):
    async def run(self, ctx: EnrichmentContext) -> list[EnrichmentArtifact]:
        body = '\n\n'.join(p.text for p in ctx.passages)
        if not body.strip():
            return []
        text, _usage = await ctx.chat(_PROMPT.format(body=body))
        artifacts: list[EnrichmentArtifact] = []
        for m in _ENTRY.finditer(text):
            name = m.group('name').strip()
            role = m.group('role').strip()
            if not name or not role:
                continue
            artifacts.append(
                EnrichmentArtifact(
                    artifact_type='narrative.character_dossier',
                    section_path='/',
                    text=f'{name}: {role}',
                    metadata={
                        'character_name': name,
                        'first_appearance_section_path': ctx.passages[0].section_path
                        if ctx.passages else '/',
                    },
                    parent_chunk_id=None,
                    source_chunk_ids=[p.id for p in ctx.passages],
                ),
            )
        return artifacts


register_pass('character_dossier', CharacterDossier)
