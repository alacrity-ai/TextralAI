"""Stage: fetch — pull source bytes from R2.

Uses /internal/r2/object (Worker-proxied bytes over the HMAC-signed
back-channel). The presigned-URL path is preserved on the Worker side
for deploys that have R2 S3-compatible access keys configured, but the
Container always goes through the proxy — it works in every deploy
shape and stays inside the signed channel."""

from __future__ import annotations

from typing import Any

from ..clients.worker import WorkerClient


async def fetch_source(worker: WorkerClient, *, job_id: str, source_r2_key: str) -> bytes:
    return await worker.post_bytes(
        "/internal/r2/object",
        {"job_id": job_id, "key": source_r2_key},
    )


def stage_metadata(file_size: int, content_type: str | None) -> dict[str, Any]:
    return {"file_size": file_size, "content_type": content_type or "application/octet-stream"}
