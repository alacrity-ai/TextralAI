"""SSE parser. Async-only — sync streaming is uncommon in real
Python codebases (most consumers want non-blocking IO), and
mirroring AsyncIterator semantics across both flavors would
double the surface for marginal value.

Same parsing rules as @textral/sdk's stream.ts: frames terminated
by `\\n\\n`, `data:` and `data: ` prefixes both accepted, `[DONE]`
ends the stream. Streams are NOT retried (per design); transport
or parse failure raises `TextralStreamInterrupted`.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterable, AsyncIterator
from typing import Any

import httpx

from .errors import TextralStreamInterrupted

_DONE = object()


def _parse_frame(frame: str) -> Any | object | None:
    """Parse one `data:`-prefixed frame block. Returns:
      * `_DONE` sentinel for `data: [DONE]`
      * None for empty / comment-only frames
      * parsed JSON otherwise
    Raises TextralStreamInterrupted on malformed JSON."""
    data_lines: list[str] = []
    for line in frame.split("\n"):
        if line.startswith("data: "):
            data_lines.append(line[6:])
        elif line.startswith("data:"):
            data_lines.append(line[5:])
        # else: ignore (comments / event-name / id)
    if not data_lines:
        return None
    payload = "\n".join(data_lines).strip()
    if not payload:
        return None
    if payload == "[DONE]":
        return _DONE
    try:
        return json.loads(payload)
    except json.JSONDecodeError as e:
        raise TextralStreamInterrupted(f"malformed SSE data frame: {e}") from e


async def stream_sse(response: httpx.Response) -> AsyncIterator[Any]:
    """Iterate SSE frames from a streaming httpx response. Yields
    one parsed JSON value per `data:` block; stops on `[DONE]`;
    raises `TextralStreamInterrupted` on premature end-of-stream
    or malformed payload.

    Caller owns the response lifecycle (we read but don't open or
    close)."""
    buffer = ""
    try:
        async for chunk in response.aiter_text():
            buffer += chunk
            while "\n\n" in buffer:
                frame, _, buffer = buffer.partition("\n\n")
                payload = _parse_frame(frame)
                if payload is _DONE:
                    return
                if payload is not None:
                    yield payload
    except httpx.HTTPError as e:
        raise TextralStreamInterrupted(f"transport error: {e}") from e

    # Reached end-of-stream without [DONE]. Best-effort flush, then
    # surface the soft interruption.
    if buffer.strip():
        try:
            payload = _parse_frame(buffer)
            if payload is not None and payload is not _DONE:
                yield payload
        except TextralStreamInterrupted:
            pass
    raise TextralStreamInterrupted("stream ended before [DONE] frame")


# Re-export for ergonomics.
__all__ = ["stream_sse"]
_ = AsyncIterable  # silence unused import for the type-only re-export
