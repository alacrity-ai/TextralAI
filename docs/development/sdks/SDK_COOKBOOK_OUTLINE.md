# SDK Cookbook Outline (Node + Python, lockstep)

> **Status.** Spec for the seven cookbook scripts that ship with
> both `@textral/sdk` and `textral`. Ships in tandem with
> [`NODE_SDK_IMPLEMENTATION.md`](./NODE_SDK_IMPLEMENTATION.md) and
> [`PYTHON_SDK_IMPLEMENTATION.md`](./PYTHON_SDK_IMPLEMENTATION.md).
>
> **Intent.** Every concept in the SDK has exactly one canonical
> example in this cookbook. New users get from "I just heard
> about you" to "my first cited answer" by running one script. CI
> compiles every example and (for the smoke one) executes it
> against the dev API.
>
> **Last drafted:** 2026-05-08.

---

## 1. Conventions

Each example is **paired** — one TS file under `packages/sdk/examples/`
and one Python file under `packages/sdk-python/examples/`, with
**identical scenarios, identical sample data, and identical
assertions.** A user reading either should read the other and not
notice anything has changed except the language.

### 1.1 Naming

| TS | Python | Concept |
|---|---|---|
| `01-quick-start.ts` | `01_quick_start.py` | One query, one answer |
| `02-ingest-and-query.ts` | `02_ingest_and_query.py` | Single-file ingest → query loop |
| `03-bulk-ingest.ts` | `03_bulk_ingest.py` | Bulk orchestrator |
| `04-streaming.ts` | `04_streaming.py` | SSE consumer |
| `05-profiles.ts` | `05_profiles.py` | `~/.textral/profiles.toml` |
| `06-retry-and-cancel.ts` | `06_retry_and_cancel.py` | Retry policy + AbortSignal |
| `07-paginate-events.ts` | `07_paginate_events.py` | Pagination iterators |

(TS uses kebab-case, Python uses snake_case — language idioms
preserved.)

### 1.2 Sample data

A single shared corpus: a small set of public-domain texts about
the Library of Alexandria. Carries the through-line for every
example so the user builds intuition as they progress.

```
data/
├── alexandria.md         (~3 KB) — chapter on what survived
├── lighthouse.md         (~2 KB) — chapter on the Pharos
├── scholars.md           (~4 KB) — chapter on the scholarship
├── decline.md            (~3 KB) — chapter on the decline
└── README.md             — provenance + license
```

Same files in both `packages/sdk/examples/data/` and
`packages/sdk-python/examples/data/` (vendored, not symlinked —
both packages must be standalone-installable from npm/PyPI).

The sample query throughout: **"What survived the Library of
Alexandria?"** — gives every example a real question with citable
answers.

### 1.3 Env contract

Every example reads:

- `TEXTRAL_API_KEY` (required) — the API key.
- `TEXTRAL_BASE_URL` (optional) — defaults to
  `https://api.textral.alacrity.ai`.
- `TEXTRAL_NAMESPACE` (optional) — namespace slug for the demo;
  defaults to `cookbook`.
