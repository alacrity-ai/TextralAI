"""Retry policy for SDK requests. 1:1 mirror of
@textral/sdk's retry.ts so the two SDKs behave identically under
transient failure:

  * Up to N attempts (default 3).
  * Exponential backoff with ±25% jitter, capped at max_delay_ms.
  * Honors Retry-After when present.
  * GET/DELETE always retried; POST only on the idempotent
    allowlist (server-side dedupe makes those safe).
  * Raises `TextralRetryExhausted` when the policy gives up.
  * Returns the original exception unchanged for non-retryable
    errors.

Cancellation: `signal` parameter is not used (Python uses
`asyncio.wait_for` / native `KeyboardInterrupt` at the call-site
level — see _http.py for the integration with httpx timeouts).
"""

from __future__ import annotations

import asyncio
import random
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import TypeVar

from .errors import TextralAPIError, TextralRetryExhausted

T = TypeVar("T")


# Routes whose POST handlers are server-side idempotent and
# therefore safe to retry. Patterns are matched against the route
# AFTER `_normalize_path()` has replaced ULID-shaped segments with
# `{id}`. Adding here requires server-side dedupe / no-op-on-
# duplicate semantics.
DEFAULT_IDEMPOTENT_POSTS: tuple[str, ...] = (
    "POST /v1/auth/redeem",
    "POST /v1/auth/register",
    "POST /v1/auth/recover",
    "POST /v1/ingest/bulk",
    "POST /v1/ingest/bulk/{id}/finalize",
    "POST /v1/documents/{id}/uploads/{id}/finalize",
)


@dataclass
class RetryInfo:
    """Passed to the on_retry hook on every retry-eligible failure
    BEFORE the backoff sleep."""

    attempt: int
    """1-indexed; first attempt is 1, first retry is 2."""
    status: int | None
    """HTTP status (None for transport-level errors)."""
    delay_ms: int
    """Sleep before the next attempt."""
    error: BaseException


@dataclass
class RetryPolicy:
    """Configurable retry behavior. Mirrors the TS-side defaults."""

    max_attempts: int = 3
    initial_delay_ms: int = 200
    max_delay_ms: int = 5_000
    retry_on: tuple[int, ...] = (429, 502, 503, 504)
    on_retry: Callable[[RetryInfo], None] | None = None
    retry_on_post_methods: tuple[str, ...] = field(
        default_factory=lambda: DEFAULT_IDEMPOTENT_POSTS
    )


DEFAULT_RETRY = RetryPolicy()
"""Idiomatic default — 3 attempts, exponential backoff, retry on
429/5xx, idempotent-POST allowlist as documented in the design."""


# Sentinel for "no retry at all". Pass `retry=NO_RETRY` (or
# `retry=None`) to the Client constructor to disable retries.
NO_RETRY = RetryPolicy(
    max_attempts=1,
    initial_delay_ms=0,
    max_delay_ms=0,
    retry_on=(),
    retry_on_post_methods=(),
)


@dataclass(frozen=True)
class RequestContext:
    """The route context for one HTTP call. The retry layer reads
    `method` + `route_pattern` to decide whether the call is
    eligible for retry."""

    method: str
    """Uppercased HTTP method."""
    route_pattern: str
    """The path with ULID segments normalized to `{id}`. Used for
    idempotent-POST allowlist matching."""


_ULID_SEGMENT = re.compile(r"/[a-z]{2,5}_[A-Z0-9]{26}")


def normalize_path(path: str) -> str:
    """Replace prefixed-ULID segments with `{id}` and drop query
    string. Used to build a stable route pattern for the retry
    allowlist regardless of which document/version/job id the path
    references."""
    base = path.split("?", 1)[0]
    return _ULID_SEGMENT.sub("/{id}", base)


def parse_retry_after(value: str | None) -> float | None:
    """Parse a `Retry-After` header. Accepts seconds-as-int or
    HTTP-date. Returns seconds (float), or None when missing or
    unparseable."""
    if not value:
        return None
    s = value.strip()
    # Plain seconds.
    try:
        seconds = float(s)
        return max(0.0, seconds)
    except ValueError:
        pass
    # HTTP-date.
    try:
        when = parsedate_to_datetime(s)
        delta = when.timestamp() - time.time()
        return max(0.0, delta)
    except (TypeError, ValueError):
        return None


