"""Fetch stage — POSTs to /internal/r2/object with HMAC, receives bytes
streamed back through the Worker."""

from __future__ import annotations

import httpx
import pytest
import respx

from app.clients.worker import WorkerClient, WorkerError
from app.stages.fetch import fetch_source, stage_metadata


SECRET = "s"
BASE = "http://w"


@respx.mock
async def test_fetch_source_returns_bytes_from_worker_proxy() -> None:
    client = WorkerClient(base_url=BASE, secret=SECRET)
    body = b"hello world"
    respx.post(f"{BASE}/internal/r2/object").mock(
        return_value=httpx.Response(
            200, content=body, headers={"content-type": "text/plain"}
        )
    )
    out = await fetch_source(client, job_id="job_x", source_r2_key="t/n/d/v.txt")
    assert out == body
    await client.aclose()


@respx.mock
async def test_fetch_source_propagates_worker_error_on_404() -> None:
    client = WorkerClient(base_url=BASE, secret=SECRET)
    respx.post(f"{BASE}/internal/r2/object").mock(
        return_value=httpx.Response(
            404, json={"error": {"code": "UPLOAD_INTENT_NOT_FOUND"}}
        )
    )
    with pytest.raises(WorkerError) as ei:
        await fetch_source(client, job_id="job_x", source_r2_key="x")
    assert ei.value.status == 404
    await client.aclose()


def test_stage_metadata_round_trips() -> None:
    md = stage_metadata(1024, "text/plain")
    assert md == {"file_size": 1024, "content_type": "text/plain"}
    md = stage_metadata(0, None)
    assert md["content_type"] == "application/octet-stream"
