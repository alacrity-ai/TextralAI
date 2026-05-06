"""Legal-clause-aware chunker — clause boundaries are hard splits."""

from __future__ import annotations

from app.cdm.model import Block, CanonicalDocument
from app.chunkers.legal_clause_aware import chunk_document


def _cdm(blocks: list[Block]) -> CanonicalDocument:
    return CanonicalDocument(document_id='doc_1', version_id='ver_test', blocks=blocks)


def _para(idx: int, text: str, section: str = '/') -> Block:
    return Block(id=f'p_{idx:04d}', type='paragraph', section_path=section, text=text)


def test_each_numbered_clause_is_its_own_chunk() -> None:
    body = '\n\n'.join(
        f'{i}. This is clause {i}, containing some text describing rights and obligations.'
        for i in range(1, 6)
    )
    chunks = chunk_document(_cdm([_para(0, body)]), target_tokens=500, overlap_tokens=50)
    assert len(chunks) == 5
    for i, ch in enumerate(chunks, start=1):
        assert ch.text.startswith(f'{i}.')


def test_oversize_clause_uses_sliding_window_within() -> None:
    long = ' '.join([f'word{i}' for i in range(1500)])
    body = f'1. Short first clause.\n\n2. {long}\n\n3. Short third clause.'
    chunks = chunk_document(_cdm([_para(0, body)]), target_tokens=200, overlap_tokens=20)
    # Clause 2 should sliding-window into multiple chunks; clauses 1 + 3 each one.
    short_chunks = [c for c in chunks if c.text.startswith('1.') or c.text.startswith('3.')]
    big_chunks = [c for c in chunks if 'word0' in c.text or 'word1499' in c.text]
    assert len(short_chunks) == 2
    assert len(big_chunks) >= 1


def test_lettered_clause_markers_recognized() -> None:
    body = '(a) First lettered clause.\n\n(b) Second lettered clause.\n\n(c) Third.'
    chunks = chunk_document(_cdm([_para(0, body)]), target_tokens=500, overlap_tokens=50)
    # Three clauses → three chunks.
    assert len(chunks) == 3


def test_text_without_clause_markers_becomes_one_chunk() -> None:
    body = 'A simple paragraph without clause numbers, well under target.'
    chunks = chunk_document(_cdm([_para(0, body)]), target_tokens=200, overlap_tokens=20)
    assert len(chunks) == 1
    assert chunks[0].text == body


def test_chunker_select_via_stage_dispatch() -> None:
    from app.stages.chunk import select_chunker

    assert select_chunker('legal_clause_aware') is chunk_document
