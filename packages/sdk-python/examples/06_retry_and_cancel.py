"""06_retry_and_cancel.py — Retry policy + cancellation patterns.

Demonstrates: custom RetryPolicy with on_retry hook, NO_RETRY for
opt-out, asyncio cancellation propagating through the SDK.

Env: same as 01_quick_start.py.

Run:
    python 06_retry_and_cancel.py

See also:
    docs/development/sdks/SDK_COOKBOOK_OUTLINE.md §7
"""

from __future__ import annotations

import asyncio
import os

from textral import (
    NO_RETRY,
    AsyncClient,
    Client,
    RetryInfo,
    RetryPolicy,
    TextralAPIError,
    TextralRetryExhausted,
)

PROVIDER_KEY_REF = os.environ.get("TEXTRAL_PROVIDER_KEY_REF", "openai")
NAMESPACE = os.environ.get("TEXTRAL_NAMESPACE", "cookbook")


def demo_custom_retry() -> None:
    """Inject an `on_retry` hook so you can log every retry decision.
    Useful for diagnosing transient prod issues without enabling
    full debug logging."""

    def log_retry(info: RetryInfo) -> None:
        print(
            f"[retry] attempt={info.attempt} "
            f"status={info.status} "
            f"delay_ms={info.delay_ms} "
            f"err={type(info.error).__name__}"
        )

    policy = RetryPolicy(
        max_attempts=4,
        initial_delay_ms=300,
        max_delay_ms=5_000,
        on_retry=log_retry,
    )

    with Client(retry=policy) as client:
        try:
            client.me()
        except TextralRetryExhausted as e:
            print(f"retries exhausted after {e.attempts}: {e.last_error}")
        except TextralAPIError as e:
            print(f"non-retryable api error: {e}")


def demo_no_retry() -> None:
    """Disable retry entirely (e.g. for a one-shot interactive
    REPL). Errors surface on the first attempt."""
    with Client(retry=NO_RETRY) as client:
        try:
            client.me()
        except TextralAPIError as e:
            print(f"first-shot error: {e}")


async def demo_cancellation() -> None:
    """Cancel a long-running streaming query mid-flight. The async
    cancellation propagates through httpx → the SDK's stream
    iterator releases the response."""
    async with AsyncClient() as client:

        async def reader() -> None:
            async for frame in client.query.stream(
                namespace=NAMESPACE,
                query="Tell me everything about ancient libraries",
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
                if frame.get("event") == "answer_token":
                    print(frame.get("value", ""), end="", flush=True)

        task = asyncio.create_task(reader())
        await asyncio.sleep(2.0)  # Let some tokens flow.
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            print("\n[cancelled]")


def main() -> None:
    print("=== custom retry ===")
    demo_custom_retry()
    print("\n=== no retry ===")
    demo_no_retry()
    print("\n=== cancellation ===")
    asyncio.run(demo_cancellation())


if __name__ == "__main__":
    main()
