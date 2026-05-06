"""Generic chunker.

Sliding window: target tokens / overlap tokens, never crosses a major
section boundary (heading depth ≤ boundary_depth). Section path stamped
on every chunk; `ord` is monotonic per version.

Chunk ID format is deterministic + human-debuggable:
  chk_<version_id>_<5-digit zero-padded ord>"""

from __future__ import annotations

from dataclasses import dataclass

from .._chunk_id_guard import assert_chunk_id_size
from ..cdm.model import CanonicalDocument
from ..cdm.tokens import count_tokens, decode, encode


@dataclass
class Chunk:
    id: str
    ord: int
    section_path: str
    text: str


def _section_depth(path: str) -> int:
    if path == "/" or path == "":
        return 0
    return len([s for s in path.split("/") if s])


def chunk_document(
    cdm: CanonicalDocument,
    *,
    target_tokens: int = 600,
    overlap_tokens: int = 80,
    boundary_depth: int = 2,
) -> list[Chunk]:
    """Token-budgeted chunker. Boundaries:
       - never crosses a section transition where either side has
         depth ≤ boundary_depth (i.e. a major heading boundary).
       - within a section: greedy fill to target_tokens, with
         `overlap_tokens` carried into the next chunk."""

    chunks: list[Chunk] = []
    ord_counter = 0

    # Group blocks by section, respecting boundary_depth: any time a
    # block's section path differs from the prior one AND either side
    # is at depth ≤ boundary_depth, that's a hard split point.
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
        body = "\n\n".join(texts)
        ids = encode(body)
        if not ids:
            continue
        if count_tokens(body) <= target_tokens:
            chunks.append(
                Chunk(
                    id=_chunk_id(cdm.version_id, ord_counter),
                    ord=ord_counter,
                    section_path=section_path,
                    text=body,
                ),
            )
            ord_counter += 1
            continue
        # Sliding window over token IDs.
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


def _is_boundary(prev: str, nxt: str, depth: int) -> bool:
    if prev == nxt:
        return False
    return _section_depth(prev) <= depth or _section_depth(nxt) <= depth


def _chunk_id(version_id: str, ord_n: int) -> str:
    cid = f"chk_{version_id}_{ord_n:05d}"
    assert_chunk_id_size(cid)
    return cid
