"""chunks.jsonl — emit + parse with strict schema versioning. Replay
must reject anything other than chunk_jsonl_v1."""

from __future__ import annotations

import json

import pytest

from app.cdm.model import Block, CanonicalDocument
from app.stages.chunk import CHUNK_JSONL_SCHEMA_VERSION, chunk_cdm, parse_chunks_jsonl


def _cdm() -> CanonicalDocument:
    return CanonicalDocument(
        document_id="doc_1",
        version_id="ver_x",
        blocks=[
            Block(id="p_0", type="paragraph", section_path="/", text="alpha."),
            Block(id="p_1", type="paragraph", section_path="/", text="beta."),
        ],
    )


def test_chunk_cdm_emits_header_first() -> None:
    chunks, payload = chunk_cdm(
        _cdm(),
        target_tokens=200,
        overlap_tokens=20,
        chunking_profile="generic",
        version_index_id="vidx_1",
    )
    first_line = payload.splitlines()[0]
    header = json.loads(first_line)
    assert header["type"] == "header"
    assert header["schema_version"] == CHUNK_JSONL_SCHEMA_VERSION
    assert header["version_id"] == "ver_x"
    assert header["version_index_id"] == "vidx_1"
    assert header["chunking_profile"] == "generic"
    assert header["chunking_target_tokens"] == 200
    assert header["chunking_overlap_tokens"] == 20
    assert header["chunk_count"] == len(chunks)


def test_round_trip_parse_recovers_chunks() -> None:
    chunks, payload = chunk_cdm(
        _cdm(),
        target_tokens=200,
        overlap_tokens=20,
        chunking_profile="generic",
        version_index_id="vidx_1",
    )
    header, parsed = parse_chunks_jsonl(payload)
    assert header["chunk_count"] == len(parsed)
    assert [(c.id, c.ord, c.section_path) for c in parsed] == [
        (c.id, c.ord, c.section_path) for c in chunks
    ]


def test_unknown_schema_version_raises() -> None:
    bad = json.dumps({"type": "header", "schema_version": "chunk_jsonl_v2", "chunk_count": 0}) + "\n"
    with pytest.raises(ValueError, match="UNSUPPORTED_CHUNK_JSONL_SCHEMA"):
        parse_chunks_jsonl(bad)


def test_missing_header_raises() -> None:
    body = json.dumps({"type": "chunk", "id": "x", "ord": 0, "section_path": "/", "text": "y"}) + "\n"
    with pytest.raises(ValueError, match="missing header"):
        parse_chunks_jsonl(body)


def test_chunk_count_mismatch_raises() -> None:
    header = {
        "type": "header",
        "schema_version": CHUNK_JSONL_SCHEMA_VERSION,
        "chunk_count": 99,
    }
    chunk = {"type": "chunk", "id": "x", "ord": 0, "section_path": "/", "text": "y"}
    payload = json.dumps(header) + "\n" + json.dumps(chunk) + "\n"
    with pytest.raises(ValueError, match="header chunk_count"):
        parse_chunks_jsonl(payload)


def test_empty_payload_raises() -> None:
    with pytest.raises(ValueError, match="empty"):
        parse_chunks_jsonl("")
