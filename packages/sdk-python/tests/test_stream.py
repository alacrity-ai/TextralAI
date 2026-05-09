"""SSE parser tests. Exercises the frame-splitting + [DONE] +
malformed-payload paths against an in-memory httpx mock."""

from __future__ import annotations

import httpx
import pytest

from textral._stream import stream_sse
from textral.errors import TextralStreamInterrupted


async def _consume(resp: httpx.Response) -> list[object]:
    out: list[object] = []
    async for frame in stream_sse(resp):
        out.append(frame)
    return out


def _sse_response(body: str) -> httpx.Response:
    """Build an httpx.Response that streams a single chunk of
    SSE bytes. Uses a custom transport so aiter_text() actually
    yields the body."""
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content=body.encode("utf-8"),
    )


@pytest.mark.asyncio
async def test_basic_frames_then_done() -> None:
    body = (
        'data: {"event":"chunk_meta","value":1}\n\n'
        'data: {"event":"answer_token","value":"hi"}\n\n'
        "data: [DONE]\n\n"
    )
    frames = await _consume(_sse_response(body))
    assert frames == [
        {"event": "chunk_meta", "value": 1},
        {"event": "answer_token", "value": "hi"},
    ]


@pytest.mark.asyncio
async def test_frame_without_trailing_space_after_data() -> None:
    body = 'data:{"x":1}\n\ndata: [DONE]\n\n'
    frames = await _consume(_sse_response(body))
    assert frames == [{"x": 1}]


@pytest.mark.asyncio
async def test_comment_lines_ignored() -> None:
    body = ': heartbeat\n\ndata: {"x":1}\n\ndata: [DONE]\n\n'
    frames = await _consume(_sse_response(body))
    assert frames == [{"x": 1}]


@pytest.mark.asyncio
async def test_no_done_raises_interrupted() -> None:
    body = 'data: {"x":1}\n\n'  # no [DONE]
    with pytest.raises(TextralStreamInterrupted, match="before \\[DONE\\]"):
        await _consume(_sse_response(body))


@pytest.mark.asyncio
async def test_malformed_payload_raises_interrupted() -> None:
    body = "data: {not-json\n\ndata: [DONE]\n\n"
    with pytest.raises(TextralStreamInterrupted, match="malformed"):
        await _consume(_sse_response(body))


@pytest.mark.asyncio
async def test_empty_data_lines_skipped() -> None:
    body = "data: \n\ndata: [DONE]\n\n"
    frames = await _consume(_sse_response(body))
    assert frames == []
