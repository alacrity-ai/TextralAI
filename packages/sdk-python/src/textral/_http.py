"""Single HTTP chokepoint shared by Client + AsyncClient.

Responsibilities (in one place so retry / auth / profile resolution
can't drift between sync and async):

  * Compose the absolute URL from base_url + path.
  * Inject the `X-Textral-Api-Key` header.
  * Wrap the request in `with_retry(...)`.
  * Unwrap 4xx/5xx envelopes into TextralAPIError.
  * Capture `Retry-After` on the error so retry can honor it.
  * Apply the per-request timeout (default 30s).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx

from ._retry import (
    DEFAULT_RETRY,
    NO_RETRY,
    RequestContext,
    RetryPolicy,
    normalize_path,
    parse_retry_after,
    with_retry,
    with_retry_async,
)
from .errors import TextralAPIError
from .profile import Profile, resolve_profile


class _BaseHttp:
    """Shared init logic between SyncHttp + AsyncHttp."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        profile: str | None = None,
        retry: RetryPolicy | None = None,
        timeout: float = 30.0,
    ) -> None:
        if (base_url and api_key):
            self._profile: Profile = Profile(
                name="_explicit", base_url=base_url, api_key=api_key
            )
        elif profile is not None or (not base_url and not api_key):
            self._profile = resolve_profile(name=profile)
        else:
            raise ValueError(
                "Client: either base_url+api_key, or profile=, or no args at all "
                "(falling back to the default precedence chain) must be supplied."
            )
        self._base_url = self._profile.base_url.rstrip("/")
        self._headers = {
            "x-textral-api-key": self._profile.api_key,
            "accept": "application/json",
        }
        self._retry = retry if retry is not None else DEFAULT_RETRY
        self._timeout = timeout

    def _url(self, path: str) -> str:
        if path.startswith(("http://", "https://")):
            return path
        return f"{self._base_url}{path}"

    def _ctx(self, method: str, path: str) -> RequestContext:
        # Drop query string + normalize ULID segments so the
        # idempotent-POST allowlist matches against stable patterns.
        if path.startswith(("http://", "https://")):
            from urllib.parse import urlparse

            path = urlparse(path).path
        return RequestContext(method=method.upper(), route_pattern=normalize_path(path))

    def _unwrap_error(self, resp: httpx.Response) -> None:
        """Raise TextralAPIError from a non-2xx response. Captures
        Retry-After so the retry layer can honor it."""
        retry_after = parse_retry_after(resp.headers.get("retry-after"))
        try:
            envelope = resp.json()
            err = envelope.get("error", {}) if isinstance(envelope, dict) else {}
            raise TextralAPIError(
                status_code=resp.status_code,
                code=err.get("code", "UNKNOWN"),
                message=err.get("message", resp.reason_phrase or f"HTTP {resp.status_code}"),
                request_id=err.get("request_id"),
                details=err.get("details"),
                retry_after=retry_after,
            )
        except (ValueError, TypeError) as e:
            if isinstance(e, TextralAPIError):
                raise
            raise TextralAPIError(
                status_code=resp.status_code,
                code="UNKNOWN",
                message=resp.text or f"HTTP {resp.status_code}",
                retry_after=retry_after,
            ) from e


class SyncHttp(_BaseHttp):
    """httpx.Client wrapper with retry + auth + envelope unwrap."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # Allow callers (mostly tests) to override the underlying
        # httpx client by setting `.client` after construction.
        self.client: httpx.Client = httpx.Client(timeout=self._timeout)

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        ctx = self._ctx(method, path)
        url = self._url(path)
        merged_headers = {**self._headers, **(headers or {})}

        def fire() -> Any:
            resp = self.client.request(
                method,
                url,
                json=json,
                params=params,
                headers=merged_headers,
            )
            if resp.status_code == 204:
                return None
            if not resp.is_success:
                self._unwrap_error(resp)
            if not resp.content:
                return None
            return resp.json()

        if self._retry is NO_RETRY or self._retry.max_attempts == 1:
            return fire()
        return with_retry(fire, self._retry, ctx)

    def stream_response(
        self,
        method: str,
        path: str,
        *,
        json: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> httpx.Response:
        """Open a streaming response. Caller owns the lifecycle —
        use as `with client.stream_response(...) as r: ...`. The
        returned Response is from `client.stream(...)` — yes the
        contextmanager is a separate concern; see _stream.py for
        the wrapper that consumes it."""
        ctx = self._ctx(method, path)
        url = self._url(path)
        merged_headers = {**self._headers, **(headers or {}), "accept": "text/event-stream"}
        # Streams are NOT retried — see design plan §4 Q7. We still
        # wrap the initial connect in the retry layer so 503s on
        # connect can recover; once we've yielded a frame, we stop.
        # For now the simplest correct posture is to skip retry on
        # streams entirely.
        del ctx  # unused for streams
        # httpx.Client.stream returns a context manager; caller
        # consumes via `with`. We return the manager directly.
        return self.client.stream(method, url, json=json, params=params, headers=merged_headers)  # type: ignore[return-value]


class AsyncHttp(_BaseHttp):
    """httpx.AsyncClient wrapper with retry + auth + envelope unwrap."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.client: httpx.AsyncClient = httpx.AsyncClient(timeout=self._timeout)

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        ctx = self._ctx(method, path)
        url = self._url(path)
        merged_headers = {**self._headers, **(headers or {})}

        async def fire() -> Any:
            resp = await self.client.request(
                method,
                url,
                json=json,
                params=params,
                headers=merged_headers,
            )
            if resp.status_code == 204:
                return None
            if not resp.is_success:
                self._unwrap_error(resp)
            if not resp.content:
                return None
            return resp.json()

        if self._retry is NO_RETRY or self._retry.max_attempts == 1:
            return await fire()
        return await with_retry_async(fire, self._retry, ctx)

    def stream_response(
        self,
        method: str,
        path: str,
        *,
        json: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        """Open a streaming response (async). Returns the
        AsyncClient.stream context manager. Use as
        `async with http.stream_response(...) as resp: ...`."""
        url = self._url(path)
        merged_headers = {**self._headers, **(headers or {}), "accept": "text/event-stream"}
        return self.client.stream(method, url, json=json, params=params, headers=merged_headers)
