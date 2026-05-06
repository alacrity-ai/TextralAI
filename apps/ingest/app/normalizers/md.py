"""Markdown normalizer. Walks the markdown-it AST so section paths
reflect heading hierarchy."""

from __future__ import annotations

from typing import Any

from markdown_it import MarkdownIt

from ..cdm.model import Block, CanonicalDocument


def normalize_md(document_id: str, version_id: str, raw: str) -> CanonicalDocument:
    md = MarkdownIt("commonmark")
    tokens = md.parse(raw)
    blocks: list[Block] = []
    section_stack: list[tuple[int, str]] = []  # (level, slug)

    def section_path() -> str:
        if not section_stack:
            return "/"
        return "/" + "/".join(slug for _, slug in section_stack)

    i = 0
    bid = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok.type == "heading_open":
            level = int(tok.tag[1:])  # h1 → 1
            inline = tokens[i + 1]
            title = inline.content if inline.type == "inline" else ""
            slug = _slug(title)
            while section_stack and section_stack[-1][0] >= level:
                section_stack.pop()
            section_stack.append((level, slug))
            blocks.append(
                Block(
                    id=f"h_{bid:04d}",
                    type="heading",
                    section_path=section_path(),
                    text=title,
                    metadata={"heading_level": level},
                ),
            )
            bid += 1
            i += 3  # heading_open + inline + heading_close
            continue
        if tok.type == "paragraph_open":
            inline = tokens[i + 1]
            text = inline.content if inline.type == "inline" else ""
            if text.strip():
                blocks.append(
                    Block(
                        id=f"p_{bid:04d}",
                        type="paragraph",
                        section_path=section_path(),
                        text=text,
                    ),
                )
                bid += 1
            i += 3
            continue
        i += 1

    return CanonicalDocument(
        document_id=document_id,
        version_id=version_id,
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
