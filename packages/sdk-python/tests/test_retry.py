"""Retry policy tests. Cover:
  * Idempotent-POST allowlist (allowed routes retry; others don't)
  * Status filter (retry on 5xx + 429, not 4xx)
  * Exhaustion → TextralRetryExhausted
  * Backoff math (Retry-After honored, otherwise exponential + jitter)
  * Sync + async parity
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from textral._retry import (
    DEFAULT_RETRY,
    RequestContext,
    RetryInfo,
    RetryPolicy,
    normalize_path,
    parse_retry_after,
    with_retry,
    with_retry_async,
)
from textral.errors import TextralAPIError, TextralRetryExhausted


def _api_err(status: int, *, retry_after: float | None = None) -> TextralAPIError:
    return TextralAPIError(
        status_code=status,
        code=f"E{status}",
        message="boom",
        retry_after=retry_after,
    )


def _ctx(method: str = "GET", path: str = "/v1/me") -> RequestContext:
    return RequestContext(method=method.upper(), route_pattern=path)


# Use a fast policy — we don't want real backoff sleeping in tests.
_FAST = RetryPolicy(max_attempts=3, initial_delay_ms=0, max_delay_ms=0)


def test_returns_value_on_first_try() -> None:
    calls = {"n": 0}

    def f() -> int:
        calls["n"] += 1
        return 42

    assert with_retry(f, _FAST, _ctx()) == 42
    assert calls["n"] == 1


def test_retries_on_503_then_succeeds() -> None:
    calls = {"n": 0}

    def f() -> int:
        calls["n"] += 1
        if calls["n"] < 2:
            raise _api_err(503)
        return 7

    assert with_retry(f, _FAST, _ctx()) == 7
    assert calls["n"] == 2


def test_retries_exhausted_on_persistent_503() -> None:
    def f() -> int:
        raise _api_err(503)

    with pytest.raises(TextralRetryExhausted) as exc:
        with_retry(f, _FAST, _ctx())
    assert exc.value.attempts == 3
    assert isinstance(exc.value.last_error, TextralAPIError)


def test_no_retry_on_4xx() -> None:
    def f() -> int:
        raise _api_err(400)

    with pytest.raises(TextralAPIError):
        with_retry(f, _FAST, _ctx())


def test_no_retry_on_post_unless_allowlisted() -> None:
    """Default POST routes are NOT retried even on 503."""
    calls = {"n": 0}

    def f() -> int:
        calls["n"] += 1
        raise _api_err(503)

    with pytest.raises(TextralAPIError):
        with_retry(f, _FAST, _ctx("POST", "/v1/namespaces"))
    assert calls["n"] == 1  # not retried


def test_post_retried_when_on_allowlist() -> None:
    """The bulk submit endpoint IS on the allowlist."""
    calls = {"n": 0}

    def f() -> int:
        calls["n"] += 1
        if calls["n"] < 3:
            raise _api_err(503)
        return 9

    assert with_retry(f, _FAST, _ctx("POST", "/v1/ingest/bulk")) == 9
    assert calls["n"] == 3


def test_normalize_path_strips_ulids() -> None:
    """Per design: route patterns must be ULID-agnostic so the
    allowlist matches across all bulk-job ids."""
    assert (
        normalize_path("/v1/ingest/bulk/bjk_01HZQ123ABCDEFGHIJK0123456/finalize")
        == "/v1/ingest/bulk/{id}/finalize"
    )
    assert normalize_path("/v1/me") == "/v1/me"
    assert normalize_path("/v1/me?foo=1") == "/v1/me"


def test_post_finalize_retried() -> None:
    calls = {"n": 0}

    def f() -> int:
        calls["n"] += 1
        raise _api_err(503)

    # Real ULID, normalized into the allowlist pattern.
    path = "/v1/ingest/bulk/bjk_01HZQ123ABCDEFGHIJK0123456/finalize"
    ctx = RequestContext(method="POST", route_pattern=normalize_path(path))
    with pytest.raises(TextralRetryExhausted):
        with_retry(f, _FAST, ctx)
    assert calls["n"] == 3


def test_parse_retry_after_seconds() -> None:
    assert parse_retry_after("5") == 5.0
    assert parse_retry_after("0") == 0.0
    assert parse_retry_after(None) is None
    assert parse_retry_after("garbage") is None


def test_parse_retry_after_http_date() -> None:
    # 1 hour from now (UTC) — should yield ~3600s.
    import email.utils

    future = time.time() + 3600
    header = email.utils.formatdate(future, usegmt=True)
    parsed = parse_retry_after(header)
    assert parsed is not None
    assert 3500 < parsed < 3700


def test_retry_honors_retry_after() -> None:
    """When the server says Retry-After: 0, we use 0 instead of
    default backoff. This implicitly verifies _compute_delay's
    Retry-After branch."""
    delays: list[int] = []
    pol = RetryPolicy(
        max_attempts=2,
        initial_delay_ms=10_000,  # Would normally sleep 10s.
        max_delay_ms=10_000,
        on_retry=lambda info: delays.append(info.delay_ms),
    )

    def f() -> None:
        raise _api_err(503, retry_after=0.0)

    with pytest.raises(TextralRetryExhausted):
        with_retry(f, pol, _ctx())

    assert delays == [0]  # Retry-After=0 won out over 10s default


def test_on_retry_called() -> None:
    seen: list[RetryInfo] = []
    pol = RetryPolicy(max_attempts=3, initial_delay_ms=0, max_delay_ms=0, on_retry=seen.append)

    def f() -> None:
        raise _api_err(503)

    with pytest.raises(TextralRetryExhausted):
        with_retry(f, pol, _ctx())

    assert len(seen) == 2  # 2 retries between 3 attempts
    assert seen[0].attempt == 1
    assert seen[0].status == 503
    assert seen[1].attempt == 2


def test_no_retry_on_keyboard_interrupt() -> None:
    calls = {"n": 0}

    def f() -> None:
        calls["n"] += 1
        raise KeyboardInterrupt()

    with pytest.raises(KeyboardInterrupt):
        with_retry(f, _FAST, _ctx())
    assert calls["n"] == 1


def test_default_retry_has_three_attempts() -> None:
    """Sanity check: don't accidentally lower the global default."""
    assert DEFAULT_RETRY.max_attempts == 3
    assert 429 in DEFAULT_RETRY.retry_on
    assert 503 in DEFAULT_RETRY.retry_on


# ── async parity ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_async_returns_value() -> None:
    async def f() -> int:
        return 42

    assert await with_retry_async(f, _FAST, _ctx()) == 42


@pytest.mark.asyncio
async def test_async_retries_on_503() -> None:
    calls = {"n": 0}

    async def f() -> int:
        calls["n"] += 1
        if calls["n"] < 2:
            raise _api_err(503)
        return 7

    assert await with_retry_async(f, _FAST, _ctx()) == 7
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_async_retries_exhausted() -> None:
    async def f() -> int:
        raise _api_err(503)

    with pytest.raises(TextralRetryExhausted):
        await with_retry_async(f, _FAST, _ctx())


@pytest.mark.asyncio
async def test_async_cancellation_not_retried() -> None:
    calls = {"n": 0}

    async def f() -> int:
        calls["n"] += 1
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await with_retry_async(f, _FAST, _ctx())
    assert calls["n"] == 1


# Suppress unused-import warning for typing-only Any.
_ = Any
