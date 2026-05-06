"""support.troubleshooting_step — one artifact per imperative or
numbered step in a section."""

from __future__ import annotations

import re

from ..runner import register_pass
from ..types import EnrichmentArtifact, EnrichmentContext, EnrichmentPass


_NUMBERED = re.compile(r'^\s*(?:\d+\.|\d+\)|[-*])\s+(.+?)\s*$', re.MULTILINE)
_IMPERATIVE_VERBS = (
    'click',
    'open',
    'select',
    'choose',
    'enter',
    'type',
    'press',
    'restart',
    'check',
    'verify',
    'install',
    'uninstall',
    'update',
    'log in',
    'sign in',
    'navigate',
)


def _is_imperative(line: str) -> bool:
    head = line.strip().lower()
    return any(head.startswith(v) for v in _IMPERATIVE_VERBS)


class TroubleshootingStep(EnrichmentPass):
    async def run(self, ctx: EnrichmentContext) -> list[EnrichmentArtifact]:
        artifacts: list[EnrichmentArtifact] = []
        sequence = 0
        for ch in ctx.passages:
            collected: list[str] = []
            for m in _NUMBERED.finditer(ch.text):
                collected.append(m.group(1).strip())
            for line in ch.text.splitlines():
                stripped = line.strip()
                if stripped and _is_imperative(stripped) and stripped not in collected:
                    collected.append(stripped)
            for step_text in collected:
                if len(step_text) < 8:
                    continue
                artifacts.append(
                    EnrichmentArtifact(
                        artifact_type='support.step',
                        section_path=ch.section_path,
                        text=step_text,
                        metadata={'sequence': sequence},
                        parent_chunk_id=ch.id,
                        source_chunk_ids=[ch.id],
                    ),
                )
                sequence += 1
        return artifacts


register_pass('troubleshooting_step', TroubleshootingStep)
