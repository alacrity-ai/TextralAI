"""Pagination iterator tests — sync + async, both flavors hit the
same underlying logic so the asserts mirror each other."""

from __future__ import annotations

from typing import Any

import pytest

from textral._paginate import paginate, paginate_async


def test_paginate_walks_all_pages() -> None:
    pages = [
        {"data": [1, 2], "next_cursor": "c1"},
        {"data": [3, 4], "next_cursor": "c2"},
        {"data": [5], "next_cursor": None},
    ]
    seen_cursors: list[str | None] = []

    def fetcher(cursor: str | None) -> dict[str, Any]:
        seen_cursors.append(cursor)
        return pages.pop(0)

    result = list(paginate(fetcher))
    assert result == [1, 2, 3, 4, 5]
    assert seen_cursors == [None, "c1", "c2"]


def test_paginate_single_page() -> None:
    def fetcher(cursor: str | None) -> dict[str, Any]:
        return {"data": [42], "next_cursor": None}

    assert list(paginate(fetcher)) == [42]


def test_paginate_empty() -> None:
    def fetcher(cursor: str | None) -> dict[str, Any]:
        return {"data": [], "next_cursor": None}

    assert list(paginate(fetcher)) == []


def test_paginate_can_break_early() -> None:
    """Caller should be able to break out of the iterator without
    fetching further pages."""
    pages_consumed = {"n": 0}
    pages = [
        {"data": [1, 2], "next_cursor": "c1"},
        {"data": [3, 4], "next_cursor": "c2"},
        {"data": [5], "next_cursor": None},
    ]

    def fetcher(cursor: str | None) -> dict[str, Any]:
        pages_consumed["n"] += 1
        return pages.pop(0)

    out = []
    for item in paginate(fetcher):
        out.append(item)
        if item == 2:
            break
    assert out == [1, 2]
    assert pages_consumed["n"] == 1  # second page never fetched


@pytest.mark.asyncio
async def test_paginate_async_walks_all_pages() -> None:
    pages = [
        {"data": [1, 2], "next_cursor": "c1"},
        {"data": [3], "next_cursor": None},
    ]

    async def fetcher(cursor: str | None) -> dict[str, Any]:
        return pages.pop(0)

    result: list[int] = []
    async for item in paginate_async(fetcher):
        result.append(item)
    assert result == [1, 2, 3]


@pytest.mark.asyncio
async def test_paginate_async_empty() -> None:
    async def fetcher(cursor: str | None) -> dict[str, Any]:
        return {"data": [], "next_cursor": None}

    result: list[int] = []
    async for item in paginate_async(fetcher):
        result.append(item)
    assert result == []
