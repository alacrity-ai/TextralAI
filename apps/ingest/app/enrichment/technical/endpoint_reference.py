"""technical.endpoint — one artifact per HTTP endpoint or function
reference in a section."""

from __future__ import annotations

import re

from ..runner import register_pass
from ..types import EnrichmentArtifact, EnrichmentContext, EnrichmentPass


# Permissive: look for HTTP method + path.
_HTTP = re.compile(
    r'\b(?P<method>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?P<path>/[A-Za-z0-9_/{}.\-]+)'
)
# Function-call references: foo(bar, baz) or pkg.foo(bar)
_FUNC = re.compile(r'\b(?P<sym>[A-Za-z_][A-Za-z0-9_.]*)\(\s*[A-Za-z0-9_,.\s\'"\-]*\s*\)')


class EndpointReference(EnrichmentPass):
    async def run(self, ctx: EnrichmentContext) -> list[EnrichmentArtifact]:
        artifacts: list[EnrichmentArtifact] = []
        sequence = 0
        for ch in ctx.passages:
            seen: set[str] = set()
            for m in _HTTP.finditer(ch.text):
                key = f'{m.group("method")} {m.group("path")}'
                if key in seen:
                    continue
                seen.add(key)
                artifacts.append(
                    EnrichmentArtifact(
                        artifact_type='technical.endpoint',
                        section_path=ch.section_path,
                        text=key,
                        metadata={
                            'kind': 'http',
                            'method': m.group('method'),
                            'path': m.group('path'),
                            'sequence': sequence,
                        },
                        parent_chunk_id=ch.id,
                        source_chunk_ids=[ch.id],
                    ),
                )
                sequence += 1
            for m in _FUNC.finditer(ch.text):
                sym = m.group('sym')
                if len(sym) < 3 or sym in seen:
                    continue
                seen.add(sym)
                artifacts.append(
                    EnrichmentArtifact(
                        artifact_type='technical.endpoint',
                        section_path=ch.section_path,
                        text=sym + '()',
                        metadata={
                            'kind': 'function',
                            'symbol': sym,
                            'sequence': sequence,
                        },
                        parent_chunk_id=ch.id,
                        source_chunk_ids=[ch.id],
                    ),
                )
                sequence += 1
        return artifacts


register_pass('endpoint_reference', EndpointReference)
