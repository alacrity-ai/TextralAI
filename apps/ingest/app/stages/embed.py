"""Stage: embed — POST to Worker /internal/providers/embed.

The Worker resolves the provider key, applies AI Gateway routing +
redaction + Phase 2 retry/classification, and returns vectors. Failure
dispatch mirrors Phase 2 (insufficient_quota → fatal, transient → up
to 3 retries handled inside the Worker).

This stage handles partial-batch fallout: if the Worker reports a
PROVIDER_MALFORMED_RESPONSE for a batch even after Worker-side retries,
the affected chunks are marked embedding_status='missing' (which makes
the job's terminal outcome partial_ingestion)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from ..clients.worker import WorkerClient, WorkerError


@dataclass
class EmbedResult:
    chunk_id: str
    vector: list[float] | None
    input_hash: str
    request_id: str | None
    status: str  # 'embedded' | 'missing'


# Provider-specific batch sizes.
_BATCH_SIZES: dict[str, int] = {
    "openai": 100,
    "workers_ai_compat": 96,
    "workers_ai": 96,
}


async def embed_chunks(
    worker: WorkerClient,
    *,
    job_id: str,
    provider: str,
    chunks: list[tuple[str, str]],  # (chunk_id, text)
) -> tuple[list[EmbedResult], int]:
    """Returns (results, fatal_count). On fatal: raises WorkerError (the
    job_runner converts that into a fatal stage failure)."""
    batch_size = _BATCH_SIZES.get(provider, 64)
    results: list[EmbedResult] = []
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i : i + batch_size]
        ids = [c[0] for c in batch]
        texts = [c[1] for c in batch]
        try:
            res = await worker.post_json(
                "/internal/providers/embed",
                {"job_id": job_id, "input": texts},
            )
        except WorkerError as e:
            # 422 = fatal (invalid_api_key, insufficient_quota,
            # context_length, refusal). Re-raise so the runner marks the
            # stage as a fatal failure.
            if e.status == 422:
                raise
            # 503 = transient retryable; the Worker has already exhausted
            # its retry budget. Mark this batch as missing and continue —
            # the index stage records partial.
            for cid, text in batch:
                results.append(
                    EmbedResult(
                        chunk_id=cid,
                        vector=None,
                        input_hash=_hash_text(text),
                        request_id=None,
                        status="missing",
                    ),
                )
            continue
        vectors = res["vectors"]
        request_id = res.get("request_id")
        if len(vectors) != len(batch):
            # Partial batch the Worker didn't catch. Mark the lot as missing.
            for cid, text in batch:
                results.append(
                    EmbedResult(
                        chunk_id=cid,
                        vector=None,
                        input_hash=_hash_text(text),
                        request_id=None,
                        status="missing",
                    ),
                )
            continue
        for cid, text, vec in zip(ids, texts, vectors, strict=True):
            results.append(
                EmbedResult(
                    chunk_id=cid,
                    vector=vec,
                    input_hash=_hash_text(text),
                    request_id=request_id,
                    status="embedded",
                ),
            )
    missing = sum(1 for r in results if r.status == "missing")
    return results, missing


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
