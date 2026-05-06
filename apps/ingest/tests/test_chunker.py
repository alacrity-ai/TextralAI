"""Generic chunker — verifies token budgets, overlap window, section
boundaries, and the deterministic chk_<vid>_<ord:05d> ID format.

Boundary semantics (boundary_depth=2 default): two paragraphs that share
the same section_path glue together; a path change at depth ≤ 2 forces
a hard split."""

from __future__ import annotations

from app.cdm.model import Block, CanonicalDocument
from app.cdm.tokens import count_tokens
from app.chunkers.generic import chunk_document


def _cdm(blocks: list[Block], document_id: str = "doc_1", version_id: str = "ver_42") -> CanonicalDocument:
    return CanonicalDocument(document_id=document_id, version_id=version_id, blocks=blocks)


def _para(idx: int, text: str, section: str = "/") -> Block:
    return Block(id=f"p_{idx:04d}", type="paragraph", section_path=section, text=text)


def test_chunk_id_uses_canonical_format() -> None:
    cdm = _cdm([_para(0, "hello world.")], version_id="ver_abcdef")
    chunks = chunk_document(cdm, target_tokens=50, overlap_tokens=10)
    assert len(chunks) == 1
    assert chunks[0].id == "chk_ver_abcdef_00000"
    assert chunks[0].ord == 0


def test_chunks_under_target_emit_one_chunk() -> None:
    cdm = _cdm([_para(0, "Short paragraph one."), _para(1, "Short paragraph two.")])
    chunks = chunk_document(cdm, target_tokens=200, overlap_tokens=20)
    assert len(chunks) == 1
    assert "paragraph one" in chunks[0].text
    assert "paragraph two" in chunks[0].text


def test_long_section_splits_with_overlap() -> None:
    # 50 paragraphs of distinct words → well over a 50-token budget.
    blocks = [_para(i, f"word{i:03d} " * 20) for i in range(50)]
    cdm = _cdm(blocks)
    target, overlap = 50, 10
    chunks = chunk_document(cdm, target_tokens=target, overlap_tokens=overlap)
    assert len(chunks) >= 2
    # Each chunk must respect the budget.
    for c in chunks:
        assert count_tokens(c.text) <= target + 1
    # Overlap: consecutive chunks must share suffix→prefix material.
    for prev, nxt in zip(chunks, chunks[1:]):
        prev_tokens = prev.text.split()
        nxt_tokens = nxt.text.split()
        # at least one token of overlap on the boundary
        assert any(t in nxt_tokens[: max(overlap, 1)] for t in prev_tokens[-max(overlap, 1):])
    # Ord values are monotonic and zero-based.
    assert [c.ord for c in chunks] == list(range(len(chunks)))


def test_section_boundary_forces_split() -> None:
    blocks = [
        _para(0, "Top one.", section="/a"),
        _para(1, "Top two.", section="/a"),
        _para(2, "Different section.", section="/b"),
    ]
    cdm = _cdm(blocks)
    chunks = chunk_document(cdm, target_tokens=200, overlap_tokens=20, boundary_depth=2)
    assert len(chunks) == 2
    assert chunks[0].section_path == "/a"
    assert chunks[1].section_path == "/b"
    assert "Different section" in chunks[1].text
    assert "Top one" in chunks[0].text


def test_deeper_section_boundary_does_not_split_when_above_depth() -> None:
    # boundary_depth=1 means /a/sub-a → /a/sub-b is NOT a boundary because
    # neither side is at depth ≤ 1.
    blocks = [
        _para(0, "first.", section="/a/sub-a"),
        _para(1, "second.", section="/a/sub-b"),
    ]
    cdm = _cdm(blocks)
    chunks = chunk_document(cdm, target_tokens=200, overlap_tokens=20, boundary_depth=1)
    assert len(chunks) == 1


def test_blank_blocks_are_skipped() -> None:
    blocks = [
        _para(0, ""),
        _para(1, "   "),
        _para(2, "real."),
    ]
    cdm = _cdm(blocks)
    chunks = chunk_document(cdm, target_tokens=200, overlap_tokens=20)
    assert len(chunks) == 1
    assert chunks[0].text.strip() == "real."


def test_empty_document_yields_no_chunks() -> None:
    cdm = _cdm([])
    chunks = chunk_document(cdm, target_tokens=200, overlap_tokens=20)
    assert chunks == []
