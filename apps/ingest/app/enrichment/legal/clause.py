"""legal.clause — one clause artifact per passage that the LLM
classifies as containing a numbered/lettered clause.

Chunk-scope. `parent_chunk_id` is the source passage so the clause's
provenance is one hop away.
"""

from __future__ import annotations

import re

from ..runner import register_pass
from ..types import EnrichmentArtifact, EnrichmentContext, EnrichmentPass


_PROMPT = (
    'Extract the contractual clause from the passage below. Reply with one '
    'line of the form:\nCLAUSE: <one-sentence summary>\nTOPIC: <topic>\n'
    'PARTIES: <comma-separated party labels, or "n/a">\n\n'
    'If the passage is not a clause (boilerplate, recitals, definitions only), '
    'reply with the single word: SKIP.\n\nPassage:\n{body}'
)

_CLAUSE_RE = re.compile(
    r'CLAUSE:\s*(?P<clause>[^\n]+)\s*\nTOPIC:\s*(?P<topic>[^\n]+)\s*\nPARTIES:\s*(?P<parties>[^\n]+)',
)


class Clause(EnrichmentPass):
    async def run(self, ctx: EnrichmentContext) -> list[EnrichmentArtifact]:
        artifacts: list[EnrichmentArtifact] = []
        for ch in ctx.passages:
            text, _usage = await ctx.chat(_PROMPT.format(body=ch.text))
            stripped = text.strip()
            if stripped.upper().startswith('SKIP'):
                continue
            m = _CLAUSE_RE.search(stripped)
            if not m:
                continue
            parties_raw = m.group('parties').strip()
            parties = (
                []
                if parties_raw.lower() in ('n/a', 'na', 'none')
                else [p.strip() for p in parties_raw.split(',') if p.strip()]
            )
            artifacts.append(
                EnrichmentArtifact(
                    artifact_type='legal.clause',
                    section_path=ch.section_path,
                    text=m.group('clause').strip(),
                    metadata={
                        'clause_topic': m.group('topic').strip(),
                        'parties_referenced': parties,
                    },
                    parent_chunk_id=ch.id,
                    source_chunk_ids=[ch.id],
                ),
            )
        return artifacts


register_pass('clause_extraction', Clause)
