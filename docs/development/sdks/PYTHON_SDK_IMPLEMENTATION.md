# Python SDK — Implementation Plan (Phase 2, `textral==0.2.0` on PyPI)

> **Status.** Ready to build, blocked on Phase 1 landing first
> (the codegen pipeline reads
> `@textral/contracts/dist/schemas/*.json` which Phase 1 emits).
> Companion to [`SDKS_DESIGN_PLAN.md`](./SDKS_DESIGN_PLAN.md).
>
> **Targets.** `textral==0.2.0` on PyPI, lockstep with
> `@textral/{contracts,profiles,sdk,mcp}@0.2.0`.
>
> **Last drafted:** 2026-05-08.

---

## 1. Scope summary

Build the Python SDK from zero. Key shape:

- `pip install textral` works.
- Sync `Client` + async `AsyncClient`, both httpx-based.
- 1:1 surface parity with `@textral/sdk@0.2.0` (every method, every
  option).
- Pydantic v2 models **generated** from `@textral/contracts` Zod
  schemas; CI fails on drift.
- Profile resolver matches MCP / Node SDK behavior against
  `~/.textral/profiles.toml`.
- mypy-strict with a `py.typed` marker.

Out for v1 (per `SDKS_DESIGN_PLAN.md` decisions):

- Python MCP server. Node MCP is canonical.
- `textral` CLI. Post-1.0.
- Browser-equivalent client. N/A on Python.

---

## 2. Day 0 — PyPI name verification

Before any code, confirm `textral` on PyPI:

```bash
curl -s https://pypi.org/pypi/textral/json | jq -r '.info.name // "NOT TAKEN"'
```

**Decision rules:**

- **Available** → claim with a `0.0.0` placeholder push (just
  pyproject + LICENSE + README stub) on day 1 to lock the name.
- **Taken by an unrelated/abandoned package** → file a PEP 541
  request to claim. Decision is on a case-by-case basis based on
  PyPI maintainers' response time.
- **Taken by an active package** → fall back to **`textral-ai`**.
  Document this everywhere (the `[project.scripts]` entry stays
  unchanged at import time — `from textral import Client` is the
  ergonomics we ship). The package name on PyPI differs from the
  import name; this is the same trick `psycopg`/`psycopg2` and
  `attrs`/`attr` use.

The fallback decision doesn't ripple — the rest of this plan
references `textral` as both the import name and PyPI name. If we
land on `textral-ai`, only `pyproject.toml`'s `name` field
changes; everything else stays.

---

## 3. Project skeleton

### 3.1 Layout

```
packages/sdk-python/
├── pyproject.toml
├── README.md
├── LICENSE
├── .gitignore
├── src/
│   └── textral/
│       ├── __init__.py
│       ├── _version.py
│       ├── client.py
│       ├── async_client.py
│       ├── _http.py
│       ├── _stream.py
│       ├── _paginate.py
│       ├── errors.py
│       ├── profile.py
│       ├── py.typed
│       └── models/
│           ├── __init__.py
│           └── (generated, see §5)
├── tests/
│   ├── __init__.py
│   ├── conftest.py
│   ├── fixtures/
│   ├── test_client_sync.py
│   ├── test_client_async.py
│   ├── test_retry.py
│   ├── test_stream.py
│   ├── test_paginate.py
│   ├── test_profile.py
│   └── test_models_parity.py
├── examples/
│   ├── 01_quick_start.py
│   ├── 02_ingest_and_query.py
│   ├── 03_bulk_ingest.py
│   ├── 04_streaming.py
│   ├── 05_profiles.py
│   ├── 06_async_client.py
│   ├── 07_paginate_events.py
│   ├── data/
│   │   ├── alexandria.md
│   │   └── lighthouse.md
│   └── README.md
└── codegen/
    ├── README.md
    ├── generate.py
    └── schemas/                  # gitignored — populated from contracts
```

