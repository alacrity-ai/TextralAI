"""Signed back-channel client. Every Container → Worker request carries
HMAC-SHA-256 + timestamp headers verified by middleware/internal-auth.ts.

The Container is `httpx`-based, talks to the Worker via the URL passed
through the WORKER_INTERNAL_URL env var. In production the Worker stub
forwards through the Durable Object binding; this client is what the
Container code actually calls."""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Any

import httpx


class WorkerClient:
    """Singleton-ish helper. One per ingestion job is fine; one per
    Container instance is more typical."""

    def __init__(
        self,
        base_url: str | None = None,
        secret: str | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("WORKER_INTERNAL_URL", "")).rstrip("/")
        self.secret = secret or os.environ.get("INTERNAL_HMAC_SECRET", "")
        if not self.base_url or not self.secret:
            raise RuntimeError(
                "WorkerClient requires WORKER_INTERNAL_URL + INTERNAL_HMAC_SECRET",
            )
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0))

    async def aclose(self) -> None:
        await self._http.aclose()

    def _sign(self, method: str, path: str, body: bytes) -> dict[str, str]:
        ts = str(int(time.time() * 1000))
        body_hash = hashlib.sha256(body).hexdigest()
        canonical = f"{method.upper()}\n{path}\n{body_hash}\n{ts}"
        sig = hmac.new(
            self.secret.encode("utf-8"),
            canonical.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return {
            "x-textral-internal-timestamp": ts,
            "x-textral-internal-signature": sig,
            "content-type": "application/json",
        }

    async def post_json(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        import json

        body_bytes = json.dumps(body).encode("utf-8")
        headers = self._sign("POST", path, body_bytes)
        url = f"{self.base_url}{path}"
        res = await self._http.post(url, content=body_bytes, headers=headers)
        if res.status_code >= 400:
            try:
                err = res.json()
            except Exception:  # noqa: BLE001
                err = {"raw": res.text}
            raise WorkerError(
                f"{method_for(path)} {path} failed: {res.status_code}",
                status=res.status_code,
                body=err,
            )
        return res.json()

    async def get_json(self, path: str) -> dict[str, Any]:
        headers = self._sign("GET", path, b"")
        url = f"{self.base_url}{path}"
        res = await self._http.get(url, headers=headers)
        if res.status_code >= 400:
            try:
                err = res.json()
            except Exception:  # noqa: BLE001
                err = {"raw": res.text}
            raise WorkerError(
                f"GET {path} failed: {res.status_code}",
                status=res.status_code,
                body=err,
            )
        return res.json()

    async def post_bytes(self, path: str, body: dict[str, Any]) -> bytes:
        """POST a JSON body and receive raw bytes (e.g. R2 object reads
        proxied through the Worker)."""
        import json

        body_bytes = json.dumps(body).encode("utf-8")
        headers = self._sign("POST", path, body_bytes)
        url = f"{self.base_url}{path}"
        res = await self._http.post(url, content=body_bytes, headers=headers)
        if res.status_code >= 400:
            try:
                err = res.json()
            except Exception:  # noqa: BLE001
                err = {"raw": res.text}
            raise WorkerError(
                f"POST {path} (bytes) failed: {res.status_code}",
                status=res.status_code,
                body=err,
            )
        return res.content


class WorkerError(Exception):
    def __init__(self, msg: str, status: int, body: Any) -> None:  # noqa: ANN401
        super().__init__(msg)
        self.status = status
        self.body = body


def method_for(path: str) -> str:
    # Cosmetic — error messages prefer the actual method.
    return "POST" if path != "/internal/jobs/" else "GET"
