"""legal.obligation — extract obligations across the document, citing
the clauses they reference.

Document-scope. Depends on `clause_extraction`. Pulls upstream
clause artifacts from `ctx.upstream_artifacts` rather than re-LLMing
them.
"""

from __future__ import annotations

import re

from ..runner import register_pass
from ..types import EnrichmentArtifact, EnrichmentContext, EnrichmentPass


_PROMPT = (
    'List the obligations imposed by this contract. For each, name the '
    'obligated party, the action required, and the type (one of: payment, '
    'notice, delivery, performance, other). Format each entry as:\n\n'
    'PARTY: <party>\nACTION: <action>\nTYPE: <type>\n---\n\n'
    'Document text:\n{body}'
)

_ENTRY = re.compile(
    r'PARTY:\s*(?P<party>[^\n]+?)\s*\nACTION:\s*(?P<action>[^\n]+?)\s*\nTYPE:\s*(?P<type>[^\n]+)',
)


class Obligation(EnrichmentPass):
    async def run(self, ctx: EnrichmentContext) -> list[EnrichmentArtifact]:
        body = '\n\n'.join(p.text for p in ctx.passages)
        if not body.strip():
            return []
        text, _usage = await ctx.chat(_PROMPT.format(body=body))
        upstream_clauses = ctx.upstream_artifacts.get('clause_extraction', [])
        clause_ids = [c.parent_chunk_id for c in upstream_clauses if c.parent_chunk_id]
        artifacts: list[EnrichmentArtifact] = []
        for m in _ENTRY.finditer(text):
            party = m.group('party').strip()
            action = m.group('action').strip()
            type_ = m.group('type').strip().lower()
            artifacts.append(
                EnrichmentArtifact(
                    artifact_type='legal.obligation',
                    section_path='/',
                    text=f'{party}: {action}',
                    metadata={
                        'obligation_type': type_,
                        'party': party,
                        'clauses_cited': clause_ids,
                    },
                    parent_chunk_id=None,
                    source_chunk_ids=[p.id for p in ctx.passages],
                ),
            )
        return artifacts


register_pass('obligation_extraction', Obligation)
