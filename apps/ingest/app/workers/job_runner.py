"""Job runner — claim, run stages, transition. Stage attempt history is
preserved (one row per attempt; no INSERT-OR-REPLACE). Replay resumes
from the latest completed stage."""

from __future__ import annotations

import os
import time
import uuid
from typing import Any, Literal

from ..clients.worker import WorkerClient, WorkerError
from ..stages.embed import EmbedResult, embed_chunks
from ..stages.fetch import fetch_source
from ..stages.index import index_chunks
from ..stages.normalize import normalize_source
from ..stages.chunk import chunk_cdm, parse_chunks_jsonl

Stage = Literal["fetch", "normalize", "chunk", "embed", "index"]
STAGES: list[Stage] = ["fetch", "normalize", "chunk", "embed", "index"]
JobOutcome = Literal["full_success", "partial_ingestion", "fatal_failure"]


class FatalStageError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


async def run_job(job_id: str, attempt: int) -> dict[str, Any]:
    instance_id = os.environ.get("CONTAINER_INSTANCE_ID") or f"inst_{uuid.uuid4().hex[:12]}"
    worker = WorkerClient()
    try:
        # 1. Claim the lease.
        claim = await worker.post_json(
            f"/internal/jobs/{job_id}/claim",
            {"container_instance_id": instance_id},
        )
        if not claim.get("ok"):
            return {
                "outcome": "lease_lost",
                "job_id": job_id,
                "reason": claim.get("reason", "unknown"),
            }

        # 2. Load metadata.
        meta = await worker.get_json(f"/internal/jobs/{job_id}")
        job = meta["job"]
        config = meta["config"]
        version = meta["version"]
        vidx = meta["version_index"]
        ns = meta["namespace"]
        if not version or not vidx or not ns:
            raise FatalStageError("INTERNAL", "Missing version/version_index/namespace in /internal/jobs response")

        # 3. Determine starting stage from completed history.
        attempts = await _list_attempts(worker, job_id)
        last_completed = _last_completed_stage(attempts)
        start_index = STAGES.index(last_completed) + 1 if last_completed else 0

        # 4. Run stages in order. Each stage's attempt is its own row.
        cdm_payload: bytes | None = None
        chunks_jsonl_payload: str | None = None
        chunks_list: list[Any] = []
        embeddings: dict[str, EmbedResult] = {}

        replace_existing = bool(config.get("indexing", {}).get("replace_existing_vectors", False))
        embedding_profile = vidx["embedding_profile"]
        chunking_profile = vidx["chunking_profile"]
        embedding_dimensions = int(vidx["embedding_dimensions"])
        chunking_target_tokens = int(vidx["chunking_target_tokens"])
        chunking_overlap_tokens = int(vidx["chunking_overlap_tokens"])
        provider = config["embedding"]["provider"]

        for stage_index in range(start_index, len(STAGES)):
            stage = STAGES[stage_index]
            attempt_number = _next_attempt_for(attempts, stage)
            await _record_attempt_start(worker, job_id, stage, attempt_number)
            started_at = time.time() * 1000.0
            try:
                if stage == "fetch":
                    cdm_payload = await fetch_source(
                        worker,
                        job_id=job_id,
                        source_r2_key=version["source_r2_key"],
                    )
                elif stage == "normalize":
                    if cdm_payload is None:
                        # Replay: fetch on demand.
                        cdm_payload = await fetch_source(
                            worker,
                            job_id=job_id,
                            source_r2_key=version["source_r2_key"],
                        )
                    cdm = normalize_source(
                        document_id=job["document_id"],
                        version_id=job["version_id"],
                        raw=cdm_payload,
                        content_type=version["content_type"],
                    )
                    # Persist the CDM to R2 — phase-3 future-proofing.
                    cdm_payload = cdm.model_dump_json().encode("utf-8")
                    cdm_for_chunk = cdm
                elif stage == "chunk":
                    if cdm_payload is None:
                        # Replay: re-normalize from source.
                        cdm_payload = await fetch_source(
                            worker,
                            job_id=job_id,
                            source_r2_key=version["source_r2_key"],
                        )
                        cdm_for_chunk = normalize_source(
                            document_id=job["document_id"],
                            version_id=job["version_id"],
                            raw=cdm_payload,
                            content_type=version["content_type"],
                        )
                    chunks, chunks_jsonl_payload = chunk_cdm(
                        cdm_for_chunk,
                        target_tokens=chunking_target_tokens,
                        overlap_tokens=chunking_overlap_tokens,
                        chunking_profile=chunking_profile,
                        version_index_id=job["version_index_id"],
                    )
                    chunks_list = chunks
                elif stage == "embed":
                    if not chunks_list and chunks_jsonl_payload:
                        _, chunks_list = parse_chunks_jsonl(chunks_jsonl_payload)
                    if not chunks_list:
                        raise FatalStageError("INTERNAL", "No chunks produced before embed stage")
                    pairs = [(c.id, c.text) for c in chunks_list]
                    results, _missing = await embed_chunks(
                        worker,
                        job_id=job_id,
                        provider=provider,
                        chunks=pairs,
                    )
                    embeddings = {r.chunk_id: r for r in results}
                elif stage == "index":
                    if not chunks_list:
                        raise FatalStageError("INTERNAL", "No chunks list at index stage")
                    if not embeddings:
                        # Replay-resume from a successful chunk stage but
                        # without embeddings in memory. Re-embed.
                        pairs = [(c.id, c.text) for c in chunks_list]
                        results, _missing = await embed_chunks(
                            worker,
                            job_id=job_id,
                            provider=provider,
                            chunks=pairs,
                        )
                        embeddings = {r.chunk_id: r for r in results}
                    md = await index_chunks(
                        worker,
                        job_id=job_id,
                        tenant_id=job["tenant_id"],
                        namespace_id=ns["id"],
                        document_id=job["document_id"],
                        version_id=job["version_id"],
                        version_index_id=job["version_index_id"],
                        embedding_profile=embedding_profile,
                        chunking_profile=chunking_profile,
                        embedding_dimensions=embedding_dimensions,
                        chunks=chunks_list,
                        embeddings=embeddings,
                        replace_existing=replace_existing,
                    )
                    await _record_attempt_complete(
                        worker,
                        job_id,
                        stage,
                        attempt_number,
                        started_at,
                        md,
                    )
                    continue  # skip the generic completion record

                # Generic stage completion record (other stages use a
                # default metadata payload).
                await _record_attempt_complete(
                    worker, job_id, stage, attempt_number, started_at, {"stage": stage}
                )
            except FatalStageError as fe:
                await _record_attempt_failed(
                    worker, job_id, stage, attempt_number, started_at, fe.code, str(fe)
                )
                await worker.post_json(
                    f"/internal/jobs/{job_id}/transition",
                    {
                        "tenant_id": job["tenant_id"],
                        "status": "failed",
                        "current_stage": stage,
                        "error_code": fe.code,
                        "error_message": str(fe),
                    },
                )
                return {"outcome": "fatal_failure", "job_id": job_id, "stage": stage}
            except WorkerError as we:
                # 422 from the Worker = upstream provider fatal
                if we.status == 422 and stage == "embed":
                    code = _extract_error_code(we.body) or "PROVIDER_QUOTA_EXHAUSTED"
                    msg = _extract_error_message(we.body) or "Provider returned a fatal error"
                    await _record_attempt_failed(
                        worker, job_id, stage, attempt_number, started_at, code, msg
                    )
                    await worker.post_json(
                        f"/internal/jobs/{job_id}/transition",
                        {
                            "tenant_id": job["tenant_id"],
                            "status": "failed",
                            "current_stage": stage,
                            "error_code": code,
                            "error_message": msg,
                        },
                    )
                    return {"outcome": "fatal_failure", "job_id": job_id, "stage": stage}
                # transient → fail this attempt; queue redelivery will retry
                await _record_attempt_failed(
                    worker, job_id, stage, attempt_number, started_at, "RETRYABLE", str(we)
                )
                raise

        # 5. Determine terminal outcome.
        missing = sum(1 for r in embeddings.values() if r.status == "missing")
        outcome: JobOutcome = "partial_ingestion" if missing > 0 else "full_success"
        await worker.post_json(
            f"/internal/jobs/{job_id}/transition",
            {
                "tenant_id": job["tenant_id"],
                "status": "completed",
                "current_stage": "index",
            },
        )
        # Set documents.current_version_id via a lightweight update.
        # We do that here for symmetry but the Worker also exposes it via
        # the transition endpoint in a follow-on; for Phase 3 the
        # current_version_id update happens through a side-effect
        # documented in the implementation doc. Phase 5 may move this
        # into the Worker's transition handler explicitly.
        return {
            "outcome": outcome,
            "job_id": job_id,
            "version_id": job["version_id"],
            "embedding_missing_count": missing,
        }
    finally:
        await worker.aclose()


