"""Stage: chunk — produce Layer-1 passages and emit chunks.jsonl with
the versioned schema header."""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Iterable

from ..cdm.model import CanonicalDocument
from ..chunkers.generic import Chunk, chunk_document as _generic_chunk
from ..chunkers.code_aware import chunk_document as _code_aware_chunk
from ..chunkers.legal_clause_aware import chunk_document as _legal_chunk

CHUNK_JSONL_SCHEMA_VERSION = "chunk_jsonl_v1"

# Fail-fast registry. A profile YAML's `chunking.profile` value is
# enum-validated at boot in both the Worker (Zod) and the Container
# (Pydantic), so an unknown name here is genuinely an internal-state
# bug — defense in depth.
_CHUNKERS = {
    'generic': _generic_chunk,
    'code_aware': _code_aware_chunk,
    'legal_clause_aware': _legal_chunk,
}


def select_chunker(profile_name: str):
    if profile_name not in _CHUNKERS:
        raise RuntimeError(
            f'Unknown chunking profile: {profile_name!r}. '
            f'Valid: {sorted(_CHUNKERS)}'
        )
    return _CHUNKERS[profile_name]


def chunk_cdm(
    cdm: CanonicalDocument,
    *,
    target_tokens: int,
    overlap_tokens: int,
    chunking_profile: str,
    version_index_id: str,
) -> tuple[list[Chunk], str]:
    chunker = select_chunker(chunking_profile)
    chunks = chunker(
        cdm,
        target_tokens=target_tokens,
        overlap_tokens=overlap_tokens,
    )
    header = {
        "type": "header",
        "schema_version": CHUNK_JSONL_SCHEMA_VERSION,
        "version_id": cdm.version_id,
        "version_index_id": version_index_id,
        "chunking_profile": chunking_profile,
        "chunking_target_tokens": target_tokens,
        "chunking_overlap_tokens": overlap_tokens,
        "chunk_count": len(chunks),
    }
    lines: list[str] = [json.dumps(header)]
    for ch in chunks:
        lines.append(
            json.dumps(
                {
                    "type": "chunk",
                    "id": ch.id,
                    "ord": ch.ord,
                    "section_path": ch.section_path,
                    "text": ch.text,
                },
            ),
        )
    return chunks, "\n".join(lines) + "\n"


def parse_chunks_jsonl(payload: str) -> tuple[dict, list[Chunk]]:
    """Replay-side parser. Header line first; rejects unknown schema."""
    lines = [ln for ln in payload.splitlines() if ln.strip()]
    if not lines:
        raise ValueError("chunks.jsonl is empty")
    header = json.loads(lines[0])
    if header.get("type") != "header":
        raise ValueError("chunks.jsonl missing header")
    if header.get("schema_version") != CHUNK_JSONL_SCHEMA_VERSION:
        raise ValueError(
            f"UNSUPPORTED_CHUNK_JSONL_SCHEMA: {header.get('schema_version')}",
        )
    chunks: list[Chunk] = []
    for line in lines[1:]:
        obj = json.loads(line)
        if obj.get("type") != "chunk":
            continue
        chunks.append(
            Chunk(
                id=obj["id"],
                ord=obj["ord"],
                section_path=obj["section_path"],
                text=obj["text"],
            ),
        )
    if header.get("chunk_count") != len(chunks):
        raise ValueError(
            f"chunks.jsonl header chunk_count={header.get('chunk_count')} but file has {len(chunks)}",
        )
    return header, chunks


def chunks_to_dicts(chunks: Iterable[Chunk]) -> list[dict]:
    return [asdict(c) for c in chunks]
