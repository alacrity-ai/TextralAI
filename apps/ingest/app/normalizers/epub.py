"""EPUB normalizer. Walks the spine, strips HTML chapter-by-chapter."""

from __future__ import annotations

import io
from typing import cast

from bs4 import BeautifulSoup
from ebooklib import epub
from ebooklib.epub import EpubBook, EpubHtml

from ..cdm.model import Block, CanonicalDocument


def normalize_epub(document_id: str, version_id: str, raw: bytes) -> CanonicalDocument:
    book: EpubBook = cast(EpubBook, epub.read_epub(io.BytesIO(raw)))
    blocks: list[Block] = []
    bid = 0
    for spine_id, _ in book.spine:
        item = book.get_item_with_id(spine_id)
        if item is None:
            continue
        if not isinstance(item, EpubHtml):
            continue
        section_slug = _slug(item.get_name() or spine_id)
        soup = BeautifulSoup(item.get_content(), "lxml")
        # Section title from the first heading in the chapter, if any.
        first_heading = soup.find(["h1", "h2", "h3"])
        chapter_path = f"/{section_slug}"
        if first_heading and first_heading.get_text(strip=True):
            blocks.append(
                Block(
                    id=f"h_{bid:04d}",
                    type="heading",
                    section_path=chapter_path,
                    text=first_heading.get_text(strip=True),
                    metadata={"heading_level": int(first_heading.name[1])},
                ),
            )
            bid += 1
        for p in soup.find_all(["p", "blockquote"]):
            text = p.get_text(" ", strip=True)
            if not text:
                continue
            blocks.append(
                Block(
                    id=f"p_{bid:04d}",
                    type="paragraph" if p.name == "p" else "quote",
                    section_path=chapter_path,
                    text=text,
                ),
            )
            bid += 1
    title = book.get_metadata("DC", "title")
    title_str = title[0][0] if title else None
    return CanonicalDocument(
        document_id=document_id,
        version_id=version_id,
        title=title_str,
        blocks=blocks,
    )


def _slug(s: str) -> str:
    out: list[str] = []
    for ch in s.lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-") or "section"