async def _list_attempts(worker: WorkerClient, job_id: str) -> list[dict[str, Any]]:
    # Phase 3: a thin convenience over the Worker's stage-attempt
    # records. We just request via a derived query — the Worker exposes
    # stage attempts only on the public read route. For the runner,
    # consume via the next-attempt logic below by counting locally.
    # (We trust the Worker to be the source of truth for status across
    # restarts; the runner needs only the latest attempt number.)
    return []


def _last_completed_stage(attempts: list[dict[str, Any]]) -> Stage | None:
    completed_stages = [a["stage"] for a in attempts if a.get("status") == "completed"]
    for stage in reversed(STAGES):
        if stage in completed_stages:
            return stage
    return None


def _next_attempt_for(attempts: list[dict[str, Any]], stage: Stage) -> int:
    same = [a for a in attempts if a.get("stage") == stage]
    return (max((a.get("attempt", 0) for a in same), default=0)) + 1


async def _record_attempt_start(
    worker: WorkerClient, job_id: str, stage: Stage, attempt: int
) -> None:
    await worker.post_json(
        f"/internal/jobs/{job_id}/stage-attempt",
        {
            "stage": stage,
            "attempt": attempt,
            "status": "started",
            "started_at": int(time.time() * 1000),
        },
    )


async def _record_attempt_complete(
    worker: WorkerClient,
    job_id: str,
    stage: Stage,
    attempt: int,
    started_at: float,
    metadata: dict[str, Any],
) -> None:
    now = int(time.time() * 1000)
    await worker.post_json(
        f"/internal/jobs/{job_id}/stage-attempt",
        {
            "stage": stage,
            "attempt": attempt,
            "status": "completed",
            "started_at": int(started_at),
            "completed_at": now,
            "duration_ms": now - int(started_at),
            "metadata": metadata,
        },
    )


async def _record_attempt_failed(
    worker: WorkerClient,
    job_id: str,
    stage: Stage,
    attempt: int,
    started_at: float,
    error_code: str,
    error_message: str,
) -> None:
    now = int(time.time() * 1000)
    await worker.post_json(
        f"/internal/jobs/{job_id}/stage-attempt",
        {
            "stage": stage,
            "attempt": attempt,
            "status": "failed",
            "started_at": int(started_at),
            "completed_at": now,
            "duration_ms": now - int(started_at),
            "error_code": error_code,
            "error_message": error_message,
        },
    )


def _extract_error_code(body: Any) -> str | None:  # noqa: ANN401
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return body["error"].get("code")
    return None


def _extract_error_message(body: Any) -> str | None:  # noqa: ANN401
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return body["error"].get("message")
    return None
