"""Index stage — verifies the partial-ingestion invariants:

  - D1 (chunks/batch) gets ALL chunks, regardless of embedding_status.
  - Vectorize gets ONLY chunks where embedding_status='embedded'.
  - When replace_existing_vectors=True, delete-by-filter is invoked first.
  - The Worker's mutation_id is propagated.
"""

from __future__ import annotations

import json

import httpx
import respx

from app.chunkers.generic import Chunk
from app.clients.worker import WorkerClient
from app.stages.embed import EmbedResult
from app.stages.index import index_chunks


SECRET = "s"
BASE = "http://w"


def _chunk(ord_n: int, section: str = "/") -> Chunk:
    return Chunk(id=f"chk_ver_x_{ord_n:05d}", ord=ord_n, section_path=section, text=f"chunk {ord_n}")


def _embedded(chunk_id: str) -> EmbedResult:
    return EmbedResult(
        chunk_id=chunk_id,
        vector=[0.1] * 1536,
        input_hash="a" * 64,
        request_id="rq_1",
        status="embedded",
    )


def _missing(chunk_id: str) -> EmbedResult:
    return EmbedResult(
        chunk_id=chunk_id,
        vector=None,
        input_hash="b" * 64,
        request_id=None,
        status="missing",
    )


@respx.mock
async def test_full_success_writes_all_chunks_and_all_vectors() -> None:
    client = WorkerClient(base_url=BASE, secret=SECRET)
    chunks = [_chunk(i) for i in range(3)]
    embeddings = {c.id: _embedded(c.id) for c in chunks}

    chunk_calls: list[dict] = []
    vec_calls: list[dict] = []

    def _chunks_batch(request: httpx.Request) -> httpx.Response:
        chunk_calls.append(json.loads(request.read()))
        return httpx.Response(200, json={"inserted": 3})

    def _vectorize(request: httpx.Request) -> httpx.Response:
        vec_calls.append(json.loads(request.read()))
        return httpx.Response(200, json={"mutation_id": "mut_999"})

    respx.post(f"{BASE}/internal/chunks/batch").mock(side_effect=_chunks_batch)
    respx.post(f"{BASE}/internal/vectorize/upsert").mock(side_effect=_vectorize)

    md = await index_chunks(
        client,
        job_id="job_x",
        tenant_id="ten_1",
        namespace_id="ns_1",
        document_id="doc_1",
        version_id="ver_1",
        version_index_id="vidx_1",
        embedding_profile="openai-text-embedding-3-large-1536",
        chunking_profile="generic",
        embedding_dimensions=1536,
        chunks=chunks,
        embeddings=embeddings,
        replace_existing=False,
    )
    assert md["chunk_count"] == 3
    assert md["d1_rows_written"] == 3
    assert md["vectors_upserted"] == 3
    assert md["embedding_missing_count"] == 0
    assert md["vectorize_mutation_id"] == "mut_999"
    assert chunk_calls and vec_calls
    # Every D1 chunk record has embedding_status='embedded'.
    for rec in chunk_calls[0]["chunks"]:
        assert rec["embedding_status"] == "embedded"
        assert rec["embedding_dimensions"] == 1536
    await client.aclose()


