"""Vectorize V2's vector ID column has a 64-byte cap. Chunkers and
the enrichment runner both produce IDs that have to fit. Today's
formats are 40-44 bytes; future format changes (longer ULIDs,
different prefixes) could blow through silently.

Use ``assert_chunk_id_size(chunk_id)`` in every chunk-id factory to
fail loudly at the boundary."""

from __future__ import annotations

VECTORIZE_ID_BYTE_CAP = 64


def assert_chunk_id_size(chunk_id: str) -> None:
    n = len(chunk_id.encode("utf-8"))
    if n > VECTORIZE_ID_BYTE_CAP:
        raise RuntimeError(
            f"chunk_id exceeds Vectorize 64-byte cap "
            f"({n} bytes): {chunk_id!r}",
        )
