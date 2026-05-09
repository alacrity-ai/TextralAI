# Textral SDKs — Design Plan

> **Scope.** Where the official client SDKs (Node + Python) need to
> get to in order to be considered table-stakes for the audience we
> serve, what the gap is from today, and a high-level design to
> close it.
>
> **Status.** Design / planning. Implementation lands in subsequent
> docs and PRs.
>
> **Last drafted:** 2026-05-08.

---

## 1. Why we're building these

Two SDKs, one strategic shape: **let the customer integrate Textral
in their language without thinking about HTTP.**

### 1.1 Distribution

Where developers already are.

- **TypeScript / Node.** `npm install @textral/sdk`. We already
  publish to npm; the SDK is at 0.1.4 today. Gets used by
  `@textral/mcp`, the Sandbox, every Node-side Textral integration.
- **Python.** `pip install textral`. **This is the table-stakes
  gap.** PyPI is where the data-science and ML-engineering audience
  lives — Jupyter / Colab / Databricks / Airflow / Prefect /
  Dagster. Eval pipelines and notebook prototypes are written in
  Python by default. Without a Python SDK, every prospect outside
  the TS ecosystem hits a "but how do I integrate?" wall and
  bounces.

A first-class Python SDK is direct parity with Pinecone, Vectara,
and the OpenAI / Anthropic SDKs. Without one, the comparison-table
row at `textral.alacrity.ai/#compared-to` reads "Python SDK: ✗"
and we lose the eval-engineer / notebook-explorer evaluator
silently.

### 1.2 Friction reduction

Every SDK method we ship is friction we don't make the customer
build.

The current `@textral/sdk` is functional but minimal. It's a
typed REST mapping — one method per route. What it doesn't do:

- Streaming queries (`?stream=sse` → async iterator over SSE
  frames). The API exposes it; the SDK requires the customer to
  hand-roll SSE consumption.
- Retry / backoff on 429/5xx. The README explicitly says "no retry
  logic." Every production integrator writes the same retry shim.
- `AbortSignal` cancellation. Long-running queries / large
  multi-file uploads can't be cancelled cleanly today.
