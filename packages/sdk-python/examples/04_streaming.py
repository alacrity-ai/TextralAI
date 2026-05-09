"""04_streaming.py — Stream answer tokens as the model emits them.

Demonstrates: AsyncClient.query.stream(), early-termination via
break, the canonical SSE event taxonomy.

Env: same as 01_quick_start.py.

Run:
    python 04_streaming.py

See also:
    docs/development/sdks/SDK_COOKBOOK_OUTLINE.md §5
"""

from __future__ import annotations

import asyncio
import os
import sys

from textral import AsyncClient

PROVIDER_KEY_REF = os.environ.get("TEXTRAL_PROVIDER_KEY_REF", "openai")
NAMESPACE = os.environ.get("TEXTRAL_NAMESPACE", "cookbook")


async def main() -> None:
    async with AsyncClient() as client:
        token_count = 0
        async for frame in client.query.stream(
            namespace=NAMESPACE,
            query="Who was Hypatia, and what happened to her?",
            embedding={
                "provider": "openai",
                "model": "text-embedding-3-large",
                "dimensions": 1536,
                "provider_key_ref": PROVIDER_KEY_REF,
            },
            inference={
                "provider": "openai",
                "model": "gpt-4o-mini",
                "provider_key_ref": PROVIDER_KEY_REF,
            },
        ):
            event = frame.get("event")
            if event == "answer_token":
                sys.stdout.write(frame.get("value", ""))
                sys.stdout.flush()
                token_count += 1
            elif event == "citation":
                # Render each citation as we receive it; alternative
                # is to wait for `final` and render the whole list.
                pass
            elif event == "final":
                print()
                print(f"--- {token_count} tokens streamed ---")
                print(f"query_event_id: {frame.get('query_event_id')}")
                print(f"citations:      {len(frame.get('citations') or [])}")


if __name__ == "__main__":
    asyncio.run(main())
