"""Code-aware chunker — never splits inside a fenced block."""

from __future__ import annotations

from app.cdm.model import Block, CanonicalDocument
from app.chunkers.code_aware import chunk_document


def _cdm(blocks: list[Block]) -> CanonicalDocument:
    return CanonicalDocument(document_id='doc_1', version_id='ver_test', blocks=blocks)


def _para(idx: int, text: str, section: str = '/') -> Block:
    return Block(id=f'p_{idx:04d}', type='paragraph', section_path=section, text=text)


def test_oversized_fenced_block_stays_intact() -> None:
    """A code block that exceeds target_tokens still becomes ONE chunk."""
    code_body = '\n'.join(f'def f{i}(): return {i}' for i in range(200))
    blocks = [
        _para(0, 'Intro paragraph.'),
        _para(1, f'```python\n{code_body}\n```'),
        _para(2, 'Closing paragraph.'),
    ]
    chunks = chunk_document(_cdm(blocks), target_tokens=200, overlap_tokens=20)
    code_chunks = [c for c in chunks if '```' in c.text]
    assert len(code_chunks) == 1, f'expected exactly one code-fenced chunk, got {len(code_chunks)}'
    assert 'def f199()' in code_chunks[0].text
    assert 'def f0()' in code_chunks[0].text


def test_prose_around_fence_is_chunked_normally() -> None:
    """Prose before and after a fenced block respects the target budget."""
    long_prose = ' '.join(f'word{i}' for i in range(800))
    blocks = [
        _para(0, long_prose),
        _para(1, '```\nshort code\n```'),
        _para(2, long_prose),
    ]
    chunks = chunk_document(_cdm(blocks), target_tokens=200, overlap_tokens=20)
    # Prose should produce multiple sliding-window chunks; the fenced
    # block is one chunk; total chunks > 3.
    code_chunks = [c for c in chunks if '```' in c.text]
    prose_chunks = [c for c in chunks if '```' not in c.text]
    assert len(code_chunks) == 1
    assert len(prose_chunks) >= 2


def test_no_fences_falls_back_to_generic_behavior() -> None:
    """Without fences, code_aware behaves like generic for budget purposes."""
    body = ' '.join(f'word{i}' for i in range(50))
    chunks = chunk_document(_cdm([_para(0, body)]), target_tokens=200, overlap_tokens=20)
    assert len(chunks) == 1
    assert 'word0' in chunks[0].text
    assert 'word49' in chunks[0].text


def test_chunker_select_via_stage_dispatch() -> None:
    """The stage's select_chunker resolves 'code_aware' to this module."""
    from app.stages.chunk import select_chunker

    assert select_chunker('code_aware') is chunk_document


def test_chunker_select_unknown_raises() -> None:
    """Unknown chunker names crash fast — no silent fallback."""
    from app.stages.chunk import select_chunker
    import pytest

    with pytest.raises(RuntimeError, match='Unknown chunking profile'):
        select_chunker('typo_profile')