- `TEXTRAL_PROVIDER_KEY_REF` (optional) — defaults to `openai`
  (matches the prod sandbox's registered key).

Or — instead of those three — a profile:

- `TEXTRAL_PROFILE` (optional) — profile name from
  `~/.textral/profiles.toml`. When set, overrides the explicit
  env vars.

This dual-mode makes the examples work for someone who just got
an API key (env vars) and for the engineer who already has
profiles set up.

### 1.4 Assertions for CI

Each example has a guard at the bottom:

```ts
// 01-quick-start.ts (excerpt)
const result = await client.query({...});
console.log(result.answer.text);

// CI assertion — runs only when CI=1 + TEXTRAL_API_KEY set
if (process.env.CI && result.answer.text.length === 0) {
  console.error('Empty answer');
  process.exit(1);
}
```

CI runs `01-quick-start.ts` end-to-end as a smoke test against
dev. The other six are typecheck-only (`tsc --noEmit` for TS,
`mypy` for Python).

---

## 2. Example 01 — Quick start

**Goal.** One query, one answer, three lines of code. The
"would I keep reading this README?" example.

**Sample data.** None — the namespace is assumed to already
have content (CI seeds it once, then asserts non-empty answer).

### 2.1 TypeScript

```ts
// 01-quick-start.ts
import { TextralClient } from '@textral/sdk';

const client = new TextralClient({ profile: process.env.TEXTRAL_PROFILE ?? 'hosted-prod' });

const result = await client.query({
  namespace: process.env.TEXTRAL_NAMESPACE ?? 'cookbook',
  query: 'What survived the Library of Alexandria?',
  embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536, provider_key_ref: 'openai' },
  inference:  { provider: 'openai', model: 'gpt-4o-mini',            provider_key_ref: 'openai' },
});

console.log(result.answer.text);
console.log(`citations: ${result.citations.length}`);
console.log(`audit:     ${result.audit.query_event_id}`);
```

### 2.2 Python

```python
# 01_quick_start.py
from textral import Client

client = Client(profile=__import__('os').environ.get('TEXTRAL_PROFILE', 'hosted-prod'))

result = client.query(
    namespace=__import__('os').environ.get('TEXTRAL_NAMESPACE', 'cookbook'),
    query='What survived the Library of Alexandria?',
    embedding={'provider': 'openai', 'model': 'text-embedding-3-large', 'dimensions': 1536, 'provider_key_ref': 'openai'},
    inference={'provider': 'openai', 'model': 'gpt-4o-mini', 'provider_key_ref': 'openai'},
)

print(result.answer.text)
print(f'citations: {len(result.citations)}')
print(f'audit:     {result.audit.query_event_id}')
```

### 2.3 What it demonstrates

- `Client`/`TextralClient` constructor with `profile=`.
- One method = one HTTP call = one structured response.
- Citations + audit shape.

### 2.4 CI assertion (smoke)

`result.answer.text.length > 0` AND `result.audit.retrieval_status === 'full'`.

This is the only example CI executes against the live dev API.

---

## 3. Example 02 — Ingest + query

**Goal.** Show the full single-file pipeline from raw bytes to a
cited answer. The "I want to understand the building blocks"
example.

**Sample data.** `data/alexandria.md` only. The script ingests it
fresh into a scratch namespace, queries against it, prints the
result, then deletes the namespace to leave nothing behind.

### 3.1 TypeScript (sketch)

```ts
import { TextralClient } from '@textral/sdk';
import { readFile } from 'node:fs/promises';

const client = new TextralClient({ profile: 'hosted-prod' });

// 1. Create a scratch namespace.
const scratchSlug = `cookbook-${Date.now()}`;
const ns = await client.namespaces.create({
  slug: scratchSlug,
  vector_backend: 'vectorize',
  embedding_dimensions: 1536,
});

try {
  // 2. Register document.
  const bytes = await readFile('data/alexandria.md');
  const doc = await client.documents.register(ns.slug, {
    title: 'alexandria.md',
    doc_type: 'narrative',
  });

  // 3. Upload bytes.
  const upload = await client.documents.createUpload(doc.id, {
    content_type: 'text/markdown',
    size_bytes: bytes.byteLength,
  });
  const putRes = await fetch(upload.url, {
    method: 'PUT',
    headers: { 'X-Textral-Api-Key': /* ... */, 'Content-Type': 'text/markdown' },
    body: bytes,
  });

  // 4. Finalize.
  const fin = await client.documents.finalize(doc.id, upload.upload_id);

  // 5. Ingest.
  const job = await client.documents.ingest(doc.id, {
    version_id: fin.version_id,
    embedding: { /* ... */ },
    chunking: { profile: 'generic', target_tokens: 600, overlap_tokens: 80 },
    mode: 'full',
  });

  // 6. Wait for terminal.
  await client.admin.waitForJobTerminal(job.job_id, { timeoutMs: 60_000 });

  // 7. Query.
  const result = await client.query({
    namespace: ns.slug,
    query: 'What survived the Library of Alexandria?',
    embedding: { /* ... */ },
    inference:  { /* ... */ },
  });
  console.log(result.answer.text);
} finally {
  // 8. Tear down the scratch namespace.
  await client.namespaces.delete(ns.slug);
}
```

### 3.2 Python (mirror)

Same flow, same names, `await` removed (sync `Client`).

### 3.3 What it demonstrates

- Full ingest pipeline shape: register → upload → finalize → ingest → wait → query.
- Cleanup pattern via `try/finally`.
- The audit chain implicit in `result.audit`.

(`client.admin.waitForJobTerminal` is a small helper added in
Phase 1 that polls `client.admin.getJob(jobId)` until terminal.
Mirrors `pollBulkJob` from the orchestrator.)

---

## 4. Example 03 — Bulk ingest

**Goal.** Show the bulk orchestrator. The "I have 50 markdown
files" example.

**Sample data.** All 4 files in `data/` ingested as a bulk.

### 4.1 TypeScript

```ts
import { TextralClient, bulkIngestOrchestrate } from '@textral/sdk';
import { readFile } from 'node:fs/promises';

const client = new TextralClient({ profile: 'hosted-prod' });

const filenames = ['alexandria.md', 'lighthouse.md', 'scholars.md', 'decline.md'];
const files = await Promise.all(filenames.map(async (name) => {
  const bytes = await readFile(`data/${name}`);
  return {
    filename: name,
    bytes,
    size_bytes: bytes.byteLength,
    content_type: 'text/markdown',
  };
}));

const result = await bulkIngestOrchestrate(client, {
  namespace: 'cookbook',
  config: {
    embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536, provider_key_ref: 'openai' },
    chunking: { profile: 'generic', target_tokens: 600, overlap_tokens: 80 },
    mode: 'full',
  },
  files,
  on_existing: 'skip_if_unchanged',
  auto_finalize: true,
  concurrency: 4,
  onProgress: (snap) => {
    console.log(`${snap.state}: ${snap.counts.succeeded}/${snap.total_files} (${snap.progress_pct}%)`);
  },
});

console.log(`bulk_job_id: ${result.bulk_job_id}`);
console.log(`final state: ${result.final_status.state}`);
```

### 4.2 Python (mirror)

```python
# 03_bulk_ingest.py
from textral import Client
from pathlib import Path

client = Client(profile='hosted-prod')

filenames = ['alexandria.md', 'lighthouse.md', 'scholars.md', 'decline.md']
files = [
    {
        'filename': name,
        'bytes': (Path(__file__).parent / 'data' / name).read_bytes(),
        'size_bytes': (Path(__file__).parent / 'data' / name).stat().st_size,
        'content_type': 'text/markdown',
    }
    for name in filenames
]

def on_progress(snap):
    print(f"{snap.state}: {snap.counts.succeeded}/{snap.total_files} ({snap.progress_pct}%)")

result = client.bulk_ingest.orchestrate(
    namespace='cookbook',
    config={
        'embedding': {'provider': 'openai', 'model': 'text-embedding-3-large', 'dimensions': 1536, 'provider_key_ref': 'openai'},
        'chunking': {'profile': 'generic', 'target_tokens': 600, 'overlap_tokens': 80},
        'mode': 'full',
    },
    files=files,
    on_existing='skip_if_unchanged',
    auto_finalize=True,
    concurrency=4,
    on_progress=on_progress,
)

print(f"bulk_job_id: {result.bulk_job_id}")
print(f"final state: {result.final_status.state}")
```

### 4.3 What it demonstrates

- The bulk orchestrator: file fan-out, progress callback, terminal
  state.
- `on_existing` policy options.
- Re-runs are no-op-cheap with `skip_if_unchanged`.

---

## 5. Example 04 — Streaming

**Goal.** Show SSE consumption. The "I want to render token by
token" example.

**Sample data.** The `cookbook` namespace from example 03 (or
seed equivalent).

### 5.1 TypeScript

```ts
import { TextralClient } from '@textral/sdk';

const client = new TextralClient({ profile: 'hosted-prod' });
const ac = new AbortController();

setTimeout(() => ac.abort(), 30_000); // 30s safety timeout

try {
  for await (const frame of client.query.stream({
    namespace: 'cookbook',
    query: 'What survived the Library of Alexandria?',
    embedding: { /* ... */ },
    inference:  { /* ... */ },
  }, { signal: ac.signal })) {
    switch (frame.type) {
      case 'token':    process.stdout.write(frame.value); break;
      case 'citation': console.error(`[${frame.ordinal}] → ${frame.section_path}`); break;
      case 'audit':    console.error(`audit: ${frame.query_event_id}`); break;
      case 'done':     break;
    }
  }
  console.log();
} catch (e) {
  if (e instanceof TextralStreamInterrupted) {
    console.error('stream interrupted:', e.message);
  } else {
    throw e;
  }
}
```

### 5.2 Python (async-only)

```python
# 04_streaming.py
import asyncio
from textral import AsyncClient
from textral.errors import TextralStreamInterrupted

async def main():
    client = AsyncClient(profile='hosted-prod')

    async def stream_with_timeout():
        async for frame in client.query.stream(
            namespace='cookbook',
            query='What survived the Library of Alexandria?',
            embedding={'provider': 'openai', 'model': 'text-embedding-3-large', 'dimensions': 1536, 'provider_key_ref': 'openai'},
            inference={'provider': 'openai', 'model': 'gpt-4o-mini', 'provider_key_ref': 'openai'},
        ):
            match frame.type:
                case 'token':    print(frame.value, end='', flush=True)
                case 'citation': print(f'[{frame.ordinal}] → {frame.section_path}', file=__import__('sys').stderr)
                case 'audit':    print(f'audit: {frame.query_event_id}', file=__import__('sys').stderr)
                case 'done':     pass

    try:
        await asyncio.wait_for(stream_with_timeout(), timeout=30)
    except TextralStreamInterrupted as e:
        print(f'stream interrupted: {e}', file=__import__('sys').stderr)

    print()

if __name__ == '__main__':
    asyncio.run(main())
```

### 5.3 What it demonstrates

- SSE consumption pattern in both languages.
- Frame types (`token` / `citation` / `audit` / `done`).
- 30-second safety timeout via `AbortController` (TS) /
  `asyncio.wait_for` (Python).
- `TextralStreamInterrupted` handling — streams don't retry, the
  caller decides what to do.

---

## 6. Example 05 — Profiles

**Goal.** Show `~/.textral/profiles.toml` resolution. The "I have
both a hosted-prod and a self-host instance" example.

**Sample data.** The `~/.textral/profiles.toml` file (described
in script comments — script doesn't write it).

### 6.1 TypeScript

```ts
// 05-profiles.ts
import { TextralClient, loadProfileFile } from '@textral/sdk';

// Sample profiles.toml:
//
//     default = "hosted-prod"
//
//     [profiles.hosted-prod]
//     base_url = "https://api.textral.alacrity.ai"
//     api_key  = "tx_live_..."
//
//     [profiles.local]
//     base_url = "http://localhost:8787"
//     api_key  = "tx_live_..."

// Method 1: name a profile explicitly.
const c1 = new TextralClient({ profile: 'hosted-prod' });
console.log(`c1 → ${(await c1.me()).tenant.id}`);

// Method 2: rely on the file's `default = "..."` row.
const c2 = new TextralClient({});
console.log(`c2 → ${(await c2.me()).tenant.id}`);

// Method 3: env vars override file (TEXTRAL_BASE_URL + TEXTRAL_API_KEY).
process.env.TEXTRAL_BASE_URL = 'http://localhost:8787';
process.env.TEXTRAL_API_KEY  = 'tx_live_dev...';
const c3 = new TextralClient({});
console.log(`c3 → ${(await c3.me()).tenant.id}`);

// Inspect the file's contents directly (debugging aid).
const file = await loadProfileFile();
console.log('profiles defined:', Object.keys(file?.profiles ?? {}));
```

### 6.2 Python (mirror)

```python
# 05_profiles.py
import os
from textral import Client
from textral.profile import load_profile_file

# (same profiles.toml comment block)

# Method 1: named profile.
c1 = Client(profile='hosted-prod')
print(f'c1 → {c1.me().tenant.id}')

# Method 2: default.
c2 = Client()
print(f'c2 → {c2.me().tenant.id}')

# Method 3: env override.
os.environ['TEXTRAL_BASE_URL'] = 'http://localhost:8787'
os.environ['TEXTRAL_API_KEY']  = 'tx_live_dev...'
c3 = Client()
print(f'c3 → {c3.me().tenant.id}')

# Inspect file.
file = load_profile_file()
print('profiles defined:', list((file or {}).get('profiles', {}).keys()))
```

### 6.3 What it demonstrates

- Three rungs of the precedence chain: explicit args > env vars > file.
- The file format is identical across MCP, Node SDK, and Python SDK.
- `loadProfileFile` / `load_profile_file` for debugging.

---

## 7. Example 06 — Retry & cancel

**Goal.** Show the retry policy and `AbortSignal` / async-cancellation
threading. The "I'm running this from a flaky network / a
user-cancellable UI" example.

### 7.1 TypeScript

```ts
// 06-retry-and-cancel.ts
import { TextralClient } from '@textral/sdk';

const client = new TextralClient({
  profile: 'hosted-prod',
  retry: {
    maxAttempts: 5,
    initialDelayMs: 500,
    maxDelayMs: 8_000,
    retryOn: [429, 502, 503, 504],
    onRetry: ({ attempt, status, delayMs }) => {
      console.error(`retry #${attempt}: status=${status} sleeping ${delayMs}ms`);
    },
  },
});

