"""Stage: normalize — parse source bytes into the Canonical Document
Model. Routing by content-type."""

from __future__ import annotations

from ..cdm.model import CanonicalDocument
from ..normalizers.epub import normalize_epub
from ..normalizers.md import normalize_md
from ..normalizers.txt import normalize_txt


def normalize_source(
    document_id: str,
    version_id: str,
    raw: bytes,
    content_type: str,
) -> CanonicalDocument:
    ct = content_type.lower().split(";")[0].strip()
    if ct in ("text/plain", "application/octet-stream"):
        return normalize_txt(document_id, version_id, raw.decode("utf-8", errors="replace"))
    if ct in ("text/markdown", "text/x-markdown"):
        return normalize_md(document_id, version_id, raw.decode("utf-8", errors="replace"))
    if ct in ("application/epub+zip", "application/epub"):
        return normalize_epub(document_id, version_id, raw)
    # Fallback: treat as text.
    return normalize_txt(document_id, version_id, raw.decode("utf-8", errors="replace"))