@respx.mock
async def test_partial_only_embedded_chunks_go_to_vectorize() -> None:
    """The single most important invariant of the index stage: D1 gets
    everyone, Vectorize gets only the successful embeds."""
    client = WorkerClient(base_url=BASE, secret=SECRET)
    chunks = [_chunk(i) for i in range(4)]
    embeddings = {
        chunks[0].id: _embedded(chunks[0].id),
        chunks[1].id: _missing(chunks[1].id),
        chunks[2].id: _embedded(chunks[2].id),
        chunks[3].id: _missing(chunks[3].id),
    }

    chunk_calls: list[dict] = []
    vec_calls: list[dict] = []

    respx.post(f"{BASE}/internal/chunks/batch").mock(
        side_effect=lambda r: chunk_calls.append(json.loads(r.read())) or httpx.Response(
            200, json={"inserted": 4}
        )
    )
    respx.post(f"{BASE}/internal/vectorize/upsert").mock(
        side_effect=lambda r: vec_calls.append(json.loads(r.read())) or httpx.Response(
            200, json={"mutation_id": "mut_x"}
        )
    )

    md = await index_chunks(
        client,
        job_id="job_x",
        tenant_id="ten_1",
        namespace_id="ns_1",
        document_id="doc_1",
        version_id="ver_1",
        version_index_id="vidx_1",
        embedding_profile="openai-text-embedding-3-large-1536",
        chunking_profile="generic",
        embedding_dimensions=1536,
        chunks=chunks,
        embeddings=embeddings,
        replace_existing=False,
    )
    assert md["chunk_count"] == 4
    assert md["embedding_missing_count"] == 2
    assert md["vectors_upserted"] == 2

    # D1: all 4 chunks
    sent_ids = {rec["id"] for rec in chunk_calls[0]["chunks"]}
    assert sent_ids == {c.id for c in chunks}
    statuses = {rec["id"]: rec["embedding_status"] for rec in chunk_calls[0]["chunks"]}
    assert statuses[chunks[0].id] == "embedded"
    assert statuses[chunks[1].id] == "missing"
    assert statuses[chunks[2].id] == "embedded"
    assert statuses[chunks[3].id] == "missing"

    # Vectorize: only the 2 embedded chunks
    sent_vec_ids = {v["id"] for v in vec_calls[0]["vectors"]}
    assert sent_vec_ids == {chunks[0].id, chunks[2].id}

    # Missing chunks must not write embedding_dimensions (defends against
    # the D1 schema's CHECK constraint on dimensions when status='missing').
    for rec in chunk_calls[0]["chunks"]:
        if rec["embedding_status"] == "missing":
            assert rec["embedding_dimensions"] is None
    await client.aclose()


@respx.mock
async def test_replace_existing_calls_delete_by_filter_first() -> None:
    client = WorkerClient(base_url=BASE, secret=SECRET)
    chunks = [_chunk(0)]
    embeddings = {chunks[0].id: _embedded(chunks[0].id)}

    call_order: list[str] = []
    respx.post(f"{BASE}/internal/vectorize/delete-by-filter").mock(
        side_effect=lambda r: call_order.append("delete") or httpx.Response(200, json={"ok": True})
    )
    respx.post(f"{BASE}/internal/chunks/batch").mock(
        side_effect=lambda r: call_order.append("chunks")
        or httpx.Response(200, json={"inserted": 1})
    )
    respx.post(f"{BASE}/internal/vectorize/upsert").mock(
        side_effect=lambda r: call_order.append("upsert")
        or httpx.Response(200, json={"mutation_id": "m"})
    )

    await index_chunks(
        client,
        job_id="job_x",
        tenant_id="ten_1",
        namespace_id="ns_1",
        document_id="doc_1",
        version_id="ver_1",
        version_index_id="vidx_1",
        embedding_profile="openai-text-embedding-3-large-1536",
        chunking_profile="generic",
        embedding_dimensions=1536,
        chunks=chunks,
        embeddings=embeddings,
        replace_existing=True,
    )
    # delete-by-filter must come first; otherwise the new vectors get wiped.
    assert call_order[0] == "delete"
    await client.aclose()


@respx.mock
async def test_vector_metadata_carries_ownership_and_artifact_type() -> None:
    """Vectorize metadata is what the Worker checks ownership against on
    every retrieval. Drop the wrong tenant_id here and you get
    cross-tenant leakage."""
    client = WorkerClient(base_url=BASE, secret=SECRET)
    chunks = [_chunk(0)]
    embeddings = {chunks[0].id: _embedded(chunks[0].id)}

    seen: dict = {}

    def _capture(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.read()))
        return httpx.Response(200, json={"mutation_id": "m"})

    respx.post(f"{BASE}/internal/chunks/batch").mock(return_value=httpx.Response(200, json={"inserted": 1}))
    respx.post(f"{BASE}/internal/vectorize/upsert").mock(side_effect=_capture)

    await index_chunks(
        client,
        job_id="job_x",
        tenant_id="ten_owner",
        namespace_id="ns_owner",
        document_id="doc_owner",
        version_id="ver_owner",
        version_index_id="vidx_owner",
        embedding_profile="p",
        chunking_profile="generic",
        embedding_dimensions=1536,
        chunks=chunks,
        embeddings=embeddings,
        replace_existing=False,
    )
    md = seen["vectors"][0]["metadata"]
    assert md["tenant_id"] == "ten_owner"
    assert md["namespace_id"] == "ns_owner"
    assert md["document_id"] == "doc_owner"
    assert md["version_id"] == "ver_owner"
    assert md["version_index_id"] == "vidx_owner"
    assert md["artifact_type"] == "passage"
    await client.aclose()
