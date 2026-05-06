"""Stage: index — write chunks to D1 (FTS5 trigger fires on the Worker
side) and upsert vectors to Vectorize (only embedding_status='embedded'
chunks).

Partial-ingestion invariants:
  - D1 + FTS5 hold ALL chunks regardless of embedding_status.
  - Vectorize holds only chunks where embedding_status='embedded'.
  - version_indexes.embedding_missing_count is the count of 'missing'
    chunks; status ends 'ready' or 'partial'."""

from __future__ import annotations

from typing import Any

from ..chunkers.generic import Chunk
from ..clients.worker import WorkerClient
from .embed import EmbedResult


async def index_chunks(
    worker: WorkerClient,
    *,
    job_id: str,
    tenant_id: str,
    namespace_id: str,
    document_id: str,
    version_id: str,
    version_index_id: str,
    embedding_profile: str,
    chunking_profile: str,
    embedding_dimensions: int,
    chunks: list[Chunk],
    embeddings: dict[str, EmbedResult],
    replace_existing: bool,
) -> dict[str, Any]:
    """Returns metadata for the stage attempt log: chunk_count,
    embedding_missing_count, mutation_id."""
    if replace_existing:
        await worker.post_json(
            "/internal/vectorize/delete-by-filter",
            {
                "job_id": job_id,
                "document_id": document_id,
                "version_id": version_id,
                "embedding_profile": embedding_profile,
                "chunking_profile": chunking_profile,
            },
        )

    # Build chunk records for /internal/chunks/batch.
    chunk_records: list[dict[str, Any]] = []
    for ch in chunks:
        emb = embeddings.get(ch.id)
        chunk_records.append(
            {
                "id": ch.id,
                "tenant_id": tenant_id,
                "namespace_id": namespace_id,
                "document_id": document_id,
                "version_id": version_id,
                "version_index_id": version_index_id,
                "artifact_type": "passage",
                "section_path": ch.section_path,
                "ord": ch.ord,
                "text": ch.text,
                "metadata": None,
                "embedding_profile": embedding_profile,
                "chunking_profile": chunking_profile,
                "embedding_status": emb.status if emb else "missing",
                "embedding_input_hash": emb.input_hash if emb else None,
                "embedding_provider_request_id": emb.request_id if emb else None,
                "embedding_dimensions": embedding_dimensions if emb and emb.status == "embedded" else None,
            },
        )

    # Batch the writes 200 at a time.
    inserted = 0
    for i in range(0, len(chunk_records), 200):
        batch = chunk_records[i : i + 200]
        res = await worker.post_json(
            "/internal/chunks/batch",
            {"job_id": job_id, "chunks": batch},
        )
        inserted += int(res.get("inserted", len(batch)))

    # Upsert vectors only for embedded chunks.
    vectors: list[dict[str, Any]] = []
    for ch in chunks:
        emb = embeddings.get(ch.id)
        if not emb or emb.status != "embedded" or emb.vector is None:
            continue
        vectors.append(
            {
                "id": ch.id,
                "values": emb.vector,
                "metadata": {
                    "tenant_id": tenant_id,
                    "namespace_id": namespace_id,
                    "document_id": document_id,
                    "version_id": version_id,
                    "version_index_id": version_index_id,
                    "artifact_type": "passage",
                },
            },
        )
    mutation_id = None
    for i in range(0, len(vectors), 200):
        batch = vectors[i : i + 200]
        res = await worker.post_json(
            "/internal/vectorize/upsert",
            {"job_id": job_id, "vectors": batch},
        )
        mutation_id = res.get("mutation_id") or mutation_id

    missing = sum(1 for ch in chunks if (embeddings.get(ch.id) or _MISSING).status != "embedded")
    return {
        "chunk_count": len(chunks),
        "d1_rows_written": inserted,
        "vectors_upserted": len(vectors),
        "embedding_missing_count": missing,
        "vectorize_mutation_id": mutation_id,
    }


class _Missing:
    status = "missing"


_MISSING = _Missing()