// Cancel any single call.
const ac = new AbortController();
setTimeout(() => ac.abort(), 5_000);

try {
  const r = await client.query({
    namespace: 'cookbook',
    query: 'What survived the Library of Alexandria?',
    embedding: { /* ... */ },
    inference:  { /* ... */ },
  }, { signal: ac.signal });
  console.log(r.answer.text);
} catch (e) {
  if (e instanceof Error && e.name === 'AbortError') {
    console.error('user cancelled');
  } else if (e instanceof TextralRetryExhausted) {
    console.error(`gave up after ${e.attempts} retries: ${e.lastError.message}`);
  } else {
    throw e;
  }
}
```

### 7.2 Python (mirror)

```python
# 06_retry_and_cancel.py
import asyncio
from textral import AsyncClient
from textral.errors import TextralRetryExhausted, RetryPolicy

def on_retry(info):
    print(f'retry #{info.attempt}: status={info.status} sleeping {info.delay_ms}ms')

client = AsyncClient(
    profile='hosted-prod',
    retry=RetryPolicy(
        max_attempts=5,
        initial_delay_ms=500,
        max_delay_ms=8_000,
        retry_on=[429, 502, 503, 504],
        on_retry=on_retry,
    ),
)

async def run():
    try:
        r = await asyncio.wait_for(
            client.query(
                namespace='cookbook',
                query='What survived the Library of Alexandria?',
                embedding={'provider': 'openai', 'model': 'text-embedding-3-large', 'dimensions': 1536, 'provider_key_ref': 'openai'},
                inference={'provider': 'openai', 'model': 'gpt-4o-mini', 'provider_key_ref': 'openai'},
            ),
            timeout=5.0,
        )
        print(r.answer.text)
    except asyncio.TimeoutError:
        print('user cancelled')
    except TextralRetryExhausted as e:
        print(f'gave up after {e.attempts} retries: {e.last_error}')