- Pagination iterators. Cursor pagination works, but the caller
  has to manage `next_cursor` themselves — there's no `for await
  of client.queryEvents.iterate({...})` ergonomic.
- Profile resolution. `~/.textral/profiles.toml` is a feature only
  the MCP server uses today. The SDK requires the caller to wire
  `baseUrl` + `apiKey` themselves every time. Every developer who
  uses both `local` and `hosted-prod` profiles re-implements this.

The Node SDK is "shipped" but not **1.0-ready**. Closing this gap
is the first half of this design plan.

### 1.3 Trust signal

Customers read SDKs as a quality signal. Polished SDKs say "this
is a real product." A well-tested SDK with retry, streaming,
cancellation, and a cookbook is a stronger trust signal than a
"reach the API directly via curl" story. A 1.0 commitment to a
stable SDK surface lets enterprise prospects pin a version.

### 1.4 What "SDK" means here, precisely

For both SDKs, the canonical reference is:

- **Surface parity** — every public REST route has a method. A
  customer can do anything the REST API supports through the SDK.
- **Type fidelity** — every request body and response shape is
  typed against the canonical contracts (`@textral/contracts`).
  The SDK can't drift from the wire shape without a schema-side
  change.
- **Profile-aware** — `~/.textral/profiles.toml` resolution that
  matches the MCP's behavior. One source of truth for endpoint +
  key configuration across MCP, Node, Python.
- **Resilient** — retries, timeouts, cancellation, structured
  error envelope unwrapping.
- **Cookbook-equipped** — a `examples/` directory that's also
  smoke-tested in CI. New users get from "I just heard about you"
  to "my first cited answer" by running one script.
- **Released in lockstep with `@textral/contracts`** — versions
  bump together; the source-of-truth contracts are the version
  pin point.

---

## 2. Current state assessment

### 2.1 Node SDK (`@textral/sdk`) — exists, needs polish

**On disk:** `packages/sdk/`. Currently 851 LOC of
implementation across:

- `client.ts` (410 LOC) — `TextralClient` class with one method
  per REST route. Resource blocks for `namespaces` / `documents` /
  `query` / `queryEvents` / `providerKeys` / `infraKeys` /
  `bulkIngest` / `models` / `admin`.
- `bulk-orchestrator.ts` (206 LOC) — high-level helper that
  drives the full bulk-ingest choreography (manifest → parallel
  PUTs → poll). Reused by Sandbox + MCP.
- `errors.ts` (16 LOC) — `TextralApiError` envelope unwrap.
- `index.ts` (19 LOC) — barrel export.
- `test/client.test.ts` (96 LOC) — minimal smoke test.
- `README.md` (104 LOC) — usage examples for the headline routes.

Published as `@textral/sdk@0.1.4` on npm; consumed by
`@textral/mcp` and the Sandbox `apps/sandbox/src/api/`. The basic
contract is good — every method is one HTTP request, every
response is typed by `@textral/contracts`.

**Gaps blocking 1.0:**

| Gap | Impact |
|---|---|
| No streaming query support | Customer must hand-roll SSE consumption against `?stream=sse`. |
| No retry / backoff | Customer must wrap every call. 429 storms hit users immediately. |
| No `AbortSignal` cancellation in client methods (only the orchestrator) | Long queries / uploads can't be cancelled cleanly. |
| No pagination async-iterators | `await for (const e of client.queryEvents.iterate({...}))` not available; caller manages `next_cursor`. |
| No profile resolver | `~/.textral/profiles.toml` only works in MCP; SDK callers re-wire endpoints + keys. |
| Test coverage minimal | One test file at 96 LOC for 410 LOC of client + 206 LOC of orchestrator. |
| No examples / cookbook | The README has snippets; there's no `examples/` directory testable in CI. |
| No SemVer 1.0 commitment | Sub-1.0 means breaking changes per minor; enterprise customers can't pin. |

### 2.2 Python SDK — does not exist

**On disk:** nothing.

**Documentation:**
[`docs/roadmap/PYTHON_SDK.md`](../../roadmap/PYTHON_SDK.md) is a
focused roadmap doc that lays out the strategy at a high level.
Its acceptance criteria are still right; this design plan
inherits from it and goes deeper on file layout + phasing.

The PYTHON_SDK.md scope, summarized:

- New package: `packages/sdk-python/` (src layout, pyproject.toml,
  Hatch or Poetry).
- Mirror `@textral/sdk` 1:1, including `bulkIngest.orchestrate`.
- Sync `Client` + async `AsyncClient`, both httpx-based.
- Pydantic v2 models for every contract (mirror `@textral/contracts`).
- Profile resolver matching MCP's `~/.textral/profiles.toml`
  behavior.
- mypy strict + `py.typed`.
- Lockstep release with TS packages.

Out for v1 (per PYTHON_SDK.md): a Python MCP server and a CLI.

---

## 3. Strategy

Two principles:

**(A) Make the contracts the source of truth, in both languages.**
Hand-mirroring drifts. We commit to deriving Python types from the
Zod schemas in `@textral/contracts` so a schema bump on the Node
side is the same SHA that updates the Python types.

**(B) Cross-SDK invariants — keep the methods identical.** A
Textral user who knows the Node API knows the Python API.
Resource blocks, method names, parameter shapes all match. Sync
Python mirrors sync TS; async Python mirrors `Promise`-returning
TS.

### 3.1 Codegen vs hand-maintained — locked

**Decision: codegen for Python types, hand-maintained for the
client surface.**

- **Models** (Pydantic) — generated from
  `@textral/contracts` Zod via JSON Schema → datamodel-code-generator.
  Drift is a CI failure.
- **Client surface** (`Client` class methods, parameter handling,
  pagination, retry, profile resolution) — hand-maintained in
  Python. The surface is small enough (~30 methods) that hand-
  maintaining preserves better Python ergonomics than codegen
  would. Drift is caught by surface-parity tests (§5.4).

The TS SDK doesn't need codegen — it imports
`@textral/contracts` directly.

### 3.2 SemVer 1.0 commitment — staged

The Node SDK is at `0.1.x`. We ship the polish at `0.2.x`, then
once the Python SDK is also feature-complete and the API surface
has been frozen for ~30 days, both bump to **`1.0.0` together**
with a written compatibility commitment ("we will not break the
public surface within `1.x` without a `2.0`").

This avoids cutting `1.0.0` on the Node SDK before the Python SDK
is even started — the cross-language invariant matters more than
either single-language milestone.

---

## 4. Node SDK plan (`@textral/sdk`)

Polish to 1.0-ready over `0.2.x` releases. Every change is
additive; no breaking changes to the existing
`TextralClient` surface.

### 4.1 Streaming query

API surface today: `POST /v1/query?stream=sse` returns SSE frames
of shape `{type: 'token', value: string}` / `{type: 'citation',
...}` / `{type: 'audit', ...}` / `{type: 'done'}`.

SDK addition:

```ts
client.query.stream(body): AsyncIterable<QueryStreamFrame>
```

Returns an async iterator. Caller does:

```ts
for await (const frame of client.query.stream({...})) {
  if (frame.type === 'token') process.stdout.write(frame.value);
}
```

Implementation: `fetch` with the `?stream=sse` query param,
read `response.body` as a `ReadableStream`, parse SSE frames,
yield. Aborts on `AbortSignal.abort()`.

### 4.2 Retry / backoff

Configurable per-client + per-method override:

```ts
new TextralClient({
  baseUrl,
  apiKey,
  retry: {
    maxAttempts: 3,
    initialDelayMs: 200,
    maxDelayMs: 5_000,
    retryOn: [429, 502, 503, 504],
  },
});
```

Defaults: 3 attempts, exponential backoff with jitter, retry on
429 + 5xx (idempotent methods only — GET / DELETE; POST methods
opt-in). Respects `Retry-After` when present. Telemetry: emits a
`textral_retry` event on each attempt.

Retry hook is the single throat-cutter — every method goes through
the same `_callWithRetry()` internal.

### 4.3 Cancellation

Every public method gains an optional `signal?: AbortSignal`
parameter (mirrors `fetch`'s shape). Aborting cancels the in-flight
HTTP request and any retry attempts. The orchestrator already
takes a signal; this brings the rest of the surface into parity.

### 4.4 Pagination iterators

Every list method that today returns `{ data: T[]; next_cursor:
string | null }` gains an `iterate()` variant:

```ts
client.queryEvents.iterate({namespace_slug, status})
  → AsyncIterable<QueryEvent>

