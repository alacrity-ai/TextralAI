"""Embed stage — batches into per-provider sizes, surfaces 422 fatals,
falls back to embedding_status='missing' on 503 transients."""

from __future__ import annotations

import hashlib

import httpx
import pytest
import respx

from app.clients.worker import WorkerClient, WorkerError
from app.stages.embed import _hash_text, embed_chunks


SECRET = "s"
BASE = "http://w"


async def _client() -> WorkerClient:
    return WorkerClient(base_url=BASE, secret=SECRET)


@respx.mock
async def test_embed_batches_at_openai_size() -> None:
    """OpenAI batch size is 100. 250 inputs → 3 calls (100 + 100 + 50)."""
    client = await _client()
    chunks = [(f"chk_{i:05d}", f"text {i}") for i in range(250)]
    call_count = {"n": 0}

    def _embed(request: httpx.Request) -> httpx.Response:
        body = request.read()
        import json as _json
        payload = _json.loads(body)
        n = len(payload["input"])
        call_count["n"] += 1
        return httpx.Response(
            200,
            json={
                "vectors": [[0.1] * 1536 for _ in range(n)],
                "request_id": f"rq_{call_count['n']}",
            },
        )

    respx.post(f"{BASE}/internal/providers/embed").mock(side_effect=_embed)
    results, missing = await embed_chunks(client, job_id="job_x", provider="openai", chunks=chunks)
    assert call_count["n"] == 3
    assert len(results) == 250
    assert missing == 0
    assert all(r.status == "embedded" for r in results)
    await client.aclose()


@respx.mock
async def test_embed_503_marks_batch_missing_and_continues() -> None:
    client = await _client()
    chunks = [(f"chk_{i:05d}", f"text {i}") for i in range(150)]
    seq = iter(
        [
            httpx.Response(
                200, json={"vectors": [[0.1] * 1536 for _ in range(100)], "request_id": "rq_1"}
            ),
            httpx.Response(503, json={"error": {"code": "TRANSIENT_FAILURE"}}),
        ]
    )
    respx.post(f"{BASE}/internal/providers/embed").mock(side_effect=lambda r: next(seq))

    results, missing = await embed_chunks(client, job_id="job_x", provider="openai", chunks=chunks)
    assert len(results) == 150
    # First 100 embedded, last 50 missing.
    assert sum(1 for r in results[:100] if r.status == "embedded") == 100
    assert sum(1 for r in results[100:] if r.status == "missing") == 50
    assert missing == 50
    # Missing entries record the input hash for replay accounting.
    missing_results = [r for r in results if r.status == "missing"]
    assert all(r.vector is None for r in missing_results)
    assert all(r.input_hash for r in missing_results)
    await client.aclose()


@respx.mock
async def test_embed_422_propagates_as_worker_error() -> None:
    client = await _client()
    chunks = [("chk_00000", "text")]
    respx.post(f"{BASE}/internal/providers/embed").mock(
        return_value=httpx.Response(
            422,
            json={"error": {"code": "INSUFFICIENT_QUOTA", "message": "billing"}},
        )
    )
    with pytest.raises(WorkerError) as ei:
        await embed_chunks(client, job_id="job_x", provider="openai", chunks=chunks)
    assert ei.value.status == 422
    await client.aclose()


@respx.mock
async def test_embed_partial_batch_response_marks_all_missing() -> None:
    """Worker says it embedded 5 vectors but we sent 10 → mark whole batch
    missing rather than partial-attribute (avoids index drift)."""
    client = await _client()
    chunks = [(f"chk_{i:05d}", f"text {i}") for i in range(10)]
    respx.post(f"{BASE}/internal/providers/embed").mock(
        return_value=httpx.Response(
            200,
            json={"vectors": [[0.1] * 1536 for _ in range(5)], "request_id": "rq_x"},
        )
    )
    results, missing = await embed_chunks(client, job_id="job_x", provider="openai", chunks=chunks)
    assert missing == 10
    assert all(r.status == "missing" for r in results)
    await client.aclose()


@respx.mock
async def test_embed_workers_ai_batches_at_96() -> None:
    client = await _client()
    chunks = [(f"chk_{i:05d}", f"text {i}") for i in range(200)]
    seen_sizes: list[int] = []

    def _embed(request: httpx.Request) -> httpx.Response:
        import json as _json
        payload = _json.loads(request.read())
        seen_sizes.append(len(payload["input"]))
        return httpx.Response(
            200,
            json={
                "vectors": [[0.1] * 768 for _ in range(len(payload["input"]))],
                "request_id": "rq",
            },
        )

    respx.post(f"{BASE}/internal/providers/embed").mock(side_effect=_embed)
    await embed_chunks(client, job_id="job_x", provider="workers_ai", chunks=chunks)
    # 200 / 96 = ceil(2.08) = 3 batches: 96 + 96 + 8
    assert seen_sizes == [96, 96, 8]
    await client.aclose()


def test_input_hash_is_stable_sha256() -> None:
    text = "hello"
    assert _hash_text(text) == hashlib.sha256(b"hello").hexdigest()
    assert len(_hash_text(text)) == 64
