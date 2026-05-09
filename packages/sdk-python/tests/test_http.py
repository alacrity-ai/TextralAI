"""End-to-end HTTP behavior tests via respx mock. Covers:
  * Header injection (x-textral-api-key)
  * URL composition (base + path)
  * Envelope unwrap → TextralAPIError
  * Streams reaching all the way through query.stream(...)
  * Resource methods serializing the right URL + body
"""

from __future__ import annotations

import pytest
import respx
from httpx import Response

from textral import AsyncClient, Client, TextralAPIError

_BASE = "https://api.test"


def _client(**overrides: object) -> Client:
    kwargs = {"base_url": _BASE, "api_key": "key-1"}
    kwargs.update(overrides)  # type: ignore[arg-type]
    return Client(**kwargs)  # type: ignore[arg-type]


@respx.mock
def test_me_succeeds() -> None:
    route = respx.get(f"{_BASE}/v1/me").mock(
        return_value=Response(200, json={"workspace_id": "ws_01"})
    )
    with _client() as c:
        out = c.me()
    assert out == {"workspace_id": "ws_01"}
    sent = route.calls.last.request
    assert sent.headers["x-textral-api-key"] == "key-1"


@respx.mock
def test_envelope_error_unwraps() -> None:
    respx.get(f"{_BASE}/v1/me").mock(
        return_value=Response(
            403,
            json={
                "error": {
                    "code": "FORBIDDEN",
                    "message": "no can do",
                    "request_id": "req_01",
                }
            },
        )
    )
    with _client() as c:
        with pytest.raises(TextralAPIError) as exc:
            c.me()
    assert exc.value.code == "FORBIDDEN"
    assert exc.value.status_code == 403
    assert exc.value.request_id == "req_01"


@respx.mock
def test_namespaces_create_serializes_body() -> None:
    route = respx.post(f"{_BASE}/v1/namespaces").mock(
        return_value=Response(201, json={"slug": "docs"})
    )
    with _client() as c:
        out = c.namespaces.create({"slug": "docs", "title": "Docs"})
    assert out == {"slug": "docs"}
    body = route.calls.last.request.read()
    assert b'"slug":"docs"' in body
    assert b'"title":"Docs"' in body


@respx.mock
def test_documents_list_chunks_passes_query_params() -> None:
    route = respx.get(f"{_BASE}/v1/documents/doc_01/chunks").mock(
        return_value=Response(200, json={"data": [], "next_cursor": None})
    )
    with _client() as c:
        c.documents.list_chunks("doc_01", limit=10, artifact_type="prose_chunk")
    sent = route.calls.last.request
    assert sent.url.params["limit"] == "10"
    assert sent.url.params["artifact_type"] == "prose_chunk"


@respx.mock
def test_iterate_documents_walks_pages() -> None:
    respx.get(f"{_BASE}/v1/namespaces/docs/documents").mock(
        side_effect=[
            Response(200, json={"data": [{"id": "d1"}], "next_cursor": "c1"}),
            Response(200, json={"data": [{"id": "d2"}], "next_cursor": None}),
        ]
    )
    with _client() as c:
        out = list(c.namespaces.iterate_documents("docs"))
    assert [d["id"] for d in out] == ["d1", "d2"]


@respx.mock
def test_query_serializes_full_body() -> None:
    route = respx.post(f"{_BASE}/v1/query").mock(
        return_value=Response(200, json={"answer": "ok"})
    )
    with _client() as c:
        c.query(
            namespace="docs",
            query="hi",
            embedding={"model": "voyage-3"},
            inference={"model": "claude-haiku-4-5"},
        )
    body = route.calls.last.request.read()
    assert b'"namespace":"docs"' in body
    assert b'"query":"hi"' in body


@respx.mock
def test_admin_iterate_failing_jobs_adapts_items_field() -> None:
    """Admin route returns `items`, not `data`. iterate_failing_jobs
    must adapt the shape so the iterator works."""
    respx.get(f"{_BASE}/v1/admin/ingestion-jobs").mock(
        side_effect=[
            Response(200, json={"items": [{"id": "j1"}], "next_cursor": "c1"}),
            Response(200, json={"items": [{"id": "j2"}], "next_cursor": None}),
        ]
    )
    with _client() as c:
        out = list(c.admin.iterate_failing_jobs())
    assert [j["id"] for j in out] == ["j1", "j2"]


# ── Async parity ────────────────────────────────────────────────


@pytest.mark.asyncio
@respx.mock
async def test_async_me_succeeds() -> None:
    respx.get(f"{_BASE}/v1/me").mock(return_value=Response(200, json={"workspace_id": "ws_01"}))
    async with AsyncClient(base_url=_BASE, api_key="key-1") as c:
        out = await c.me()
    assert out == {"workspace_id": "ws_01"}


@pytest.mark.asyncio
@respx.mock
async def test_async_query_stream() -> None:
    """Streaming end-to-end: SDK opens the SSE response, yields
    parsed frames, terminates on [DONE]."""
    sse_body = (
        'data: {"event":"chunk_meta","value":1}\n\n'
        'data: {"event":"answer_token","value":"hi"}\n\n'
        "data: [DONE]\n\n"
    )
    respx.post(f"{_BASE}/v1/query").mock(
        return_value=Response(
            200,
            content=sse_body,
            headers={"content-type": "text/event-stream"},
        )
    )
    async with AsyncClient(base_url=_BASE, api_key="key-1") as c:
        frames = []
        async for f in c.query.stream(
            namespace="docs",
            query="hi",
            embedding={"model": "voyage-3"},
            inference={"model": "claude-haiku-4-5"},
        ):
            frames.append(f)
    assert frames == [
        {"event": "chunk_meta", "value": 1},
        {"event": "answer_token", "value": "hi"},
    ]


@pytest.mark.asyncio
@respx.mock
async def test_async_iterate_documents() -> None:
    respx.get(f"{_BASE}/v1/namespaces/docs/documents").mock(
        side_effect=[
            Response(200, json={"data": [{"id": "d1"}], "next_cursor": "c1"}),
            Response(200, json={"data": [{"id": "d2"}], "next_cursor": None}),
        ]
    )
    async with AsyncClient(base_url=_BASE, api_key="key-1") as c:
        out = []
        async for d in c.namespaces.iterate_documents("docs"):
            out.append(d)
    assert [d["id"] for d in out] == ["d1", "d2"]
