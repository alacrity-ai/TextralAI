"""Normalizers — txt/md/epub → CanonicalDocument.

The CDM is the contract every chunker downstream depends on, so the
normalizers must produce stable section_path values, drop blank
content, and preserve ordering.
"""

from __future__ import annotations

import io
import zipfile

from app.normalizers.epub import normalize_epub
from app.normalizers.md import normalize_md
from app.normalizers.txt import normalize_txt


def test_normalize_txt_splits_on_blank_lines() -> None:
    raw = "First paragraph.\n\nSecond paragraph.\n\n\nThird."
    cdm = normalize_txt("doc_1", "ver_1", raw)
    assert len(cdm.blocks) == 3
    assert [b.text for b in cdm.blocks] == [
        "First paragraph.",
        "Second paragraph.",
        "Third.",
    ]
    for b in cdm.blocks:
        assert b.type == "paragraph"
        assert b.section_path == "/"


def test_normalize_txt_drops_blank_paragraphs() -> None:
    cdm = normalize_txt("doc_1", "ver_1", "\n\n   \n\nbody\n\n   ")
    assert len(cdm.blocks) == 1
    assert cdm.blocks[0].text == "body"


def test_normalize_txt_preserves_inner_whitespace() -> None:
    raw = "Line one.\nLine two of the same paragraph."
    cdm = normalize_txt("doc_1", "ver_1", raw)
    assert len(cdm.blocks) == 1
    assert "\n" in cdm.blocks[0].text


def test_normalize_md_walks_heading_hierarchy() -> None:
    raw = "# Top\n\nIntro text.\n\n## Sub A\n\nA-body.\n\n## Sub B\n\nB-body.\n"
    cdm = normalize_md("doc_1", "ver_1", raw)
    paths = [(b.type, b.text, b.section_path) for b in cdm.blocks]
    # heading + paragraphs, with sub-section paths reflecting nesting.
    assert ("heading", "Top", "/top") in paths
    assert ("paragraph", "Intro text.", "/top") in paths
    assert ("heading", "Sub A", "/top/sub-a") in paths
    assert ("paragraph", "A-body.", "/top/sub-a") in paths
    assert ("paragraph", "B-body.", "/top/sub-b") in paths


def test_normalize_md_pops_section_stack_on_higher_level() -> None:
    raw = "# A\n\nbody-a.\n\n## A-sub\n\nbody-asub.\n\n# B\n\nbody-b.\n"
    cdm = normalize_md("doc_1", "ver_1", raw)
    paragraphs = [(b.text, b.section_path) for b in cdm.blocks if b.type == "paragraph"]
    assert ("body-a.", "/a") in paragraphs
    assert ("body-asub.", "/a/a-sub") in paragraphs
    # New top-level heading must reset the stack — body-b is at /b, not /a/b.
    assert ("body-b.", "/b") in paragraphs


def test_normalize_md_records_heading_level() -> None:
    cdm = normalize_md("doc_1", "ver_1", "## Level Two\n\nbody.\n")
    headings = [b for b in cdm.blocks if b.type == "heading"]
    assert len(headings) == 1
    assert headings[0].metadata["heading_level"] == 2


def _build_epub(parts: list[tuple[str, str]], title: str = "Test Book") -> bytes:
    """Build a minimal EPUB 3 archive in-memory."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf"'
            ' media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        manifest_items = []
        spine_items = []
        for idx, (filename, _body) in enumerate(parts):
            item_id = f"chap{idx}"
            manifest_items.append(
                f'<item id="{item_id}" href="{filename}" media-type="application/xhtml+xml"/>'
            )
            spine_items.append(f'<itemref idref="{item_id}"/>')
        opf = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bid">urn:test:1</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>{''.join(manifest_items)}</manifest>
  <spine>{''.join(spine_items)}</spine>
</package>"""
        z.writestr("OEBPS/content.opf", opf)
        for filename, body in parts:
            z.writestr(f"OEBPS/{filename}", body)
    return buf.getvalue()


def test_normalize_epub_walks_spine_and_strips_html() -> None:
    chapter_one = (
        "ch1.xhtml",
        '<html xmlns="http://www.w3.org/1999/xhtml"><body>'
        "<h1>Chapter One</h1><p>Once upon a time.</p>"
        "<p>It was a stormy night.</p></body></html>",
    )
    chapter_two = (
        "ch2.xhtml",
        '<html xmlns="http://www.w3.org/1999/xhtml"><body>'
        "<h2>Chapter Two</h2><p>Then morning came.</p>"
        "<blockquote>A quoted sentence.</blockquote></body></html>",
    )
    raw = _build_epub([chapter_one, chapter_two], title="Tiny Novel")
    cdm = normalize_epub("doc_1", "ver_1", raw)
    assert cdm.title == "Tiny Novel"
    paragraphs = [b for b in cdm.blocks if b.type == "paragraph"]
    quotes = [b for b in cdm.blocks if b.type == "quote"]
    assert any(b.text == "Once upon a time." for b in paragraphs)
    assert any(b.text == "Then morning came." for b in paragraphs)
    assert any(b.text == "A quoted sentence." for b in quotes)
    # Section paths must reflect chapter slugs, not the whole-document root.
    distinct_sections = {b.section_path for b in cdm.blocks}
    assert "/" not in distinct_sections
    assert any(s.startswith("/ch1") or s.startswith("/oebps-ch1") for s in distinct_sections)