### 3.2 `pyproject.toml`

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "textral"
version = "0.2.0"
description = "Official Python client for the Textral RAG API"
readme = "README.md"
license = { text = "ELv2" }
authors = [{ name = "Alacrity AI", email = "engineering@alacrity.ai" }]
requires-python = ">=3.10"
keywords = ["rag", "vector-search", "embeddings", "textral", "llm"]
classifiers = [
  "Development Status :: 4 - Beta",
  "Intended Audience :: Developers",
  "Programming Language :: Python :: 3",
  "Programming Language :: Python :: 3.10",
  "Programming Language :: Python :: 3.11",
  "Programming Language :: Python :: 3.12",
  "Topic :: Software Development :: Libraries :: Python Modules",
  "Typing :: Typed",
]
dependencies = [
  "httpx>=0.27,<1.0",
  "pydantic>=2.6,<3.0",
  "tomli>=2.0; python_version < '3.11'",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.0",
  "pytest-asyncio>=0.23",
  "respx>=0.20",
  "mypy>=1.8",
  "ruff>=0.4",
  "datamodel-code-generator>=0.25",
]

[project.urls]
Homepage = "https://textral.alacrity.ai"
Documentation = "https://api.textral.alacrity.ai/docs"
Repository = "https://github.com/alacrity-ai/TextralAI"
Issues = "https://github.com/alacrity-ai/TextralAI/issues"

[tool.hatch.build.targets.wheel]
packages = ["src/textral"]

[tool.mypy]
strict = true
python_version = "3.10"
files = ["src/textral", "tests"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.ruff]
target-version = "py310"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "W", "I", "UP", "B", "C4"]
```

### 3.3 Python version baseline

**3.10+.** Per the design plan §5.1. Rationale:

- Pattern matching (`match` / `case`) — useful for SSE frame
  dispatch in `_stream.py`.
- Modern typing syntax (`list[int]` instead of `List[int]`).
- Pydantic v2 minimum.
- 3.10 has 5 years of support remaining (EOL Oct 2026); enterprise
  deployments still on 3.9 are vanishingly rare for a fresh
  install of an SDK.

3.11+ would also let us drop the `tomli` shim (3.11 has `tomllib`
in the stdlib), but 3.10 is the wider reach. We carry the small
`tomli` dep for 3.10 only.

---

## 4. JSON Schema export from contracts (Phase 1 prerequisite)

Phase 1's contracts package gains a build-time tool to emit JSON
Schema for every Zod schema. Phase 2 reads from there.

### 4.1 New file in contracts

`packages/contracts/src/build-json-schema.ts`:

```ts
// Build-time tool — not shipped at runtime. Walks every export
// from src/index.ts, calls zodToJsonSchema(...) for each Zod
// schema, writes dist/schemas/{Name}.json.
//
// Run via `pnpm --filter @textral/contracts run build:schemas`,
// hooked into `prepublishOnly` so npm publishes ship the schemas.

import { zodToJsonSchema } from 'zod-to-json-schema';
import * as Contracts from './index.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist/schemas';
mkdirSync(OUT, { recursive: true });

