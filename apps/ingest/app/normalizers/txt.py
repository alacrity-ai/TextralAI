"""Plain text normalizer. Splits on blank lines into paragraphs."""

from __future__ import annotations

import re

from ..cdm.model import Block, CanonicalDocument


def normalize_txt(document_id: str, version_id: str, raw: str) -> CanonicalDocument:
    blocks: list[Block] = []
    paras = re.split(r"\n\s*\n+", raw.strip())
    for i, para in enumerate(paras):
        text = para.strip()
        if not text:
            continue
        blocks.append(
            Block(
                id=f"p_{i:04d}",
                type="paragraph",
                section_path="/",
                text=text,
            ),
        )
    return CanonicalDocument(
        document_id=document_id,
        version_id=version_id,
        blocks=blocks,
    )