asyncio.run(run())
```

### 7.3 What it demonstrates

- Custom retry policy (every field overridable).
- `onRetry` callback for telemetry.
- `AbortSignal` (TS) / `asyncio.wait_for` (Python) for
  cancellation.
- `TextralRetryExhausted` after maxAttempts.
- The async-cancel pattern in Python (Python uses
  `asyncio.wait_for` instead of an explicit signal — same
  semantics, language-idiomatic shape).

---

## 8. Example 07 — Pagination iterators

**Goal.** Show the `iterate()` async iterator. The "give me every
event in this namespace" example.

### 8.1 TypeScript

```ts
// 07-paginate-events.ts
import { TextralClient } from '@textral/sdk';

const client = new TextralClient({ profile: 'hosted-prod' });

let total = 0;
let citations = 0;
let withFailures = 0;

for await (const ev of client.queryEvents.iterate({
  namespace_slug: 'cookbook',
})) {
  total++;
  citations += ev.citations?.length ?? 0;
  if (ev.audit?.dropped_citations?.length) withFailures++;
  if (total >= 1000) break; // example caps to 1000
}

console.log(`scanned ${total} events; ${citations} citations; ${withFailures} with dropped citations`);
```

### 8.2 Python

```python
# 07_paginate_events.py
from textral import Client

