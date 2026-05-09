# textral

Typed Python REST client for the [Textral](https://github.com/alacrity-ai/TextralAI) RAG API. One method per route, every response shaped by Pydantic models codegen'd from `@textral/contracts`. Streaming queries (async), retry/backoff, async-cancellation, sync + async pagination iterators, and `~/.textral/profiles.toml` resolution out of the box.

```bash
pip install textral
```

Python 3.10+. PEP 561 typed (`py.typed` ships in the wheel).

## Quick start

```python
from textral import Client

# Profile mode — credentials lazy-resolved from ~/.textral/profiles.toml.
with Client(profile="hosted-prod") as client:
    r = client.query(
        namespace="cookbook",
        query="What survived the Library of Alexandria?",
        embedding={"provider": "openai", "model": "text-embedding-3-large", "dimensions": 1536},
        inference={"provider": "openai", "model": "gpt-4o-mini"},
    )
    print(r["answer"])
```

Async sister works the same:

```python
import asyncio
from textral import AsyncClient

async def main():
    async with AsyncClient(profile="hosted-prod") as client:
        r = await client.query(...)

asyncio.run(main())
```

## Configuration

Three ways to point a client at an endpoint:

```python
from textral import Client

# 1. Explicit credentials.
Client(base_url="https://api.textral.alacrity.ai", api_key="tx_live_...")

# 2. Profile name — resolved from ~/.textral/profiles.toml.
Client(profile="hosted-prod")

# 3. No-arg — falls through the precedence chain (env vars + file).
Client()
```

Full options:

```python
Client(
    base_url=None,        # str | None
    api_key=None,         # str | None
    profile=None,         # str | None
    retry=None,           # RetryPolicy | None — default: see below
    timeout=30.0,         # float (seconds)
)
```

## Profiles

The `~/.textral/profiles.toml` file is a single source of truth for both the Node SDK (`@textral/sdk`) and this Python SDK. Same file, same precedence — both clients read it identically.

```toml
default = "hosted-prod"

[profiles.local]
base_url = "http://localhost:8787"
api_key  = "tx_live_..."

[profiles.hosted-prod]
base_url = "https://api.textral.alacrity.ai"
api_key  = "tx_live_..."
```

Precedence chain (top → bottom, first match wins):

1. Constructor `base_url=` + `api_key=`
2. `profile=` argument → file lookup
3. `TEXTRAL_PROFILE` env var → file lookup
4. File's `default = "..."` field
5. Lex-first profile in the file
6. Synth `_env` profile from `TEXTRAL_BASE_URL` + `TEXTRAL_API_KEY`
7. Raises `TextralProfileNotFound`

Standalone resolver helpers:

```python
from textral import resolve_profile, load_profile_file, config_path

p = resolve_profile()        # active profile per the chain above
p = resolve_profile(name="staging")
print(load_profile_file())   # raw {default, profiles} dict, or None
print(config_path())         # ~/.textral/profiles.toml
```

## Resources

Every public REST route maps to one method. Resource blocks group related endpoints — sync `Client` and `AsyncClient` are sister APIs (same names, async methods are awaitable).

```python
client.me()
client.namespaces.{list, create, get, list_documents, iterate_documents}
client.documents.{register, get, create_upload, put_upload_bytes, finalize, ingest, list_chunks, iterate_chunks}
client.chunks.{get}
client.ingestion_jobs.{get, retry}
client.query(...)                          # sync JSON
client.query.stream(...)                    # AsyncClient only — SSE async iterator
client.query_events.{list, get, get_response, iterate}
client.provider_keys.{list, create, test}
client.infra_keys.{list, create, test, revoke}
client.bulk_ingest.{submit, finalize, get, files, iterate_files, cancel, retry, list, iterate, upload_url_for}
client.admin.{list_failing_jobs, iterate_failing_jobs}
client.models.{list}
```

## Streaming

`AsyncClient.query.stream(...)` is an async iterable of typed SSE frames. Streams are **not retried** (per design — a partially-consumed response can't be replayed cleanly). On interruption, the iterator raises `TextralStreamInterrupted` with the underlying cause in `__cause__`.

```python
from textral import AsyncClient, TextralStreamInterrupted

async with AsyncClient(profile="hosted-prod") as client:
    try:
        async for frame in client.query.stream(
            namespace="docs",
            query="...",
            embedding={...},
            inference={...},
        ):
            event = frame.get("event")
            if event == "answer_token":
                print(frame.get("value", ""), end="", flush=True)
            elif event == "citation":
                ...  # handle citations as they arrive
            elif event == "final":
                ...  # last frame; carries query_event_id + audit
    except TextralStreamInterrupted:
        # Caller decides whether to re-issue the whole query.
        ...
```

Sync streaming is intentionally not provided — most Python codebases that want streaming want non-blocking IO; spinning up a single-shot event loop for a CLI is a few lines.

## Retry & backoff

Default: **3 attempts**, exponential backoff with ±25% jitter, `Retry-After` honored, retries 429/502/503/504. GET and DELETE always retried; POST only when on the idempotent allowlist (auth-redeem, bulk submit, finalize endpoints — server-side dedupe makes them safe).

```python
from textral import Client, RetryPolicy

client = Client(
    profile="hosted-prod",
    retry=RetryPolicy(
        max_attempts=5,
        initial_delay_ms=500,
        max_delay_ms=8_000,
        retry_on=(429, 502, 503, 504),
        on_retry=lambda info: print(f"retry #{info.attempt}: {info.status} → sleep {info.delay_ms}ms"),
    ),
)
```

Disable retries entirely with `NO_RETRY`:

```python
from textral import Client, NO_RETRY

Client(retry=NO_RETRY)
```

When the policy gives up, raises `TextralRetryExhausted`; the original final error is in `__cause__`:

```python
from textral import TextralRetryExhausted

try:
    client.query(...)
except TextralRetryExhausted as e:
    print(f"gave up after {e.attempts} tries: {e.last_error}")
```

## Pagination

Every paginated list method has an `iterate_*` sibling that walks `next_cursor` automatically. The sync iterator is a regular generator; the async sibling on `AsyncClient` is an async-iterable.

```python
# sync
with Client(profile="hosted-prod") as client:
    for ev in client.query_events.iterate(namespace_slug="docs"):
        ...

# async
async with AsyncClient(profile="hosted-prod") as client:
    async for ev in client.query_events.iterate(namespace_slug="docs"):
        ...
```

Available iterators:

```python
client.namespaces.iterate_documents(slug)
client.documents.iterate_chunks(doc_id)
client.query_events.iterate(...)
client.bulk_ingest.iterate(...)
client.bulk_ingest.iterate_files(bulk_job_id)
client.admin.iterate_failing_jobs()
```

Early termination just works — `break` out of the loop and the iterator stops fetching the next page.

## Cancellation

The async client integrates with asyncio's cancellation: if the surrounding task is cancelled, in-flight requests and pending retry sleeps both unwind cleanly.

```python
import asyncio

async def reader():
    async for frame in client.query.stream(...):
        ...

task = asyncio.create_task(reader())
await asyncio.sleep(2.0)
task.cancel()
```

Per-request timeouts are configured at the client level (`timeout=30.0`, default 30s).

## Bulk ingest orchestrator

For multi-file ingestion, `bulk_ingest_orchestrate(client, ...)` drives the full choreography (manifest → parallel uploads → poll until terminal):

```python
from textral import Client, BulkOrchestrateFile, bulk_ingest_orchestrate

with Client(profile="hosted-prod") as client:
    result = bulk_ingest_orchestrate(
        client,
        namespace="docs",
        config={
            "embedding": {"provider": "openai", "model": "text-embedding-3-large", "dimensions": 1536},
            "chunking": {"profile": "generic", "target_tokens": 600, "overlap_tokens": 80},
            "mode": "full",
        },
        files=[
            BulkOrchestrateFile(
                filename="a.md",
                bytes_=open("a.md", "rb").read(),
                size_bytes=...,
                content_type="text/markdown",
            ),
        ],
        on_existing="skip_if_unchanged",
        auto_finalize=True,
        concurrency=4,
        on_progress=lambda snap: print(snap["state"], snap.get("progress_pct", 0)),
    )

print(result.bulk_job_id, result.final_status["state"])
```

The async sister `bulk_ingest_orchestrate_async(...)` works the same against `AsyncClient`.

## Errors

All errors extend `TextralError`. Concrete classes:

| Class | When |
|---|---|
| `TextralAPIError` | Server returned a 4xx/5xx with the canonical envelope. `.code`, `.status_code`, `.request_id`, `.details`, `.retry_after`. |
| `TextralRetryExhausted` | Retry policy gave up after N attempts. `.attempts`, `.last_error`. |
| `TextralStreamInterrupted` | SSE stream ended without `[DONE]`. Underlying cause in `__cause__`. |
| `TextralProfileNotFound` | Profile name not found, or no precedence rung produced credentials. `.profile_name`. |

## Typed responses

Pydantic v2 models for every wire shape live under `textral.models`. Responses come back as `dict[str, Any]` by default — typed access is opt-in:

```python
from textral.models import Namespace

with Client(profile="hosted-prod") as client:
    raw = client.namespaces.get("docs")
    typed = Namespace.model_validate(raw)
    print(typed.slug, typed.embedding_dimensions)
```

Models are forward-compatible (`extra="allow"`) so unknown server-side fields don't break old SDKs.

## Cookbook

[`examples/`](./examples) has 7 paste-and-run scripts:

| File | Concept |
|---|---|
| `01_quick_start.py` | One query, one cited answer |
| `02_ingest_and_query.py` | Single-file ingest pipeline |
| `03_bulk_ingest.py` | Bulk orchestrator |
| `04_streaming.py` | SSE streaming (async) |
| `05_profiles.py` | `~/.textral/profiles.toml` |
| `06_retry_and_cancel.py` | Retry policy + cancellation |
| `07_paginate_events.py` | Pagination iterators |

## Versioning

Released in lockstep with `@textral/{contracts,profiles,sdk,mcp}`. The contracts package is the source of truth; Pydantic models are codegen'd from its JSON Schemas. A bump to one is a bump to all.

The 0.x line is sub-1.0; minor bumps may include breaking changes. The 1.0 commitment locks the public surface — see the [SDKs design plan](https://github.com/alacrity-ai/TextralAI/blob/main/docs/development/sdks/SDKS_DESIGN_PLAN.md) for the timeline.

## License

MIT.
