"""Vectorize V2 caps vector IDs at 64 bytes. The chunkers + the
enrichment runner all generate IDs that have to fit; the size guard
fires loudly if a future format change blows the cap."""

from __future__ import annotations

import pytest

from app._chunk_id_guard import assert_chunk_id_size, VECTORIZE_ID_BYTE_CAP


def test_within_cap_does_not_raise() -> None:
    assert_chunk_id_size('chk_short_id')


def test_exact_cap_does_not_raise() -> None:
    assert_chunk_id_size('a' * VECTORIZE_ID_BYTE_CAP)


def test_one_byte_over_raises() -> None:
    with pytest.raises(RuntimeError, match='exceeds Vectorize 64-byte cap'):
        assert_chunk_id_size('a' * (VECTORIZE_ID_BYTE_CAP + 1))


def test_unicode_bytes_counted_correctly() -> None:
    """Multi-byte UTF-8 chars count by byte, not by codepoint. Vectorize
    caps in bytes, so the guard must too."""
    # Each emoji is 4 bytes in UTF-8.
    s = '🎉' * 17  # 68 bytes
    with pytest.raises(RuntimeError, match='68 bytes'):
        assert_chunk_id_size(s)