client = Client(profile='hosted-prod')

total = 0
citations = 0
with_failures = 0

for ev in client.query_events.iterate(namespace_slug='cookbook'):
    total += 1
    citations += len(ev.citations or [])
    if ev.audit and ev.audit.dropped_citations:
        with_failures += 1
    if total >= 1000:
        break

print(f'scanned {total} events; {citations} citations; {with_failures} with dropped citations')
```

### 8.3 What it demonstrates

- `iterate()` async iterator (Python sync uses regular iterator).
- Early termination via `break` — pagination stops cleanly.
- The mental model: "treat a paginated route as a stream."

(The async equivalent in Python (`async for`) is in
`02_ingest_and_query.py`'s polling loop and `04_streaming.py`'s
SSE loop. We don't ship a separate "async paginate" example —
the surface is identical, and one mention is enough.)

---

## 9. CI integration

### 9.1 Both repos

Each PR runs:

- `pnpm --filter @textral/sdk run examples-typecheck`
- `cd packages/sdk-python && mypy examples`

Catches every drift between the typed SDK surface and the
example code.

### 9.2 Smoke run (live API)

`packages/sdk/examples/_smoke.ts` runs `01-quick-start.ts`
against the dev API when `CI=1` and `TEXTRAL_API_KEY` is set.
Asserts a non-empty answer. This is the only example that
executes — the rest are typecheck-only.

`packages/sdk-python/examples/_smoke.py` mirror.

### 9.3 What seeds the `cookbook` namespace

The smoke runner assumes the `cookbook` namespace is seeded with
the four `data/*.md` files. Two ways to handle this:

1. **Manually seeded.** Before smoke-test PRs go green for the
   first time, an operator runs `03-bulk-ingest.ts` once against
   dev (and against prod, before lockstep). Subsequent ingests
   are no-op via `skip_if_unchanged`.
2. **Auto-seed in CI.** The smoke runner runs `03-bulk-ingest.ts`
   first (cheap because skip_if_unchanged), then
   `01-quick-start.ts`.

**Decision: option 2.** Auto-seed in CI keeps the smoke story
self-contained — no operator intervention. The bulk run is
~3 seconds against an already-populated namespace.

---

## 10. README cross-link

Each example has, at the top of its file:

```ts
/**
 * 03-bulk-ingest.ts — Bulk-ingest the cookbook corpus.
 *
 * Demonstrates: bulkIngestOrchestrate(), progress callback,
 * on_existing policy.
 *
 * Run:
 *     export TEXTRAL_API_KEY="..."
 *     npx tsx 03-bulk-ingest.ts
 *
 * See also:
 *     SDK_COOKBOOK_OUTLINE.md §4
 */
