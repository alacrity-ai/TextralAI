"""07_paginate_events.py — Walk every query event in a namespace.

Demonstrates: `iterate_*` cursor-pagination iterators, early
termination via break, sync + async parity.

Env: same as 01_quick_start.py.

Run:
    python 07_paginate_events.py

See also:
    docs/development/sdks/SDK_COOKBOOK_OUTLINE.md §8
"""

from __future__ import annotations

import asyncio
import os

from textral import AsyncClient, Client

NAMESPACE = os.environ.get("TEXTRAL_NAMESPACE", "cookbook")


def demo_sync() -> None:
    with Client() as client:
        count = 0
        for ev in client.query_events.iterate(namespace_slug=NAMESPACE, limit=25):
            count += 1
            if count <= 5:
                print(f"  {ev.get('id')}  {ev.get('status')}")
            if count >= 50:
                # Early termination — pagination stops fetching the
                # next page when you break out of the iterator.
                break
        print(f"sync total walked: {count}")


async def demo_async() -> None:
    async with AsyncClient() as client:
        count = 0
        async for ev in client.query_events.iterate(
            namespace_slug=NAMESPACE, limit=25
        ):
            count += 1
            if count >= 50:
                break
        print(f"async total walked: {count}")


def main() -> None:
    print("=== sync pagination ===")
    demo_sync()
    print("\n=== async pagination ===")
    asyncio.run(demo_async())


if __name__ == "__main__":
    main()
