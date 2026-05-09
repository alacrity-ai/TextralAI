"""SDK error hierarchy. Mirrors @textral/sdk's TS errors so the
two SDKs raise/throw the same shapes for the same conditions.

  TextralError                     — base for all SDK exceptions
   ├── TextralAPIError             — 4xx/5xx with envelope
   ├── TextralRetryExhausted       — retry policy gave up
   ├── TextralStreamInterrupted    — SSE stream cut before [DONE]
   └── TextralProfileNotFound      — profile resolution failed
"""

from __future__ import annotations

from typing import Any


class TextralError(Exception):
    """Base for all textral exceptions."""


class TextralAPIError(TextralError):
    """Server returned a non-2xx envelope.

    Attributes mirror @textral/sdk's TextralApiError:
      * status_code  — HTTP status
      * code         — the canonical error code from the envelope
      * message      — human-readable detail
      * request_id   — server-side correlation id (when present)
      * details      — extra structured info (when present)
      * retry_after  — parsed `Retry-After` header (seconds, when present)
    """

    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        request_id: str | None = None,
        details: dict[str, Any] | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.status_code = status_code
        self.code = code
        self.message = message
        self.request_id = request_id
        self.details = details
        self.retry_after = retry_after


class TextralRetryExhausted(TextralError):
    """Retry policy gave up after `attempts` retries. The original
    final error is in `__cause__` (PEP 3134) so call sites can
    inspect via `raise X from Y` semantics."""

    def __init__(self, attempts: int, last_error: BaseException) -> None:
        super().__init__(
            f"retries exhausted after {attempts} attempt"
            f"{'' if attempts == 1 else 's'}: {last_error}"
        )
        self.attempts = attempts
        self.last_error = last_error


class TextralStreamInterrupted(TextralError):
    """An SSE stream ended before the canonical `[DONE]` frame, or a
    transport error fired mid-stream. Streams are deliberately not
    retried by the SDK (per design); the caller decides whether to
    re-issue."""


class TextralProfileNotFound(TextralError):
    """Named profile missing from `~/.textral/profiles.toml`, or no
    precedence rung produced credentials. `profile_name` is the name
    the caller asked for (or '<unspecified>' when no rung produced
    one)."""

    def __init__(self, profile_name: str, message: str) -> None:
        super().__init__(message)
        self.profile_name = profile_name