```

`packages/sdk/examples/README.md`:

```markdown
# Cookbook

Each example is a complete, runnable script. Set
`TEXTRAL_API_KEY` and pick a profile (or set
`TEXTRAL_BASE_URL`).

| File | Concept | Doc § |
|---|---|---|
| 01-quick-start.ts | One query, one answer | §2 |
| 02-ingest-and-query.ts | Single-file ingest pipeline | §3 |
| 03-bulk-ingest.ts | Bulk orchestrator | §4 |
| 04-streaming.ts | SSE streaming | §5 |
| 05-profiles.ts | `~/.textral/profiles.toml` | §6 |
| 06-retry-and-cancel.ts | Retry policy + cancellation | §7 |
| 07-paginate-events.ts | Pagination iterators | §8 |

Sample data lives under `data/` — public-domain texts on the
Library of Alexandria.

For the full doc, see
[SDK_COOKBOOK_OUTLINE.md](../../docs/development/sdks/SDK_COOKBOOK_OUTLINE.md).
```

The Python `examples/README.md` mirror is identical except the
file extensions and the "see also" path.

---

## 11. Maintenance discipline

When the SDK surface changes (add a method, change a parameter,
change a response shape), **the cookbook is updated in the same
PR**. Two checks enforce this:

1. **CI typecheck of every example.** If a method signature
   changes, the example fails to compile and the PR is blocked.
2. **Surface-parity test (Phase 2).**
   `tests/test_models_parity.py` reads the Node SDK's emitted
   method-name list and asserts equivalence. Adding a TS method
   without adding the Python sibling fails the build.

These two together mean the cookbook never falls out of sync —
it's a first-class part of the SDK release.

---

## 12. Open question — bulk-ingest example data lifecycle

The cookbook examples' shared `cookbook` namespace lives forever
on dev (and, after launch, on prod). After every CI run,
`skip_if_unchanged` keeps it cheap, but a **deliberate
re-seed** (changing the data files) would create a `partial`
state if `on_existing` isn't bumped.

**Decision:** the data files live under
`packages/sdk/examples/data/` (vendored into both packages).
Changes to those files are intentional and require a co-located
namespace migration:

1. Update `data/`.
2. Bump the namespace slug in the cookbook to `cookbook-vN`
   (e.g., `cookbook-v2`).
3. Update the namespace name in the cookbook README + every
   example.
4. Old `cookbook-v1` namespace is left in place; the
   `bulk-job-retention` cron eventually reaps it.

This is rare (probably ≤1× per year) but the discipline matters
when it happens.