for await (const ev of client.queryEvents.iterate({
  namespace_slug: 'docs',
})) {
  // ...
}
```

Internally pages until `next_cursor === null`. Honors
`AbortSignal`. Bounded by an optional `pageSize` parameter.

### 4.5 Profile resolver

Lift the existing MCP profile loader into a shared package or
into `@textral/sdk` itself. The MCP package today reads
`~/.textral/profiles.toml` via `packages/mcp/src/profiles.ts`. We
move that logic to a runtime-shared place — either:

- **Option A:** add `loadProfile()` to `@textral/sdk` (Node-only;
  uses `node:fs` + `smol-toml`).
- **Option B:** new shared package `@textral/profiles` consumed by
  both `@textral/sdk` (Node) and `@textral/mcp`.

**Decision: Option B.** A shared `@textral/profiles` package keeps
the MCP and the SDK in sync without forking the parser; future
non-Node consumers (browser? edge?) can opt into a stub that
reads from env-only.

New constructor shape:

```ts
new TextralClient({ profile: 'hosted-prod' })   // resolves via profiles.toml
new TextralClient({ profile: 'env' })           // resolves from TEXTRAL_BASE_URL + TEXTRAL_API_KEY
new TextralClient({ baseUrl, apiKey })          // explicit, unchanged
```

### 4.6 Test coverage

Target ~80% line coverage. Specifically:

- One unit test per resource block, hitting the happy path + one
  error envelope.
- Retry behavior (mock fetch returns 429, then 200, assert one
  retry happened).
- Pagination iterator (mock fetch returns 3 pages, assert the
  iterator yields N items in order, terminates on null cursor).
- Streaming (mock SSE response, assert frames yielded in order,
  abort signal stops mid-stream).
- Profile resolver (env override, file fallback, missing profile
  error).

Test runner: vitest (already configured for the package).

### 4.7 Examples / cookbook

New top-level `packages/sdk/examples/` directory:

```
examples/
├── 01-quick-start.ts            # bare-minimum query
├── 02-ingest-and-query.ts       # full ingest → query loop
├── 03-bulk-ingest.ts            # uses the orchestrator
├── 04-streaming.ts              # SSE consumer
├── 05-profiles.ts               # ~/.textral/profiles.toml
├── 06-retry-and-cancel.ts       # AbortSignal + retry behavior
├── 07-paginate-events.ts        # async iterator
└── README.md                    # cookbook index
```

Each is `ts-node`-runnable with `TEXTRAL_API_KEY` set. CI runs
`tsc --noEmit` over the whole `examples/` directory to catch
drift; one example (the quick-start) is hooked into a smoke test
that runs against the dev environment.

### 4.8 Files / folders after Phase 4

```
packages/sdk/
├── src/
│   ├── client.ts                # TextralClient class (existing, polished)
│   ├── errors.ts                # TextralApiError + Retry-related (existing)
│   ├── index.ts                 # barrel
│   ├── retry.ts                 # NEW — retry/backoff policy + telemetry hook
│   ├── stream.ts                # NEW — SSE parser + AsyncIterable wrapper
│   ├── paginate.ts              # NEW — generic async iterator helper
│   ├── profile.ts               # NEW — re-exports @textral/profiles for SDK ergo
│   └── bulk-orchestrator.ts     # existing
├── test/
│   ├── client.test.ts           # existing — expanded to per-resource block
│   ├── retry.test.ts            # NEW
│   ├── stream.test.ts           # NEW
│   ├── paginate.test.ts         # NEW
│   ├── profile.test.ts          # NEW
│   └── orchestrator.test.ts     # NEW (extracted from bulk-ingest)
├── examples/                    # NEW (described above)
├── README.md                    # major rewrite — adds streaming, retry, profile sections
├── package.json
├── tsconfig.build.json
└── tsconfig.json
```

---

## 5. Python SDK plan (`textral` on PyPI)

Greenfield. Layout, dependencies, codegen, and surface design.

### 5.1 Distribution

- **Package name:** `textral`. Per PYTHON_SDK.md §Open
  Questions, we need to verify availability on PyPI. If taken,
  fall back to `textral-ai` with a project alias note in the
  README. Confirm at the start of implementation; the rest of the
  plan doesn't depend on the name choice.
- **Build tooling:** Hatch (PEP 621 standard, fast, well-supported).
  pyproject.toml-driven; src layout.
- **Python versions:** 3.10+. Aligns with `match` statements,
  modern typing syntax, and Pydantic v2's minimum.

### 5.2 File layout

```
packages/sdk-python/
├── pyproject.toml
├── README.md
├── LICENSE
├── src/
│   └── textral/
│       ├── __init__.py             # public exports: Client, AsyncClient, errors, models
│       ├── _version.py             # single-source version (matches @textral/sdk)
│       ├── client.py               # sync Client class
│       ├── async_client.py         # async AsyncClient class
│       ├── _http.py                # httpx wiring, retry/backoff, profile resolver
│       ├── _stream.py              # SSE parser + AsyncIterator helper
│       ├── _paginate.py            # generic page iterator (sync + async)
│       ├── errors.py               # TextralAPIError + retry-related exceptions
│       ├── profile.py              # ~/.textral/profiles.toml reader
│       ├── py.typed                # PEP 561 marker
│       └── models/                 # GENERATED — Pydantic v2 models
│           ├── __init__.py         #   barrel
│           ├── bulk.py
│           ├── chunk.py
│           ├── error.py
│           ├── ingest.py
│           ├── namespace.py
│           ├── provider_key.py
│           ├── query.py
│           └── … (one file per @textral/contracts source file)
├── tests/
│   ├── conftest.py
│   ├── test_client.py
│   ├── test_async_client.py
│   ├── test_retry.py
│   ├── test_stream.py
│   ├── test_paginate.py
│   ├── test_profile.py
│   └── test_models_parity.py       # asserts Python models == TS contracts (codegen check)
├── examples/
│   ├── 01_quick_start.py
│   ├── 02_ingest_and_query.py
│   ├── 03_bulk_ingest.py
│   ├── 04_streaming.py
│   ├── 05_profiles.py
│   ├── 06_async_client.py
│   └── README.md
└── codegen/                        # Pydantic generation scripts
    ├── README.md
    ├── generate.py                 # Zod → JSON Schema → datamodel-code-generator
    └── schemas/                    # checked-in JSON Schema (from contracts)