def _is_retryable_error(
    err: BaseException, policy: RetryPolicy, ctx: RequestContext
) -> bool:
    # Cancellation / explicit interrupt is never retried.
    if isinstance(err, (asyncio.CancelledError, KeyboardInterrupt)):
        return False

    # POST methods need to be on the idempotent allowlist.
    if ctx.method == "POST":
        target = f"{ctx.method} {ctx.route_pattern}"
        if target not in policy.retry_on_post_methods:
            return False

    # API-shaped error: retry on declared statuses.
    if isinstance(err, TextralAPIError):
        return err.status_code in policy.retry_on

    # Transport-level (httpx.ConnectError, TimeoutException, etc.)
    # → retryable by default.
    return True


def _compute_delay(attempt: int, policy: RetryPolicy, err: BaseException) -> int:
    """Either Retry-After (when the server told us when to come
    back) or exponential backoff with ±25% jitter."""
    if isinstance(err, TextralAPIError) and err.retry_after is not None:
        return min(int(err.retry_after * 1000), policy.max_delay_ms)
    base = min(
        policy.initial_delay_ms * (2 ** (attempt - 1)),
        policy.max_delay_ms,
    )
    jitter = base * 0.25 * (random.random() * 2 - 1)
    return max(0, int(base + jitter))


# ── Sync + async runners. Sister functions; the policy semantics
# are identical, only the awaiter differs.


def with_retry(
    fn: Callable[[], T],
    policy: RetryPolicy,
    ctx: RequestContext,
) -> T:
    """Synchronous retry wrapper.

    Returns whatever `fn()` returns; raises the underlying error
    when not retryable; raises `TextralRetryExhausted` when the
    policy gives up after max_attempts attempts on a retryable
    error."""
    last_error: BaseException | None = None
    for attempt in range(1, policy.max_attempts + 1):
        try:
            return fn()
        except BaseException as err:
            last_error = err
            if not _is_retryable_error(err, policy, ctx):
                raise
            if attempt >= policy.max_attempts:
                raise TextralRetryExhausted(policy.max_attempts, err) from err
            status = err.status_code if isinstance(err, TextralAPIError) else None
            delay_ms = _compute_delay(attempt, policy, err)
            if policy.on_retry:
                policy.on_retry(
                    RetryInfo(
                        attempt=attempt,
                        status=status,
                        delay_ms=delay_ms,
                        error=err,
                    )
                )
            time.sleep(delay_ms / 1000.0)

    # Defensive — the loop body always returns or raises.
    if last_error is not None:
        raise TextralRetryExhausted(policy.max_attempts, last_error) from last_error
    raise RuntimeError("with_retry exited without a result")  # pragma: no cover


async def with_retry_async(
    fn: Callable[[], Awaitable[T]],
    policy: RetryPolicy,
    ctx: RequestContext,
) -> T:
    """Async retry wrapper — same semantics, awaitable runner."""
    last_error: BaseException | None = None
    for attempt in range(1, policy.max_attempts + 1):
        try:
            return await fn()
        except BaseException as err:
            last_error = err
            if not _is_retryable_error(err, policy, ctx):
                raise
            if attempt >= policy.max_attempts:
                raise TextralRetryExhausted(policy.max_attempts, err) from err
            status = err.status_code if isinstance(err, TextralAPIError) else None
            delay_ms = _compute_delay(attempt, policy, err)
            if policy.on_retry:
                policy.on_retry(
                    RetryInfo(
                        attempt=attempt,
                        status=status,
                        delay_ms=delay_ms,
                        error=err,
                    )
                )
            await asyncio.sleep(delay_ms / 1000.0)

    if last_error is not None:
        raise TextralRetryExhausted(policy.max_attempts, last_error) from last_error
    raise RuntimeError("with_retry_async exited without a result")  # pragma: no cover


