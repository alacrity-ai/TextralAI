"""Normalize stage — content-type routing to the right normalizer."""

from __future__ import annotations

from app.stages.normalize import normalize_source


def test_routes_text_plain_to_txt_normalizer() -> None:
    cdm = normalize_source("d", "v", b"para one.\n\npara two.", "text/plain")
    assert len(cdm.blocks) == 2
    assert all(b.section_path == "/" for b in cdm.blocks)


def test_routes_text_markdown_to_md_normalizer() -> None:
    cdm = normalize_source("d", "v", b"# Heading\n\nbody.\n", "text/markdown")
    paths = {b.section_path for b in cdm.blocks}
    assert "/heading" in paths


def test_strips_charset_param_from_content_type() -> None:
    cdm = normalize_source("d", "v", b"# Heading\n\nbody.\n", "text/markdown; charset=utf-8")
    paths = {b.section_path for b in cdm.blocks}
    assert "/heading" in paths


def test_unknown_content_type_falls_back_to_txt() -> None:
    cdm = normalize_source("d", "v", b"a.\n\nb.", "application/x-weird")
    assert len(cdm.blocks) == 2


def test_invalid_utf8_uses_replace_errors_strategy() -> None:
    raw = b"hello \xff\xfe world"
    cdm = normalize_source("d", "v", raw, "text/plain")
    assert len(cdm.blocks) == 1