```

**Convention notes:**

- `client.py` and `async_client.py` are sister files. Same method
  names, same signatures (modulo `await`). Method signatures
  derive from a tiny shared decorator pattern that yields both
  sync and async variants — but only if it stays readable. If it
  doesn't, two parallel files is cleaner than meta-programming.
- `models/` is **generated** — file headers say "generated; do
  not edit." `codegen/generate.py` regenerates after a contracts
  bump. CI fails the build if `git diff` shows a hand-edit.
- `_http.py` is the single chokepoint for retries + auth header
  injection + profile resolution. Every method goes through it.

### 5.3 Codegen pipeline

```
@textral/contracts (Zod)              @textral/sdk-python/codegen/
  packages/contracts/src/*.ts             ├── generate.py (script)
  ↓                                       │
  zodToJsonSchema(...)                    │
  ↓                                       │
  packages/contracts/dist/schemas/*.json  ←─ NEW: emit JSON Schema at build time
                                          │
                                          ↓ datamodel-code-generator
                                          │
                                          packages/sdk-python/src/textral/models/*.py
```

Two new pieces:

1. **JSON Schema export from `@textral/contracts`.**
   - New file `packages/contracts/src/build-json-schema.ts` (build-
     time tool, not shipped). Imports every Zod schema and emits
     `dist/schemas/{name}.json` via `zod-to-json-schema`.
   - Hooked into `packages/contracts/package.json` as a
     `prepublishOnly` step so npm publishes ship the JSON
     schemas.
2. **datamodel-code-generator → Pydantic v2.**
   - `packages/sdk-python/codegen/generate.py` reads the JSON
     schemas and emits Pydantic v2 models into
     `src/textral/models/`.
   - CI step: regenerate, `git diff --exit-code` to fail builds
     where the contracts moved but the generated models weren't
     refreshed.

This is the part that's most worth hand-mirroring v1 if the
codegen pipeline turns out to be a yak-shave. Per
PYTHON_SDK.md, "option 2" (codegen) is recommended — it's more
setup but lower-drift. We commit to it here, but the fallback to
hand-mirroring exists.

### 5.4 Surface parity test

`tests/test_models_parity.py` asserts that:

- Every Pydantic class in `textral.models` has a TS counterpart in
  `@textral/contracts`. Compares the JSON schemas pre-codegen.
- Every method on `Client` has the same signature shape (param
  names + types) as `@textral/sdk`'s `TextralClient`.

This is the safety net for the "hand-maintained client surface"
choice in §3.1.

### 5.5 Sync + async clients

Pattern (httpx-based):

```python
from textral import Client, AsyncClient

# Sync
c = Client(profile="hosted-prod")
namespaces = c.namespaces.list()
result = c.query(namespace="docs", query="What survived?")

# Async
ac = AsyncClient(profile="hosted-prod")
namespaces = await ac.namespaces.list()
async for frame in ac.query.stream(namespace="docs", query="…"):
    ...
```

Both clients share `_http.py` for retry / profile / auth. The
`Client` wraps `httpx.Client`; `AsyncClient` wraps
`httpx.AsyncClient`.

### 5.6 Profile resolver (Python)

Mirrors MCP's behavior:

```python
Client(profile="hosted-prod")
# resolves to:
#   ~/.textral/profiles.toml lookup
#   → falls back to TEXTRAL_BASE_URL + TEXTRAL_API_KEY env
#   → falls back to constructor args (base_url=, api_key=)
```

Same precedence chain as MCP. Reads via `tomllib` (3.11+) or
`tomli` shim (3.10). The format is identical to what
`@textral/mcp` writes — a Python-side `Client` and a Node-side
`TextralClient` pointed at the same profile read the same row.

### 5.7 Tests

- Per-resource happy + error path against a recorded mock (vcr.py
  or respx).
- Retry behavior (httpx-mock returns 429 → 200, asserts one retry).
- Streaming (mocked SSE, asserts frames in order + abort).
- Pagination iterators (mocked 3-page response).
- Profile resolver (env override, file fallback, missing profile).
- Models parity (the codegen-drift detector — see §5.4).

Test runner: pytest. Async tests via pytest-asyncio.

### 5.8 Release ritual

Lockstep with `@textral/{contracts,sdk,mcp}`:

1. Bump version in `pyproject.toml` to match the npm version.
2. Run codegen + tests.
3. `python -m build` → wheel + sdist.
4. `twine upload` to PyPI.
5. Tag `python-v{version}` in git.

A new section in `docs/runbooks/MCP_RELEASE.md` (or a sister doc
`PYTHON_RELEASE.md`) covers the Python publish.

---

## 6. Cross-SDK invariants

Things that must stay identical across Node and Python:

| Invariant | Lives in |
|---|---|
| Method names + parameter shapes | Tested by `test_models_parity.py` (Python) and a similar invariant test (Node — would need to wire one against the Python contracts). |
| HTTP retry policy | Default: 3 attempts, exponential backoff, retry-on-429/5xx, idempotent methods only. Custom override per-client. |
| Profile resolution precedence | Constructor args > env vars > `~/.textral/profiles.toml`. |
| Error envelope shape | Both unwrap `{error: {code, message, details, request_id}}` into a `TextralAPIError` with `.code`, `.message`, `.details`, `.request_id`. |
| Streaming SSE frame shape | Both parse the same `{type, value/...}` JSON envelopes into typed events. |
| Pagination cursor semantics | Both treat `next_cursor === null` as terminal; both expose async iterators. |

The cross-language invariants are the real product. Either SDK
diverging is a bug.

---

## 7. Implementation phasing

A reasonable sequencing — not committed.

### Phase 1 — Node SDK to 0.2.x (≈ 5 days)

1. Day 1: pull profile resolver into `@textral/profiles`; consume
   from MCP + SDK.
2. Day 2: streaming query + tests.
3. Day 3: retry / backoff + cancellation + tests.
4. Day 4: pagination iterators + tests; expand existing test
   coverage to per-resource.
5. Day 5: examples/ directory + README rewrite.

Ships as `@textral/sdk@0.2.0` (minor — additive surface).
`@textral/contracts` and `@textral/mcp` bump in lockstep to 0.2.0.

### Phase 2 — Python SDK 0.2.0 (≈ 8 days)

1. Day 1–2: package skeleton, pyproject.toml, codegen pipeline
   (Zod → JSON Schema → Pydantic).
2. Day 3: sync `Client` + `_http.py` (retry, profile, auth).
3. Day 4: async `AsyncClient`.
4. Day 5: streaming + pagination iterators.
5. Day 6: tests (resource happy paths, retry, stream, paginate,
   profile, model parity).
6. Day 7: examples/ + cookbook + README.
7. Day 8: PyPI publish ritual + dry-run; release runbook update.

Ships as `textral==0.2.0` on PyPI in lockstep with the npm 0.2.0
release.

### Phase 3 — 1.0 commitment (≈ 2 days)

1. Day 1: surface freeze. 30-day "no breaking changes" window
   begins. CI surface-parity check turns into a release blocker.
2. Day 2: lockstep bump. `@textral/{contracts,sdk,mcp}@1.0.0`,
   `textral==1.0.0`. SemVer commitment in writing in both READMEs.

Total: ~15 working days end-to-end.

---

## 8. Open questions

1. **`@textral/profiles` as a separate package?** §4.5 picks it,
   but a sibling option is to in-line the profile loader into
   `@textral/sdk` and have the MCP package depend on the SDK
   instead of duplicating. Which feels cleaner to the team?
2. **PyPI name confirmation.** `textral` on PyPI — claimed or
   available? Confirm before any visible work.
3. **Python codegen tool choice.** `datamodel-code-generator` is
   the default proposal. Alternatives: `pydantic-codegen`,
   hand-rolled. Worth a one-day spike before committing.
4. **JSON Schema export from Zod.** `zod-to-json-schema` works
   for ~95% of Zod features; some discriminated-union shapes
   need attention. We'd want to verify against the union-shaped
   contracts (`BulkOnExisting`, `BulkSource`, etc.) early.
5. **Browser SDK?** Today the Node SDK uses `fetch` (works in
   browsers) but the profile resolver uses `node:fs` (doesn't).
   Is there a future need for a browser-only SDK build? Probably
   not — the Sandbox uses its own slim helper, and most browser-
   side use is from inside React apps that don't need profile
   resolution. Skip until asked.
6. **CLI?** A `textral` CLI (`textral query "..."`) is in the
   PYTHON_SDK.md "Out for v1" section. Recommend keeping it out;
   when we do it, the natural shape is a `[project.scripts]`
   entrypoint that re-uses the SDK + Click for argument parsing.
7. **Streaming retry semantics.** Retrying a partially-consumed
   SSE stream is different from retrying a one-shot request. Our
   default: do not retry streaming responses; surface failure to
   the caller. Worth a doc note in the SDK README.

---

## 9. Out of scope

- **A Python MCP server.** The Node MCP is canonical; a Python
  one is a separate roadmap item if demand emerges
  (PYTHON_SDK.md §Out).
- **A Rust / Go SDK.** No. Pinecone / Vectara / Cohere don't
  ship these as first-class SDKs either; the lift isn't justified
  before we have a Python SDK.
- **A fully browser-native build.** The Node SDK is fetch-based
  and works in browsers if you don't use `loadProfile()`. A
  dedicated browser build (no `node:fs` dependency) can land
  as `@textral/sdk-browser` later if a customer asks.
- **Auto-generating client methods.** Hand-maintained. The
  surface is small enough that the readability win beats the
  drift-prevention. Codegen is for *types*, not *methods*.

---

## 10. Acceptance — what "done" means

For Phase 1 (Node 0.2.x):

- [ ] `client.query.stream(body)` returns an async iterator that
      yields typed SSE frames; aborts cleanly.
- [ ] Retries 429/5xx with exponential backoff + jitter; respects
      `Retry-After`; configurable per-client.
- [ ] Every public method accepts `signal?: AbortSignal`.
- [ ] Every paginated list has an `iterate()` async iterator.
- [ ] `new TextralClient({ profile: 'hosted-prod' })` works
      against `~/.textral/profiles.toml`.
- [ ] Test coverage ≥ 80% line.
- [ ] `examples/` directory has 7 cookbook scripts; CI runs
      `tsc --noEmit` over them.
- [ ] README rewritten with streaming, retry, profile sections.

For Phase 2 (Python 0.2.0):

- [ ] `pip install textral` works from PyPI.
- [ ] `from textral import Client; c = Client(profile="hosted-prod"); c.namespaces.list()` works.
- [ ] Async equivalent of every sync method.
- [ ] mypy strict + `py.typed` marker.
- [ ] Pydantic models codegen'd from `@textral/contracts`; CI
      fails on drift.
- [ ] Method-surface parity test passes against the TS surface.
- [ ] Streaming + pagination + retry + cancellation match the TS
      semantics.

For Phase 3 (1.0):

- [ ] 30-day no-breaking-changes window has elapsed.
- [ ] Both SDKs bump to `1.0.0` in lockstep.
- [ ] SemVer commitment documented in both READMEs.

---

## 11. Sub-docs to follow this one

This high-level plan will be supported by:

- `NODE_SDK_IMPLEMENTATION.md` — concrete file-touch / route /
  test plan for Phase 1.
- `PYTHON_SDK_IMPLEMENTATION.md` — concrete file layout, codegen
  scripts, ritual for Phase 2.
- `SDK_COOKBOOK_OUTLINE.md` — the 7 example scripts mapped 1:1
  across both languages, with the sample data and the assertions
  each one is meant to demonstrate.
- A new section in `docs/runbooks/MCP_RELEASE.md` (or a sister
  `SDKS_RELEASE.md`) covering the lockstep release flow including
  PyPI.

These are explicitly *not* part of this v1 scoping doc — they're
the next layer of detail once the high-level plan is locked.

---

## 12. Related

- [`docs/roadmap/PYTHON_SDK.md`](../../roadmap/PYTHON_SDK.md) —
  the original roadmap doc; this design plan inherits and extends.
- [`docs/roadmap/ROADMAP_ITEMS.md`](../../roadmap/ROADMAP_ITEMS.md)
  — Python SDK is on the table-stakes parity list.
- [`docs/runbooks/MCP_RELEASE.md`](../../runbooks/MCP_RELEASE.md)
  — TS publish ritual; Python parallel needed.
- [`packages/contracts/`](../../../packages/contracts/) — the
  source of truth for both SDKs.
- [`packages/sdk/`](../../../packages/sdk/) — current Node SDK.
- [`packages/mcp/src/profiles.ts`](../../../packages/mcp/src/profiles.ts)
  — current `~/.textral/profiles.toml` loader; lifts into
  `@textral/profiles` per §4.5.
