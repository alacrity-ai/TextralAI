"""Clause-aware chunker.

Treats numbered clauses (``1.``, ``1.1``, ``(a)``, etc.) as hard
boundaries. A clause shorter than ``target_tokens`` becomes its own
chunk. A clause longer than ``target_tokens`` falls through to
sliding-window logic but never crosses into another top-level clause.

Each chunk's metadata implicitly carries continuation info via the
section_path (which the underlying CDM normalizers stamp from
heading hierarchy). Adjacent over-sized chunks of the same clause
share an identical ``section_path``.
"""

from __future__ import annotations

import re

from .._chunk_id_guard import assert_chunk_id_size
from ..cdm.model import CanonicalDocument
from ..cdm.tokens import count_tokens, decode, encode
from .generic import Chunk, _section_depth


# Match numbered clause prefixes at line start.
#   1.  / 1.1  / 1.1.2  / (a) / (i)
_CLAUSE_RE = re.compile(
    r'^\s*(?:'
    r'\d+(?:\.\d+)*\.?'        # 1, 1.1, 1.1.2, 1., 1.1.
    r'|\([a-zA-Z0-9]+\)'        # (a), (i), (1)
    r')\s+',
)


def _split_into_clause_units(body: str) -> list[str]:
    """Return one string per clause unit, preserving order."""
    lines = body.splitlines(keepends=True)
    units: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        if _CLAUSE_RE.match(line):
            if current:
                units.append(current)
            current = [line]
        else:
            if current:
                current.append(line)
            else:
                # Pre-amble before any clause marker — treat as its
                # own unit.
                current = [line]
    if current:
        units.append(current)
    return [''.join(unit) for unit in units]


def _chunk_id(version_id: str, ord_n: int) -> str:
    cid = f'chk_{version_id}_{ord_n:05d}'
    assert_chunk_id_size(cid)
    return cid


def _is_boundary(prev: str, nxt: str, depth: int) -> bool:
    if prev == nxt:
        return False
    return _section_depth(prev) <= depth or _section_depth(nxt) <= depth


def chunk_document(
    cdm: CanonicalDocument,
    *,
    target_tokens: int = 500,
    overlap_tokens: int = 50,
    boundary_depth: int = 2,
) -> list[Chunk]:
    chunks: list[Chunk] = []
    ord_counter = 0

    # Group blocks by section, respecting boundary_depth (same as generic).
    groups: list[tuple[str, list[str]]] = []
    current_section: str | None = None
    current_texts: list[str] = []
    for block in cdm.blocks:
        if not block.text.strip():
            continue
        if current_section is None:
            current_section = block.section_path
            current_texts = [block.text]
            continue
        sep = _is_boundary(current_section, block.section_path, boundary_depth)
        if sep:
            groups.append((current_section, current_texts))
            current_section = block.section_path
            current_texts = [block.text]
        else:
            current_texts.append(block.text)
    if current_section is not None and current_texts:
        groups.append((current_section, current_texts))

    for section_path, texts in groups:
        body = '\n\n'.join(texts)
        units = _split_into_clause_units(body)

        for unit in units:
            unit_text = unit.strip()
            if not unit_text:
                continue
            ids = encode(unit_text)
            if not ids:
                continue
            if count_tokens(unit_text) <= target_tokens:
                chunks.append(
                    Chunk(
                        id=_chunk_id(cdm.version_id, ord_counter),
                        ord=ord_counter,
                        section_path=section_path,
                        text=unit_text,
                    ),
                )
                ord_counter += 1
                continue
            # Oversized clause — sliding-window inside the unit.
            i = 0
            step = max(1, target_tokens - overlap_tokens)
            while i < len(ids):
                slice_ids = ids[i : i + target_tokens]
                text = decode(slice_ids)
                if text.strip():
                    chunks.append(
                        Chunk(
                            id=_chunk_id(cdm.version_id, ord_counter),
                            ord=ord_counter,
                            section_path=section_path,
                            text=text,
                        ),
                    )
                    ord_counter += 1
                if i + target_tokens >= len(ids):
                    break
                i += step
    return chunks
