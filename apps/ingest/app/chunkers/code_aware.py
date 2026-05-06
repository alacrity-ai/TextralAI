"""Code-aware chunker.

Same sliding-window budget logic as the generic chunker, but the
boundary detector knows about Markdown fenced code blocks and refuses
to split inside one. If a fenced block is itself larger than
``target_tokens``, the chunk contains the whole block (overrides the
budget for that one chunk rather than truncating mid-language).
"""

from __future__ import annotations

import re

from .._chunk_id_guard import assert_chunk_id_size
from ..cdm.model import CanonicalDocument
from ..cdm.tokens import count_tokens, decode, encode
from .generic import Chunk, _section_depth


_FENCE = re.compile(r'```|~~~')


def _split_into_fenced_units(body: str) -> list[tuple[bool, str]]:
    """Return [(is_fenced, text), ...] preserving order. Multiple
    consecutive non-fenced segments collapse into one."""
    out: list[tuple[bool, str]] = []
    inside = False
    buf: list[str] = []

    for line in body.splitlines(keepends=True):
        if _FENCE.search(line):
            buf.append(line)
            if inside:
                # Close the fence — emit fenced unit + reset.
                out.append((True, ''.join(buf)))
                buf = []
                inside = False
            else:
                # Open the fence — flush prose buffer first.
                # buf already includes the opening fence line; pull it
                # out and emit the prose portion (everything before).
                opening = buf.pop()
                if buf:
                    out.append((False, ''.join(buf)))
                buf = [opening]
                inside = True
        else:
            buf.append(line)

    if buf:
        out.append((inside, ''.join(buf)))
    return out


def _chunk_id(version_id: str, ord_n: int) -> str:
    cid = f'chk_{version_id}_{ord_n:05d}'
    assert_chunk_id_size(cid)
    return cid


def chunk_document(
    cdm: CanonicalDocument,
    *,
    target_tokens: int = 700,
    overlap_tokens: int = 80,
    boundary_depth: int = 2,
) -> list[Chunk]:
    """Token-budgeted chunker that respects fenced code blocks. The
    overall structure mirrors the generic chunker; the only difference
    is in how oversized text is split."""

    chunks: list[Chunk] = []
    ord_counter = 0

    # Group blocks by section, respecting boundary_depth.
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
        units = _split_into_fenced_units(body)

        # Greedy pack non-fenced units; emit fenced units intact even
        # if they exceed target_tokens.
        pending = ''
        for is_fenced, text in units:
            if is_fenced:
                # Flush pending prose.
                if pending.strip():
                    chunks.extend(
                        _slide(
                            pending,
                            cdm.version_id,
                            ord_counter,
                            section_path,
                            target_tokens,
                            overlap_tokens,
                        ),
                    )
                    ord_counter += len(_slide(
                        pending,
                        cdm.version_id,
                        ord_counter,
                        section_path,
                        target_tokens,
                        overlap_tokens,
                    ))
                    pending = ''
                # Emit fenced unit as a single chunk, regardless of size.
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
            else:
                # Accumulate prose until we hit a fence or end.
                pending = (pending + text) if pending else text
        if pending.strip():
            slid = _slide(
                pending,
                cdm.version_id,
                ord_counter,
                section_path,
                target_tokens,
                overlap_tokens,
            )
            chunks.extend(slid)
            ord_counter += len(slid)
    return chunks


def _is_boundary(prev: str, nxt: str, depth: int) -> bool:
    if prev == nxt:
        return False
    return _section_depth(prev) <= depth or _section_depth(nxt) <= depth


def _slide(
    body: str,
    version_id: str,
    starting_ord: int,
    section_path: str,
    target_tokens: int,
    overlap_tokens: int,
) -> list[Chunk]:
    out: list[Chunk] = []
    ids = encode(body)
    if not ids:
        return out
    if count_tokens(body) <= target_tokens:
        out.append(
            Chunk(
                id=_chunk_id(version_id, starting_ord),
                ord=starting_ord,
                section_path=section_path,
                text=body,
            ),
        )
        return out
    i = 0
    step = max(1, target_tokens - overlap_tokens)
    ord_counter = starting_ord
    while i < len(ids):
        slice_ids = ids[i : i + target_tokens]
        text = decode(slice_ids)
        if text.strip():
            out.append(
                Chunk(
                    id=_chunk_id(version_id, ord_counter),
                    ord=ord_counter,
                    section_path=section_path,
                    text=text,
                ),
            )
            ord_counter += 1
        if i + target_tokens >= len(ids):
            break
        i += step
    return out