for (const [name, value] of Object.entries(Contracts)) {
  if (isZodSchema(value)) {
    const schema = zodToJsonSchema(value, name);
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify(schema, null, 2));
  }
}
```

`packages/contracts/package.json`:

```json
"scripts": {
  "build": "tsc -p tsconfig.build.json",
  "build:schemas": "tsx src/build-json-schema.ts",
  "prepublishOnly": "pnpm run build && pnpm run build:schemas"
}
```

The published tarball includes `dist/schemas/*.json` so Python's
codegen can read them without re-emitting from source.

### 4.2 Discriminated unions

`zod-to-json-schema` emits Zod's `z.discriminatedUnion` as JSON
Schema's `oneOf` with `discriminator: { propertyName: '...' }`.
`datamodel-code-generator` reads this and emits Pydantic
`Discriminator(...)` annotations.

We verify this end-to-end on day 1 of Phase 2 against
`BulkOnExisting`, `BulkSource`, and the `IngestLocalPathsRequest`
discriminated union (the most complex case in the contracts
today).

If the round-trip produces incorrect Python (no documented
issues, but worth probing), the fallback is a small post-codegen
hand-edit pass — covered in §5.4.

---

## 5. Codegen pipeline

### 5.1 The script — `codegen/generate.py`

```python
"""
Regenerate src/textral/models/ from
@textral/contracts/dist/schemas/*.json.

Usage:
    python codegen/generate.py [--check]

--check exits non-zero if regeneration would change any file
(used by CI).
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONTRACTS_SCHEMAS = (
    ROOT.parent / "contracts" / "dist" / "schemas"
)
OUTPUT_DIR = ROOT / "src" / "textral" / "models"
LOCAL_SCHEMAS = ROOT / "codegen" / "schemas"

def stage_schemas():
    """Copy schemas from @textral/contracts/dist/schemas/ into
    codegen/schemas/. Done as a deliberate step so CI fingerprints
    can detect changes."""
    LOCAL_SCHEMAS.mkdir(parents=True, exist_ok=True)
    for f in LOCAL_SCHEMAS.glob("*.json"):
        f.unlink()
    for f in CONTRACTS_SCHEMAS.glob("*.json"):
        shutil.copy(f, LOCAL_SCHEMAS / f.name)

def generate():
    """Run datamodel-code-generator over the staged schemas."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    # Wipe everything except __init__.py (which is hand-maintained
    # to surface the public exports cleanly).
    for f in OUTPUT_DIR.glob("*.py"):
        if f.name != "__init__.py":
            f.unlink()
    cmd = [
        "datamodel-codegen",
        "--input", str(LOCAL_SCHEMAS),
        "--input-file-type", "jsonschema",
        "--output", str(OUTPUT_DIR),
        "--output-model-type", "pydantic_v2.BaseModel",
        "--target-python-version", "3.10",
        "--use-double-quotes",
        "--use-annotated",
        "--field-constraints",
        "--use-schema-description",
        "--reuse-model",
        "--use-field-description",
        "--enum-field-as-literal", "all",
        "--snake-case-field",
        "--collapse-root-models",
    ]
    subprocess.run(cmd, check=True)

def write_init():
    """Generate src/textral/models/__init__.py — hand-maintained
    barrel that re-exports every public model."""
    # Walk OUTPUT_DIR/*.py, extract class names, emit
    # `from .{module} import {Class}` lines.
    ...

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    stage_schemas()
    generate()
    write_init()

    if args.check:
        # If `git status --porcelain` shows any change under
        # OUTPUT_DIR or LOCAL_SCHEMAS, exit 1.
        result = subprocess.run(
            ["git", "diff", "--exit-code", "--", str(OUTPUT_DIR), str(LOCAL_SCHEMAS)],
            cwd=ROOT,
        )
        sys.exit(result.returncode)

if __name__ == "__main__":
    main()
```

### 5.2 The output

`src/textral/models/` after a clean run:

```
models/
├── __init__.py            # hand-maintained barrel
├── auth.py                # generated
├── bulk_ingest.py         # generated
├── chunk.py               # generated
├── error.py               # generated
├── eval.py                # generated
├── ingest.py              # generated
├── infra_key.py           # generated
├── models.py              # generated
├── namespace.py           # generated
├── provider.py            # generated
├── provider_key.py        # generated
└── query.py               # generated
```

Each generated file has a header comment:

```python
# AUTO-GENERATED by codegen/generate.py from
# @textral/contracts/dist/schemas/*. DO NOT EDIT.
# To update: bump @textral/contracts, run `python codegen/generate.py`.
```

### 5.3 CI drift detection

```yaml
# .github/workflows/python-sdk.yml (excerpt)
- name: Verify Pydantic models match contracts
  run: |
    python codegen/generate.py --check
```

Any time `@textral/contracts` is bumped without regenerating,
this fails the build. Forces the commits to stay in sync.

### 5.4 Hand-edit escape hatch

If `datamodel-code-generator` produces something that doesn't
work right (rare but possible — discriminated-union edge cases,
recursive types, etc.), the workflow:

1. Identify the affected schema.
2. Add a post-codegen fixup in `codegen/generate.py` that
   patches the generated file (e.g., insert a missing import,
   adjust a `Field(...)` annotation).
3. **Never edit `src/textral/models/*.py` directly.** All edits
   must round-trip through the codegen script so CI parity holds.

---

## 6. `_http.py` — single chokepoint

Every request from both `Client` and `AsyncClient` goes through
`_http.py`. This is where:

- The auth header is injected.
- Retry / backoff is applied.
- Profile resolution happens (constructor-time, then cached on
  the client).
- `httpx.HTTPStatusError` is unwrapped into `TextralAPIError`.
- The base URL is composed.

### 6.1 Public shape

```python
# _http.py

from typing import Any, AsyncIterator, Iterator, Mapping, Optional
import httpx
from .profile import resolve_profile, Profile
from .errors import TextralAPIError, TextralRetryExhausted

class _BaseHttp:
    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        profile: Optional[str] = None,
        retry: RetryPolicy = DEFAULT_RETRY,
        timeout: float = 30.0,
    ):
        resolved = resolve_profile(name=profile, base_url=base_url, api_key=api_key)
        self._base_url = resolved.base_url
        self._headers = {"X-Textral-Api-Key": resolved.api_key}
        self._retry = retry
        self._timeout = timeout

    def _url(self, path: str) -> str:
        return f"{self._base_url.rstrip('/')}{path}"

    @staticmethod
    def _unwrap_error(resp: httpx.Response) -> None:
        if resp.is_success:
            return
        try:
            envelope = resp.json()
            err = envelope.get("error", {})
            raise TextralAPIError(
                status_code=resp.status_code,
                code=err.get("code", "UNKNOWN"),
                message=err.get("message", resp.reason_phrase),
                request_id=err.get("request_id"),
                details=err.get("details"),
            )
        except (ValueError, KeyError):
            raise TextralAPIError(
                status_code=resp.status_code,
                code="UNKNOWN",
                message=resp.text,
                request_id=None,
                details=None,
            )


class SyncHttp(_BaseHttp):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._client = httpx.Client(timeout=self._timeout)

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Mapping[str, Any]] = None,
        params: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        return self._with_retry(
            method, path,
            lambda: self._client.request(
                method,
                self._url(path),
                headers=self._headers,
                json=json,
                params=params,
            ),
        )

    def _with_retry(self, method: str, path: str, fn) -> Any:
        # Implements §5 retry policy from NODE_SDK_IMPLEMENTATION
        # (mirrored 1:1 in Python).
        ...


class AsyncHttp(_BaseHttp):
    # Same shape, async methods.
    ...
```

### 6.2 Retry mirror

The retry policy is a 1:1 mirror of `packages/sdk/src/retry.ts`:

- 3 attempts default
- Exponential backoff with ±25% jitter
- Retry on 429/502/503/504
- Respects `Retry-After`
- Idempotent POST allowlist matches the Node SDK
- `TextralRetryExhausted` raised after maxAttempts

The mirror is enforced by the cross-SDK invariants test (§9.5).

---

## 7. Sync `Client` + async `AsyncClient`

### 7.1 Shape

```python
# client.py

from typing import Optional
from .models.namespace import Namespace
from .models.query import QueryRequest, QueryResponse
# ... etc
from ._http import SyncHttp

class Client:
    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        profile: Optional[str] = None,
        retry: RetryPolicy = DEFAULT_RETRY,
        timeout: float = 30.0,
    ):
        self._http = SyncHttp(
            base_url=base_url,
            api_key=api_key,
            profile=profile,
            retry=retry,
            timeout=timeout,
        )
        self.namespaces = _Namespaces(self._http)
        self.documents = _Documents(self._http)
        self.query = _Query(self._http)
        self.query_events = _QueryEvents(self._http)
        self.provider_keys = _ProviderKeys(self._http)
        self.infra_keys = _InfraKeys(self._http)
        self.bulk_ingest = _BulkIngest(self._http)
        self.models = _Models(self._http)
        self.admin = _Admin(self._http)

    def me(self) -> MeResponse:
        return MeResponse.model_validate(self._http.request("GET", "/v1/me"))

    def close(self) -> None:
        self._http._client.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()
```

### 7.2 Resource sub-objects

Each resource is a small class taking the `_http` instance:

```python
class _Namespaces:
    def __init__(self, http: SyncHttp) -> None:
        self._http = http

    def list(self) -> list[Namespace]:
        r = self._http.request("GET", "/v1/namespaces")
        return [Namespace.model_validate(n) for n in r["data"]]

    def create(self, body: NamespaceCreate) -> Namespace:
        r = self._http.request("POST", "/v1/namespaces", json=body.model_dump(exclude_none=True))
        return Namespace.model_validate(r)

    # ...
```

The async variant uses `await self._http.request(...)`.

### 7.3 Sync vs async — keep two parallel files

Per `SDKS_DESIGN_PLAN.md §5.5`:

> sync `client.py` and async `async_client.py` are sister files.
> Same method names, same signatures (modulo `await`).

A clever decorator pattern that yields both was considered and
rejected — it makes IDE autocomplete and mypy errors harder to
read, and the two files are short enough that duplication is
cheap. The cross-method-parity test (§9.5) catches signature
drift.

### 7.4 Bulk orchestrator parity

`client.bulk_ingest.orchestrate(...)` mirrors
`@textral/sdk`'s `bulkIngestOrchestrate`. Method shape:

```python
def orchestrate(
    self,
    *,
    namespace: str,
    config: BulkConfig,
    files: list[BulkOrchestrateFile],
    on_existing: BulkOnExisting = "skip_if_unchanged",
    auto_finalize: bool = True,
    client_request_id: Optional[str] = None,
    concurrency: int = 6,
    on_progress: Optional[Callable[[BulkJobStatus], None]] = None,
    poll_interval_ms: int = 1500,
) -> BulkJobStatus: ...
```

`BulkOrchestrateFile` is a dataclass:

```python
@dataclass
class BulkOrchestrateFile:
    filename: str
    bytes: bytes | BinaryIO         # in-memory or stream
    size_bytes: int
    content_type: str
    client_request_id: Optional[str] = None
```

Both `bytes` and `BinaryIO` accepted; the orchestrator streams
either to httpx's `data=` arg.

---

## 8. Streaming + pagination

### 8.1 `_stream.py`

```python
async def stream_sse(
    response: httpx.Response,
) -> AsyncIterator[dict[str, Any]]:
    """Parse an SSE response into a stream of typed frames.
    Caller owns the response (we don't open/close)."""
    buffer = ""
    async for chunk in response.aiter_text():
        buffer += chunk
        while "\n\n" in buffer:
            frame, buffer = buffer.split("\n\n", 1)
            data_lines = [l[6:] for l in frame.split("\n") if l.startswith("data: ")]
            if not data_lines:
                continue
            payload = "\n".join(data_lines)
            if payload == "[DONE]":
                return
            yield json.loads(payload)
```

`_Query.stream(...)` (async only) wraps this:

```python
async def stream(self, body: QueryRequest) -> AsyncIterator[QueryStreamFrame]:
    async with self._http._client.stream(
        "POST",
        self._http._url("/v1/query"),
        params={"stream": "sse"},
        headers=self._http._headers,
        json=body.model_dump(exclude_none=True),
    ) as resp:
        if not resp.is_success:
            await resp.aread()
            self._http._unwrap_error(resp)
        async for frame in stream_sse(resp):
            yield QueryStreamFrame.model_validate(frame)
```

The sync `Client` does not have `query.stream` — streaming is
async-only, mirroring the Node SDK's async-only iterator design.
The sync `Client.query(...)` returns the synchronous JSON
response.

### 8.2 `_paginate.py`

```python
async def paginate_async(
    fetcher: Callable[[Optional[str]], Awaitable[dict[str, Any]]],
) -> AsyncIterator[dict[str, Any]]:
    cursor: Optional[str] = None
    while True:
        page = await fetcher(cursor)
        for item in page.get("data", []):
            yield item
        cursor = page.get("next_cursor")
        if cursor is None:
            return

def paginate_sync(
    fetcher: Callable[[Optional[str]], dict[str, Any]],
) -> Iterator[dict[str, Any]]:
    # symmetric, sync flavor
    ...
```

Each list method has a sibling `iterate(...)` that wraps:

```python
class _QueryEvents:
    def list(self, *, namespace_slug=None, status=None, limit=50, cursor=None):
        ...

    def iterate(self, *, namespace_slug=None, status=None, page_size=50):
        return paginate_sync(
            lambda cursor: self._http.request(
                "GET", "/v1/query-events",
                params={"namespace_slug": namespace_slug, "status": status,
                        "limit": page_size, "cursor": cursor},
            )
        )
```

---

## 9. Tests

### 9.1 Layout

```
tests/
├── conftest.py                     # respx fixtures + mock-server URL
├── fixtures/
│   ├── responses/
│   │   ├── namespaces_list.json
│   │   ├── query_response.json
│   │   ├── error_envelope.json
│   │   └── ...
│   └── profiles/
│       ├── multi-profile.toml
│       └── empty.toml
├── test_client_sync.py             # per-resource happy + 1 error case
├── test_client_async.py            # async equivalents
├── test_retry.py                   # retry policy
├── test_stream.py                  # SSE parser + interruption + abort
├── test_paginate.py                # async iterator + early-stop
├── test_profile.py                 # precedence chain
└── test_models_parity.py           # codegen-drift guard
```

### 9.2 respx-based mocking

`respx` mocks at the httpx transport layer — no real HTTP. Each
test sets up routes:

```python
@respx.mock
def test_namespaces_list(client_sync):
    respx.get("http://x/v1/namespaces").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    result = client_sync.namespaces.list()
    assert result == []
```

### 9.3 Async tests

`pytest-asyncio` mode is set globally in pyproject. Tests just
mark `async def` and pytest handles it.

### 9.4 Cross-method-parity test

`test_models_parity.py` does two things:

```python
def test_models_match_contracts():
    """Every JSON schema under codegen/schemas/ has a corresponding
    Pydantic class in textral.models. Catches a contracts bump
    that didn't run codegen."""
    schema_names = {p.stem for p in CODEGEN_SCHEMAS.glob("*.json")}
    model_names = set(_introspect_model_class_names())
    missing = schema_names - model_names
    assert not missing, f"Schemas without Python models: {missing}"

def test_method_surface_matches_node_sdk():
    """Read packages/sdk/dist/index.d.ts (or a snapshot of the
    method names) and assert each shows up on Client / AsyncClient."""
    expected = _read_node_sdk_method_names()
    actual = _introspect_python_client_methods()
    drift = expected ^ actual
    assert not drift, f"Surface drift vs @textral/sdk: {drift}"
```

The second test reads from a checked-in snapshot file
`tests/fixtures/node_sdk_methods.txt` updated on the Phase 1 PR
that ships `@textral/sdk@0.2.0`. The Node SDK build emits this
snapshot via `tsc` AST inspection — see Phase 1's followup §15.

### 9.5 Retry mirror test

`test_retry.py` reuses the same fixtures as
`packages/sdk/test/retry.test.ts` (vendored into
`tests/fixtures/retry/`). Asserts identical behavior:

- 429 → retry → 200 = succeeds
- 503 × 3 = `TextralRetryExhausted`
- 500 (not in `retryOn`) = no retry
- POST `/v1/query` (not idempotent) = no retry
- Network error = retry
- `Retry-After` honored

If Node and Python diverge here, one of them is wrong — the
mirror is the safety net.

---

## 10. py.typed + mypy strict

```
src/textral/py.typed    # empty file, PEP 561 marker
```

`pyproject.toml` declares `Typing :: Typed`. `mypy --strict` runs
in CI:

```bash
mypy src/textral tests
```

Generated `models/` files pass mypy by default
(`datamodel-code-generator` emits clean Pydantic). Hand-written
files (`client.py`, `_http.py`, etc.) need explicit annotations
on every public surface.

### 10.1 Type-check the examples too

```bash
mypy examples/
```

Catches drift between the SDK's typed surface and the example code,
mirroring Phase 1's `examples-typecheck` for Node.

---

## 11. Examples

`examples/01_quick_start.py` … `07_paginate_events.py`. The full
content is in [`SDK_COOKBOOK_OUTLINE.md`](./SDK_COOKBOOK_OUTLINE.md).

### 11.1 CI integration

```bash
# .github/workflows/python-sdk.yml
- run: pip install -e .[dev]
- run: mypy src/textral tests examples
- run: pytest -q
- run: python codegen/generate.py --check
```

Each example header has a docstring with the env vars it needs:

```python
"""01_quick_start.py — Issue one query, print the answer.

Env:
    TEXTRAL_API_KEY (required)
    TEXTRAL_BASE_URL (optional; defaults to hosted prod)
"""
```

The smoke runner at `examples/_smoke.py` (CI-only) executes
`01_quick_start.py` and asserts a non-empty answer when
`TEXTRAL_API_KEY` is set, and skips when it isn't.

---

## 12. Profile resolver (Python)

### 12.1 `profile.py`

```python
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

@dataclass(frozen=True)
class Profile:
    base_url: str
    api_key: str

class TextralProfileNotFound(Exception):
    def __init__(self, profile_name: str) -> None:
        super().__init__(f"Profile '{profile_name}' not found in ~/.textral/profiles.toml")
        self.profile_name = profile_name

def _profile_path() -> Path:
    override = os.environ.get("TEXTRAL_PROFILES_FILE")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".textral" / "profiles.toml"

def load_profile_file() -> Optional[dict]:
    path = _profile_path()
    if not path.exists():
        return None
    return tomllib.loads(path.read_text())

def resolve_profile(
    *,
    name: Optional[str] = None,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Profile:
    # Precedence: explicit args > env vars > file
    if base_url and api_key:
        return Profile(base_url=base_url, api_key=api_key)

    env_url = os.environ.get("TEXTRAL_BASE_URL")
    env_key = os.environ.get("TEXTRAL_API_KEY")
    if env_url and env_key:
        return Profile(base_url=env_url, api_key=env_key)

    file = load_profile_file()
    if file is None:
        raise TextralProfileNotFound(name or "<no-profile>")

    profile_name = name or file.get("default") or "local"
    profiles = file.get("profiles", {})
    if profile_name not in profiles:
        raise TextralProfileNotFound(profile_name)
    p = profiles[profile_name]
    return Profile(base_url=p["base_url"], api_key=p["api_key"])
```

### 12.2 Cross-language file format guarantee

The format is identical to what `@textral/profiles` reads. A
single `~/.textral/profiles.toml` works for the Node SDK, Python
SDK, and MCP server simultaneously.

A test in `tests/test_profile.py` reads the same fixture file
that's used in the Node SDK's `packages/profiles/test/` (vendored
in via a `make sync-profile-fixtures` script) and asserts both
languages' resolvers return the same `(base_url, api_key)` for
the same profile name.

---

## 13. Errors module

```python
# errors.py

class TextralError(Exception):
    """Base for all textral exceptions."""

class TextralAPIError(TextralError):
    """Server returned a non-2xx envelope."""
    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        request_id: Optional[str] = None,
        details: Optional[dict] = None,
    ):
        super().__init__(f"{code}: {message}")
        self.status_code = status_code
        self.code = code
        self.message = message
        self.request_id = request_id
        self.details = details

class TextralRetryExhausted(TextralError):
    """Retry policy gave up after maxAttempts."""
    def __init__(self, attempts: int, last_error: BaseException) -> None:
        super().__init__(f"retries exhausted after {attempts} attempts: {last_error}")
        self.attempts = attempts
        self.last_error = last_error

class TextralStreamInterrupted(TextralError):
    """An SSE stream was interrupted before the [DONE] frame."""

class TextralProfileNotFound(TextralError):
    # Lifted from profile.py for re-export ergonomics
    ...
```

---

## 14. PyPI publish ritual

New file: `docs/runbooks/PYTHON_SDK_RELEASE.md` (sister to
`MCP_RELEASE.md`).

### 14.1 Pre-flight

- Python 3.10+ in the active env.
- `pip install hatch twine`.
- `twine register textral` / PyPI account membership confirmed.
- Working tree clean.
- Phase 1's `@textral/{contracts,profiles,sdk,mcp}@0.2.0` already on
  npm. (Codegen reads from
  `node_modules/@textral/contracts/dist/schemas`, so the npm bump
  must be live before regenerating.)

### 14.2 Build

```bash
cd packages/sdk-python

# 1. Refresh codegen against the just-published contracts.
pnpm install                       # picks up new @textral/contracts
python codegen/generate.py --check # must be clean

# 2. Run all checks.
mypy src/textral tests examples
pytest -q
python codegen/generate.py --check

# 3. Build wheel + sdist.
hatch build
ls dist/                           # textral-0.2.0-py3-none-any.whl + .tar.gz

# 4. Verify the wheel.
twine check dist/*

# 5. Smoke-install in a fresh venv.
python -m venv /tmp/textral-smoke
source /tmp/textral-smoke/bin/activate
pip install dist/textral-0.2.0-py3-none-any.whl
python -c "from textral import Client; print(Client.__module__)"
```

### 14.3 Publish

```bash
# Test PyPI first.
twine upload --repository testpypi dist/*
pip install --index-url https://test.pypi.org/simple textral==0.2.0
python -c "from textral import Client"

# Real PyPI.
twine upload dist/*

# Tag.
git tag python-v0.2.0
git push --tags
```

### 14.4 Lockstep version invariant

`packages/sdk-python/src/textral/_version.py`:

```python
__version__ = "0.2.0"
```

A pre-publish hook (in the runbook) asserts `pyproject.toml` and
`_version.py` agree, AND match `packages/sdk/package.json`'s
version. Drift is a release blocker.

---

## 15. Sequence

```
PHASE 2 (≈ 8 working days, blocked on Phase 1 landing first)

Day 0:
  - Confirm `textral` PyPI availability; pick name.
  - Reserve the name with a 0.0.0 placeholder if available.

Day 1:
  - packages/sdk-python/ skeleton: pyproject.toml, src/, tests/.
  - codegen/generate.py + JSON Schema staging.
  - First codegen run against contracts 0.2.0 schemas; verify
    discriminated unions (BulkOnExisting, BulkSource, etc.) emit
    correct Pydantic v2 Annotated[Union[...], Discriminator(...)].

Day 2:
  - profile.py + tests (cross-language fixture).
  - errors.py.
  - _http.py SyncHttp + retry policy.

Day 3:
  - client.py — Client class + every resource sub-object.
  - tests/test_client_sync.py per-resource happy + 1 error.

Day 4:
  - _http.py AsyncHttp.
  - async_client.py — AsyncClient mirror.
  - tests/test_client_async.py.

Day 5:
  - _stream.py + AsyncClient.query.stream.
  - _paginate.py + iterate() additions on every list method.
  - tests/test_stream.py + tests/test_paginate.py.

Day 6:
  - bulk_ingest.orchestrate (sync + async).
  - tests/test_retry.py mirror against Node fixtures.
  - tests/test_models_parity.py drift guard + method surface.

Day 7:
  - examples/01–07. Smoke runner. py.typed + mypy strict pass.
  - README full draft (mirrors Node SDK README structure).

Day 8:
  - Test PyPI dry-run + real PyPI publish.
  - Tag python-v0.2.0; update PYTHON_SDK_RELEASE.md runbook.
  - Update SDKS_DESIGN_PLAN.md status flag.
```

---

## 16. Risk register

| Risk | Mitigation |
|---|---|
| `datamodel-code-generator` produces non-idiomatic Pydantic for some Zod shape we depend on. | Day 1 of Phase 2 is a discriminated-union spike. If it fails, we apply post-codegen fixups (§5.4) — never hand-edit the output. |
| The Phase 1 contracts schema export emits something `datamodel-code-generator` can't read. | Phase 1 day 1 verifies a round-trip on at least one discriminated union before promoting to release. |
| The PyPI name `textral` is taken. | Fallback to `textral-ai`. Decision rule in §2. |
| Cross-language signature drift goes undetected. | `tests/test_models_parity.py` reads a snapshot from the Node SDK's emitted method-name list; PRs that touch one SDK without the other fail CI. |
| The retry-mirror test diverges in subtle behavior (e.g., jitter calculation). | Both SDKs read the same fixture file (`fixtures/retry/*.json`) describing the input/output sequence; the test asserts the same outputs given the same inputs. |
| httpx version churn breaks the SDK. | Pin major: `httpx>=0.27,<1.0`. Refresh the upper bound when 1.0 ships. |
| Pydantic v3 ships a breaking change. | Pin major: `pydantic>=2.6,<3.0`. Same. |

---

## 17. Done when

- [ ] `pip install textral` (or `textral-ai`) works.
- [ ] `from textral import Client; c = Client(profile="hosted-prod"); c.namespaces.list()` works against the same `~/.textral/profiles.toml` the Node SDK + MCP read.
- [ ] Async equivalent of every sync method.
- [ ] mypy strict + `py.typed` marker present.
- [ ] Pydantic models codegen'd from `@textral/contracts`; CI fails on drift via `python codegen/generate.py --check`.
- [ ] Method-surface parity test passes against the Node SDK snapshot.
- [ ] Retry-mirror test passes against the shared retry fixtures.
- [ ] Streaming + pagination + retry + cancellation match Node semantics.
- [ ] 7 example scripts in `examples/` all type-check + (the smoke one) executes against dev API.
- [ ] `textral==0.2.0` live on PyPI in lockstep with `@textral/{contracts,profiles,sdk,mcp}@0.2.0`.

---

## 18. Followups for after Phase 2

(Tracked here so they don't slip through the cracks once we move
to Phase 3 / 1.0 lockstep.)

- **CLI** (`textral query "..."`). Post-1.0. `[project.scripts]`
  entry, Click, reuses the SDK.
- **Python MCP server.** Separate roadmap item if demand emerges.
- **Eval harness integration.** When `EVAL_AS_A_SERVICE.md` lands,
  the Python SDK is its first-class consumer. Make sure the eval
  surface aligns with the Pydantic models we ship here.
- **Streaming retry?** Per the locked decision, no. But if
  customers ask, the design knob lives on the
  `RetryPolicy.stream_retry` field that's currently absent.
- **WebSocket / long-poll alternatives to SSE.** Out of scope for
  v1; SSE is what the API ships today.
