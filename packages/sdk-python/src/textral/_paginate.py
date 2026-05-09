"""Pagination helpers — sync + async. Both wrap a cursor-based
fetcher closure into a stream of items, terminating on
`next_cursor is None`. Items are dict[str, Any] — the SDK keeps
the wire shape rather than forcing each call site to annotate the
underlying TypeVar."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from typing import Any


def paginate(
    fetcher: Callable[[str | None], dict[str, Any]],
) -> Iterator[dict[str, Any]]:
    """Synchronous pagination. The fetcher takes the current
    cursor (None on first call) and returns a dict with `data`
    (list[dict]) + `next_cursor` (str | None)."""
    cursor: str | None = None
    while True:
        page = fetcher(cursor)
        yield from page.get("data", [])
        cursor = page.get("next_cursor")
        if cursor is None:
            return


async def paginate_async(
    fetcher: Callable[[str | None], Awaitable[dict[str, Any]]],
) -> AsyncIterator[dict[str, Any]]:
    """Async sister. Same shape; async fetcher."""
    cursor: str | None = None
    while True:
        page = await fetcher(cursor)
        for item in page.get("data", []):
            yield item
        cursor = page.get("next_cursor")
        if cursor is None:
            return
