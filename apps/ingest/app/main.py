"""textral-ingest — FastAPI Container worker.

Entry points:
  GET  /healthz       — liveness probe
  POST /jobs/run      — process one ingestion job; returns terminal outcome

The Worker calls this Container via its Durable Object binding. Provider
keys never travel through the Container; the Container POSTs to the
Worker's HMAC-signed /internal/* endpoints for every D1 / Vectorize /
embed operation."""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from .workers.job_runner import run_job

app = FastAPI(title="textral-ingest", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "textral-ingest"}


class JobRequest(BaseModel):
    job_id: str
    attempt: int = 0


@app.post("/jobs/run")
async def run_job_route(req: JobRequest) -> dict[str, object]:
    return await run_job(req.job_id, req.attempt)
