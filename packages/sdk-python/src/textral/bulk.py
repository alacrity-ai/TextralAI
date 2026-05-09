"""High-level helper that drives the full bulk-ingest choreography
from a list of `(filename, bytes)` entries: submit manifest →
upload each file in parallel → optional finalize → poll until
terminal. 1:1 sister to @textral/sdk's `bulkIngestOrchestrate`.

Two flavors:
  * `bulk_ingest_orchestrate(client, ...)` — sync, ThreadPoolExecutor
    for parallel uploads.
  * `bulk_ingest_orchestrate_async(client, ...)` — async,
    asyncio.Semaphore for concurrency.

Defaults match TS:
  * concurrency = 6
  * poll_interval_ms = 1500
  * on_existing = "skip_if_unchanged"
  * auto_finalize = True
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:
    from .async_client import AsyncClient
    from .client import Client


_TERMINAL_STATES = frozenset({"complete", "partial", "failed", "cancelled", "expired"})


@dataclass(frozen=True)
class BulkOrchestrateFile:
    """One entry in the bulk submission. `bytes_` is the raw payload
    to PUT to the server-minted upload URL."""

    filename: str
    bytes_: bytes
    size_bytes: int
    content_type: str
    client_request_id: str | None = None


@dataclass(frozen=True)
class BulkOrchestrateResult:
    bulk_job_id: str
    final_status: dict[str, Any]


# ── Sync orchestrator ──────────────────────────────────────────


def bulk_ingest_orchestrate(
    client: Client,
    *,
    namespace: str,
    config: dict[str, Any],
    files: Sequence[BulkOrchestrateFile],
    on_existing: str = "skip_if_unchanged",
    auto_finalize: bool = True,
    client_request_id: str | None = None,
    concurrency: int = 6,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
    poll_interval_ms: int = 1500,
    source: str = "api",
) -> BulkOrchestrateResult:
    """Sync bulk-ingest orchestrator. Mirrors the TS version's
    behavior exactly, including the per-file failure tolerance:
    if every PUT fails we raise; partial failures pass through
    and the server reports them in `final_status.counts.failed`."""
    # 1. Submit manifest.
    submit_body: dict[str, Any] = {
        "namespace": namespace,
        "config": config,
        "files": [
            {
                "ordinal": i,
                "filename": f.filename,
                "size_bytes": f.size_bytes,
                "content_type": f.content_type,
                **({"client_request_id": f.client_request_id} if f.client_request_id else {}),
            }
            for i, f in enumerate(files)
        ],
        "on_existing": on_existing,
        "auto_finalize": auto_finalize,
        "source": source,
    }
    if client_request_id:
        submit_body["client_request_id"] = client_request_id
    submit_resp = client.bulk_ingest.submit(submit_body)
    bulk_job_id = submit_resp["bulk_job_id"]

    # 2. Upload bytes in parallel.
    errors: list[BaseException] = []
    with ThreadPoolExecutor(max_workers=min(concurrency, len(files))) as pool:
        futures = [
            pool.submit(_put_one, slot, files[slot["ordinal"]], client._http.client)
            for slot in submit_resp["uploads"]
        ]
        for fut in as_completed(futures):
            err = fut.exception()
            if err is not None:
                errors.append(err)
    if errors and len(errors) == len(files):
        raise RuntimeError(f"every bulk-upload PUT failed: {errors[0]}")

    # 3. Finalize if not auto.
    if not auto_finalize:
        client.bulk_ingest.finalize(bulk_job_id)

    # 4. Poll.
    final = poll_bulk_job(
        client,
        bulk_job_id,
        poll_interval_ms=poll_interval_ms,
        on_progress=on_progress,
    )
    return BulkOrchestrateResult(bulk_job_id=bulk_job_id, final_status=final)


def poll_bulk_job(
    client: Client,
    bulk_job_id: str,
    *,
    poll_interval_ms: int = 1500,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
    max_wait_ms: int = 60 * 60 * 1000,
) -> dict[str, Any]:
    """Poll a bulk job to terminal state. Standalone for callers
    who want the polling behavior without the upload phase
    (e.g. Sandbox `wait=true` paths)."""
    start = time.time()
    while True:
        if (time.time() - start) * 1000 > max_wait_ms:
            raise RuntimeError(
                f"Bulk job {bulk_job_id} did not terminate within {max_wait_ms}ms"
            )
        snap = client.bulk_ingest.get(bulk_job_id)
        if on_progress is not None:
            on_progress(snap)
        if snap.get("state") in _TERMINAL_STATES:
            return snap
        time.sleep(poll_interval_ms / 1000.0)


def _put_one(
    slot: dict[str, Any],
    file: BulkOrchestrateFile,
    httpx_client: httpx.Client,
) -> None:
    """PUT one file's bytes to its server-minted upload URL.
    Bypasses the SDK's retry layer because the upload URL is on
    a different origin and the API's idempotent-POST allowlist
    doesn't cover raw uploads. The orchestrator tolerates per-
    file failures (server marks file failed; bulk job becomes
    `partial`)."""
    headers = dict(slot.get("headers", {}))
    resp = httpx_client.put(slot["upload_url"], content=file.bytes_, headers=headers)
    if resp.status_code >= 300 and resp.status_code != 204:
        raise RuntimeError(
            f"PUT {slot['upload_url']} failed: {resp.status_code} {resp.text[:200]}"
        )


# ── Async orchestrator ──────────────────────────────────────────


async def bulk_ingest_orchestrate_async(
    client: AsyncClient,
    *,
    namespace: str,
    config: dict[str, Any],
    files: Sequence[BulkOrchestrateFile],
    on_existing: str = "skip_if_unchanged",
    auto_finalize: bool = True,
    client_request_id: str | None = None,
    concurrency: int = 6,
    on_progress: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
    poll_interval_ms: int = 1500,
    source: str = "api",
) -> BulkOrchestrateResult:
    """Async sister of `bulk_ingest_orchestrate`."""
    submit_body: dict[str, Any] = {
        "namespace": namespace,
        "config": config,
        "files": [
            {
                "ordinal": i,
                "filename": f.filename,
                "size_bytes": f.size_bytes,
                "content_type": f.content_type,
                **({"client_request_id": f.client_request_id} if f.client_request_id else {}),
            }
            for i, f in enumerate(files)
        ],
        "on_existing": on_existing,
        "auto_finalize": auto_finalize,
        "source": source,
    }
    if client_request_id:
        submit_body["client_request_id"] = client_request_id
    submit_resp = await client.bulk_ingest.submit(submit_body)
    bulk_job_id = submit_resp["bulk_job_id"]

    sem = asyncio.Semaphore(concurrency)

    async def _put(slot: dict[str, Any]) -> None:
        async with sem:
            await _put_one_async(slot, files[slot["ordinal"]], client._http.client)

    results = await asyncio.gather(
        *(_put(slot) for slot in submit_resp["uploads"]),
        return_exceptions=True,
    )
    errors = [r for r in results if isinstance(r, BaseException)]
    if errors and len(errors) == len(files):
        raise RuntimeError(f"every bulk-upload PUT failed: {errors[0]}")

    if not auto_finalize:
        await client.bulk_ingest.finalize(bulk_job_id)

    final = await poll_bulk_job_async(
        client,
        bulk_job_id,
        poll_interval_ms=poll_interval_ms,
        on_progress=on_progress,
    )
    return BulkOrchestrateResult(bulk_job_id=bulk_job_id, final_status=final)


async def poll_bulk_job_async(
    client: AsyncClient,
    bulk_job_id: str,
    *,
    poll_interval_ms: int = 1500,
    on_progress: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
    max_wait_ms: int = 60 * 60 * 1000,
) -> dict[str, Any]:
    start = time.time()
    while True:
        if (time.time() - start) * 1000 > max_wait_ms:
            raise RuntimeError(
                f"Bulk job {bulk_job_id} did not terminate within {max_wait_ms}ms"
            )
        snap = await client.bulk_ingest.get(bulk_job_id)
        if on_progress is not None:
            r = on_progress(snap)
            if asyncio.iscoroutine(r):
                await r
        if snap.get("state") in _TERMINAL_STATES:
            return snap
        await asyncio.sleep(poll_interval_ms / 1000.0)


async def _put_one_async(
    slot: dict[str, Any],
    file: BulkOrchestrateFile,
    httpx_client: httpx.AsyncClient,
) -> None:
    headers = dict(slot.get("headers", {}))
    resp = await httpx_client.put(slot["upload_url"], content=file.bytes_, headers=headers)
    if resp.status_code >= 300 and resp.status_code != 204:
        raise RuntimeError(
            f"PUT {slot['upload_url']} failed: {resp.status_code} {resp.text[:200]}"
        )
