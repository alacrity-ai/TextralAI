# Node SDK — Implementation Plan (Phase 1, `@textral/sdk@0.2.x`)

> **Status.** Ready to build. Companion to
> [`SDKS_DESIGN_PLAN.md`](./SDKS_DESIGN_PLAN.md). Implements the
> seven Node-SDK gaps identified in §4 of that doc and lands them
> as additive minor bumps (no breaking changes to the existing
> `TextralClient` surface).
>
> **Targets.** `@textral/{contracts,sdk,profiles,mcp}@0.2.0`,
> released in lockstep.
>
> **Last drafted:** 2026-05-08.

---

## 1. Decisions locked from the design plan

The 7 open questions in `SDKS_DESIGN_PLAN.md §8` are now answered:

| # | Question | Decision |
|---|---|---|
| 1 | `@textral/profiles` as a separate package? | **Yes — separate package.** The MCP + SDK both consume; future tooling (CLI, eval harness) will too. Drift-by-construction is the only correct posture. |
| 2 | PyPI name `textral`? | Verify on day 0 of Phase 2; fall back to `textral-ai` with a project alias note. Doesn't affect Phase 1. |
| 3 | Python codegen tool? | `datamodel-code-generator`. Phase 2 concern. |
| 4 | JSON Schema export from Zod — discriminated-unions concern? | `zod-to-json-schema` ships `oneOf` for unions; `datamodel-code-generator` handles it via `Union[…]`. Verified against `BulkOnExisting` / `BulkSource` shape in Phase 2 day 1. |
| 5 | Browser SDK? | **No.** Today's `fetch`-based SDK already works in the browser if the caller skips `loadProfile()`. Sandbox uses its own `apps/sandbox/src/api/client.ts` helper. Defer until a customer asks. |
| 6 | CLI? | **No.** Post-1.0. Out of Phase 1. |
| 7 | Streaming retry semantics? | **Do not retry partially-consumed SSE streams.** Surface failure with `TextralStreamInterrupted`. Documented in README. Same rule applies to Python. |

These decisions don't get re-litigated in implementation; if a
follow-on PR wants to revisit, that's a design-plan amendment, not
an impl-time call.

---

## 2. File-touch summary

| Action | Path | Why |
|---|---|---|
| Add | `packages/profiles/` (new pnpm workspace package) | §3 — extract profile resolver |
| Add | `packages/profiles/src/index.ts` | `loadProfileFile`, `resolveProfile`, types |
| Add | `packages/profiles/src/parser.ts` | smol-toml wrapper + validation |
| Add | `packages/profiles/test/profile.test.ts` | Per-precedence-rung test |
| Add | `packages/profiles/package.json`, `tsconfig*.json`, `README.md` | standard package files |
| Edit | `packages/mcp/src/profiles.ts` | Now re-exports from `@textral/profiles` (no duplicate logic) |
| Edit | `packages/mcp/package.json` | adds `@textral/profiles` workspace dep |
| Edit | `packages/sdk/package.json` | adds `@textral/profiles` workspace dep, bump to `0.2.0` |
| Edit | `packages/sdk/src/client.ts` | new constructor `profile:` option, threads `signal` through every method |
| Add | `packages/sdk/src/retry.ts` | retry policy + backoff + telemetry hook |
| Add | `packages/sdk/src/stream.ts` | SSE parser + `AsyncIterable` wrapper |
| Add | `packages/sdk/src/paginate.ts` | generic page-iterator helper |
| Add | `packages/sdk/src/profile.ts` | thin re-export of `@textral/profiles` for SDK ergonomics (lets users `import { loadProfile } from '@textral/sdk'`) |
| Edit | `packages/sdk/src/errors.ts` | add `TextralStreamInterrupted` + `TextralRetryExhausted` |
| Edit | `packages/sdk/src/index.ts` | barrel: re-export new helpers |
| Add | `packages/sdk/test/retry.test.ts` | 429 → 200 retry, 5xx exhaustion |
| Add | `packages/sdk/test/stream.test.ts` | SSE happy path + abort + interruption |
| Add | `packages/sdk/test/paginate.test.ts` | 3-page iteration + abort + bounded `pageSize` |
| Add | `packages/sdk/test/profile.test.ts` | precedence chain + missing profile error |
| Edit | `packages/sdk/test/client.test.ts` | per-resource happy + error envelope |
| Add | `packages/sdk/examples/01-quick-start.ts` … `07-paginate-events.ts` | 7 cookbook scripts |
| Add | `packages/sdk/examples/README.md` | cookbook index |
| Add | `packages/sdk/examples/tsconfig.json` | `tsc --noEmit` for CI |
| Edit | `packages/sdk/README.md` | major rewrite — streaming, retry, profile, examples sections |
| Edit | `packages/sdk/package.json` | adds `examples-typecheck` script + bumps version |
| Edit | `package.json` (root) | adds `examples-typecheck` to `pnpm -r` aggregate scripts if needed |
| Edit | `pnpm-workspace.yaml` | already covers `packages/*`; verify `packages/profiles` picks up |
| Edit | `docs/runbooks/MCP_RELEASE.md` | adds `@textral/profiles` to the publish-order list |
| Edit | `docs/development/sdks/SDKS_DESIGN_PLAN.md` | flip "Phase 1" status to "in flight" once started |

Net: ~12 new files, ~10 edits, two existing source files (`client.ts`,
`profiles.ts`) restructured but not replaced.

---

## 3. `@textral/profiles` — new shared package

### 3.1 Why a separate package

Three consumers today (MCP + SDK + Sandbox/landing), more later
(Python SDK port, future CLI, eval harness). Forking the parser
across each is the worst possible posture — any precedence-chain
or file-format change has to be touched in N places, and the bug
is invisible until a user trips it.

### 3.2 Public surface

```ts
// packages/profiles/src/index.ts

export interface Profile {
  base_url: string;
  api_key: string;
}

export interface ProfileFile {
  default?: string;
  profiles: Record<string, Profile>;
}

/** Read ~/.textral/profiles.toml (or TEXTRAL_PROFILES_FILE
 *  override). Returns null if the file doesn't exist. Throws on
 *  malformed TOML or missing required fields. */
export async function loadProfileFile(): Promise<ProfileFile | null>;

/** Resolve to a concrete Profile via the precedence chain:
 *  1. Constructor-supplied { baseUrl, apiKey } wins.
 *  2. Env vars TEXTRAL_BASE_URL + TEXTRAL_API_KEY.
 *  3. profilesFile.profiles[name] where name = explicit param ||
 *     profilesFile.default || 'local'.
 *  Throws TextralProfileNotFound if no rung matches. */
export async function resolveProfile(opts: {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
}): Promise<Profile>;

export class TextralProfileNotFound extends Error {
  readonly name = 'TextralProfileNotFound';
  constructor(public readonly profileName: string) { super(...); }
}
```

### 3.3 Migration of `packages/mcp/src/profiles.ts`

The MCP file shrinks to a re-export plus the MCP-specific tooling
(`textral_get_profile` / `textral_set_profile` MCP tools that
mutate the file). The pure-read logic moves into
`@textral/profiles`. The MCP version stays:

```ts
// packages/mcp/src/profiles.ts (after migration)
export {
  loadProfileFile,
  resolveProfile,
  type Profile,
  type ProfileFile,
  TextralProfileNotFound,
} from '@textral/profiles';

// MCP-only mutation helpers stay here:
export async function setActiveProfile(name: string): Promise<void> { … }
export async function setDefaultProfile(name: string): Promise<void> { … }
```

This keeps `packages/mcp/src/tools/profile-tools.ts` working
unchanged.

### 3.4 Tests

- `loadProfileFile` — reads a fixture file, returns parsed shape.
- `loadProfileFile` — returns null when file missing.
- `loadProfileFile` — throws on malformed TOML.
- `resolveProfile` — explicit `baseUrl + apiKey` takes precedence.
- `resolveProfile` — env vars override file when no explicit args.
- `resolveProfile` — falls back to `profilesFile.default`.
- `resolveProfile` — throws `TextralProfileNotFound` when no rung
  matches.

### 3.5 Publishing

`@textral/profiles@0.2.0` joins the lockstep release. Order:

```
1. @textral/contracts   → npm
2. @textral/profiles    → npm   ← NEW
3. @textral/sdk         → npm   (depends on 1 + 2)
4. @textral/mcp         → npm   (depends on 1, 2, 3)
```

Update `docs/runbooks/MCP_RELEASE.md` to insert step 2 between
the existing contracts + sdk steps.

---

## 4. Streaming query

### 4.1 Public surface

```ts
client.query.stream(
  body: QueryRequest,
  opts?: { signal?: AbortSignal },
): AsyncIterable<QueryStreamFrame>;

export type QueryStreamFrame =
  | { type: 'token'; value: string }
  | { type: 'citation'; ordinal: number; chunk_id: string; section_path: string }
  | { type: 'audit'; query_event_id: string; retrieval_status: string; ... }
  | { type: 'done' };
```

`body` is a `QueryRequest`; the `?stream=sse` query param is added
internally. Frames are yielded as they arrive.

### 4.2 Implementation (`packages/sdk/src/stream.ts`)

```ts
export async function* streamSse(
  url: string,
  init: RequestInit,
): AsyncIterable<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TextralApiError(res.status, /* parse envelope */, text);
  }
  if (!res.body) throw new TextralStreamInterrupted('no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by double-newline; data: lines
      // accumulate per frame.
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6));
        if (dataLines.length === 0) continue;
        const json = dataLines.join('\n');
        if (json === '[DONE]') return;
        yield JSON.parse(json);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

The `TextralClient.query.stream(body, opts)` wraps `streamSse`
with the URL + auth header construction.

### 4.3 Cancellation

`opts.signal` is passed straight to `fetch(...)`. An aborted
signal causes `fetch` to throw `AbortError`; `streamSse` lets it
propagate. The async-iterable `finally` releases the reader lock.

### 4.4 Retry policy for streams

Per locked decision Q7: **streams do not retry**. If `fetch` throws
mid-stream, we surface `TextralStreamInterrupted` with the
underlying cause. The caller can choose whether to re-issue the
whole query themselves.

This is the only public method that ignores the configured
retry policy. The README documents this explicitly.

---

## 5. Retry / backoff

### 5.1 Configuration

```ts
new TextralClient({
  baseUrl,
  apiKey,
  retry: {
    maxAttempts: 3,           // default 3
    initialDelayMs: 200,      // default 200
    maxDelayMs: 5_000,        // default 5_000
    retryOn: [429, 502, 503, 504],
    onRetry: (info) => {...}, // optional telemetry hook
  },
});
```

`retry: false` disables retries entirely. Per-method override is
not in v1 — the per-client policy covers 99% of use; method-level
override is YAGNI until someone asks.

### 5.2 Default policy

```
attempts:   3
backoff:    initialDelayMs * 2^(attempt - 1), capped at maxDelayMs
jitter:     ±25% on each delay
retry-on:   [429, 502, 503, 504]
respect:    Retry-After header (seconds or HTTP-date)
methods:    GET + DELETE always; POST only if the route is in the
            idempotent allowlist (below)
```

**Idempotent POST allowlist** — POSTs that are safe to retry
because the server uses dedupe keys or no-op-on-duplicate
semantics:

- `POST /v1/auth/redeem` — token is single-use; retrying a
  consumed token returns the same response. Safe.
- `POST /v1/ingest/bulk` — `client_request_id` deduplicates within
  24h. Safe when the caller passes `client_request_id`.
- `POST /v1/documents/{id}/uploads/{u}/finalize` — server is
  idempotent on `(document_id, content_hash)`. Safe.

Other POSTs (`/v1/query`, `/v1/namespaces`, `/v1/provider-keys`,
etc.) are **not retried** — the caller must opt in via
`retry: { retryOnPostMethods: ['POST /v1/query'] }` if they accept
the at-most-once guarantee being relaxed.

### 5.3 Implementation (`packages/sdk/src/retry.ts`)

```ts
export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  retryOn: number[];
  onRetry?: (info: RetryInfo) => void;
  retryOnPostMethods?: string[];
}

export interface RetryInfo {
  attempt: number;             // 1-indexed
  status: number | null;       // null on network error
  delayMs: number;
  error: Error;
}

export const DEFAULT_RETRY: RetryPolicy = { ... };

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  context: { method: string; path: string },
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await fn();
    } catch (err) {
      if (!shouldRetry(err, attempt, policy, context)) throw err;
      const delay = computeDelay(attempt, policy, err);
      policy.onRetry?.({ attempt, status: extractStatus(err), delayMs: delay, error: err });
      await sleep(delay, signal);
    }
  }
}
```

`computeDelay` reads `Retry-After` from the response when present
(via the `TextralApiError` carrying it); otherwise computes
exponential backoff with jitter.

### 5.4 Cancellation through retries

If the caller's `signal` aborts mid-backoff-sleep, `sleep` rejects
immediately and the retry loop bails. No "ghost retry" after
abort.

### 5.5 Tests

- 429 returns `Retry-After: 1`, second attempt succeeds → asserts
  one retry, delay close to 1000ms.
- 503 × 3, then exhaustion → asserts `TextralRetryExhausted`.
- 500 (not in `retryOn`) → asserts no retry, original error.
- Network error (no response) → asserts retry.
- POST `/v1/query` (not in idempotent allowlist) → no retry.
- POST `/v1/ingest/bulk` (in allowlist) → retried.
- `signal.abort()` mid-sleep → asserts `AbortError`, no further
  attempts.

---

## 6. Cancellation

Every public method gains `opts?: { signal?: AbortSignal }` as the
last argument. The signal is threaded into the `fetch` call and
into `withRetry`'s sleep loop.

Method signatures change shape:

```ts
// Before
client.namespaces.list(): Promise<{ data: Namespace[] }>

// After (additive, signal is optional)
client.namespaces.list(opts?: { signal?: AbortSignal }): Promise<{ data: Namespace[] }>
```

For methods that already have a body parameter, the signal goes in
a second positional opts:

```ts
client.namespaces.create(body: NamespaceCreate, opts?: { signal?: AbortSignal })
```

### 6.1 Backward compatibility

Existing call sites that don't pass `opts` continue to work
unchanged. The `opts` object is `?` everywhere.

The `TextralClient` constructor's existing options
(`baseUrl`, `apiKey`, `fetch`) are unchanged. `retry` and
`profile` are additive.

---

## 7. Pagination iterators

### 7.1 Public surface

For every `list()` method that returns `{ data: T[]; next_cursor:
string | null }`, an `iterate()` sibling:

```ts
client.queryEvents.iterate(
  query?: { namespace_slug?: string; status?: string },
  opts?: { signal?: AbortSignal; pageSize?: number },
): AsyncIterable<QueryEvent>;
```

Caller does:

```ts
for await (const ev of client.queryEvents.iterate({
  namespace_slug: 'docs',
})) {
  // ev: QueryEvent
}
```

The iterator pages through `next_cursor` until null, abortable
mid-stream via `signal`. Default `pageSize` is whatever the route's
default is (50–100 per route); caller can override.

### 7.2 Resources getting iterators

- `client.namespaces.listDocuments(slug).iterate(slug, ...)`
- `client.queryEvents.iterate(...)`
- `client.documents.listChunks(id, ...).iterate(...)`
- `client.bulkIngest.iterateFiles(id, ...)`
- `client.bulkIngest.iterate(query, ...)`
- `client.admin.iterateFailingJobs(...)`

Method names are `iterate` for parity with Python's
`__aiter__`.

### 7.3 Implementation (`packages/sdk/src/paginate.ts`)

```ts
export async function* paginate<TItem>(
  fetcher: (cursor: string | null) => Promise<{
    data: TItem[];
    next_cursor: string | null;
  }>,
  signal?: AbortSignal,
): AsyncIterable<TItem> {
  let cursor: string | null = null;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const page = await fetcher(cursor);
    for (const item of page.data) yield item;
    if (!page.next_cursor) return;
    cursor = page.next_cursor;
  }
}
```

Each `iterate` method wraps the raw `list` method:

```ts
queryEvents = {
  list: (q): Promise<QueryEventListResponse> => …,
  iterate: (q, opts) =>
    paginate(
      (cursor) => this.queryEvents.list({ ...q, cursor: cursor ?? undefined }),
      opts?.signal,
    ),
};
```

### 7.4 Tests

Use a mocked fetch that returns 3 pages (each with `next_cursor`)
followed by null. Assert:
- Total items yielded equals sum of all pages' `data` lengths.
- Items are yielded in page order.
- Aborting after page 1 stops iteration mid-stream.
- `pageSize` parameter is forwarded to the underlying list call.

---

## 8. Test coverage expansion

Target: **~80% line coverage** across `packages/sdk/src/`.

### 8.1 Per-resource happy paths

Today `test/client.test.ts` is 96 lines covering the constructor +
`me()` and ~3 other methods. Expand to one happy + one error case
per resource block:

```
namespaces:    list, create, get, update, delete + 1 error
documents:     register, get, list, createUpload, finalize, ingest + 1 error
query:         query (sync), query.stream + 1 error
queryEvents:   list, get, getResponse, iterate + 1 error
providerKeys:  list, create, test, revoke + 1 error
infraKeys:     list, create, test, revoke + 1 error
bulkIngest:    submit, get, files, finalize, retry, cancel, list, iterate + 1 error
models:        list + 1 error
admin:         listFailingJobs, retryFailingJob + 1 error
me:            me + 1 error (401)
```

Each test mocks `globalThis.fetch` via the constructor's `fetch:`
override. Fixtures live in `test/fixtures/`.

### 8.2 Cross-cutting tests (already enumerated)

- `retry.test.ts` — §5.5
- `stream.test.ts` — §4 + interruption case
- `paginate.test.ts` — §7.4
- `profile.test.ts` — §3.4

### 8.3 Coverage

Run `vitest --coverage`. Add a check to CI that fails if line
coverage drops below 80%.

---

## 9. Examples / cookbook

`packages/sdk/examples/` directory. Seven scripts, each runnable
with `tsx examples/0X-name.ts` and `TEXTRAL_API_KEY` set in env.

The full content is in [`SDK_COOKBOOK_OUTLINE.md`](./SDK_COOKBOOK_OUTLINE.md);
this section just covers the file-system + CI integration.

```
packages/sdk/examples/
├── 01-quick-start.ts
├── 02-ingest-and-query.ts
├── 03-bulk-ingest.ts
├── 04-streaming.ts
├── 05-profiles.ts
├── 06-retry-and-cancel.ts
├── 07-paginate-events.ts
├── README.md
├── tsconfig.json                # extends the sdk's, target node22
└── data/                        # sample md/pdf for ingest examples
    ├── alexandria.md
    ├── lighthouse.md
    └── README.md
```

### 9.1 CI integration

`packages/sdk/package.json` script:

```json
"examples-typecheck": "tsc -p examples/tsconfig.json --noEmit"
```

CI runs `pnpm --filter @textral/sdk run examples-typecheck` on every
PR. Catches drift between the SDK's typed surface and the example
code.

One example (the quick-start) is hooked into the existing
`/test/` smoke-suite via `vitest`'s `--testPathPattern`, with a
guard that no-ops when `TEXTRAL_API_KEY` isn't set so unit-test
runs aren't blocked.

---

## 10. README rewrite

`packages/sdk/README.md` grows from 104 → ~400 lines. New sections:

1. **Quick start** (3 lines, with profile)
2. **Configuration** (constructor options)
3. **Profiles** (link to `@textral/profiles` + recipe)
4. **Resources** (one heading per block, brief snippet each)
5. **Streaming** (with the `for await of` pattern)
6. **Retry & backoff** (with the policy override)
7. **Pagination** (the `iterate` pattern)
8. **Cancellation** (`AbortSignal` recipe)
9. **Bulk ingest orchestrator** (link to existing helper)
10. **Errors** (envelope unwrap, retry-exhausted, stream-interrupted)
11. **Cookbook** (link to `examples/`)
12. **Versioning** (lockstep with `@textral/{contracts,profiles,mcp}`)
13. **Compatibility** ("we don't break public APIs within `1.x`" once
    the 1.0 commitment is signed)

---

## 11. Build + publish ritual for `0.2.0`

Lockstep with all four packages. Adapts the existing
`MCP_RELEASE.md` flow:

```bash
# Pre-flight (Node 24, pnpm 10+, npm whoami)
git status                     # working tree clean
nvm use 24

# Build
pnpm install
pnpm --filter @textral/contracts --filter @textral/profiles \
     --filter @textral/sdk --filter @textral/mcp build

# Hard-gate tests
pnpm --filter @textral/contracts --filter @textral/profiles \
     --filter @textral/sdk --filter @textral/mcp test

# Verify tarballs (dry-run pack each)
( cd packages/contracts && pnpm pack --dry-run )
( cd packages/profiles  && pnpm pack --dry-run )
( cd packages/sdk       && pnpm pack --dry-run )
( cd packages/mcp       && pnpm pack --dry-run )

# Publish in dependency order
( cd packages/contracts && pnpm publish --access public --no-git-checks )
( cd packages/profiles  && pnpm publish --access public --no-git-checks )
( cd packages/sdk       && pnpm publish --access public --no-git-checks )
( cd packages/mcp       && pnpm publish --access public --no-git-checks )

# Tag
git tag contracts-v0.2.0 profiles-v0.2.0 sdk-v0.2.0 mcp-v0.2.0
git push --tags
```

`MCP_RELEASE.md` updated to add the `@textral/profiles` step.

### 11.1 Smoke after publish

```bash
# Profile resolution
mkdir -p /tmp/textral-sdk-smoke && cd /tmp/textral-sdk-smoke
cat > smoke.ts <<'EOF'
import { TextralClient } from '@textral/sdk';
const c = new TextralClient({ profile: 'hosted-prod' });
const me = await c.me();
console.log(me.tenant.id);
EOF
npx tsx smoke.ts
```

If `me.tenant.id` prints, the SDK + profiles + the published API
are aligned.

---

## 12. Sequence

```
PHASE 1 (≈ 5 working days)

Day 1:
  - Create packages/profiles/ skeleton + tests + README.
  - Migrate packages/mcp/src/profiles.ts to re-export from new pkg.
  - Verify MCP tests green against the new wiring.
  - Bump @textral/{contracts,mcp} workspace deps; smoke locally.

Day 2:
  - packages/sdk/src/stream.ts + test.
  - client.query.stream() implementation.
  - examples/04-streaming.ts.
  - README streaming section.

Day 3:
  - packages/sdk/src/retry.ts + test.
  - withRetry threading through every client method.
  - examples/06-retry-and-cancel.ts.
  - README retry section.

Day 4:
  - packages/sdk/src/paginate.ts + test.
  - iterate() additions to every list method.
  - AbortSignal threading through every method.
  - examples/07-paginate-events.ts.
  - Per-resource client.test.ts expansion.

Day 5:
  - examples/01–03, 05 (the non-streaming/retry ones).
  - examples/README.md + tsconfig.json.
  - examples-typecheck CI hook.
  - README full rewrite.
  - Lockstep publish 0.2.0.
```

---

## 13. Risk register

| Risk | Mitigation |
|---|---|
| Adding `signal?` to every method ripples breaking changes through `@textral/mcp` and the Sandbox. | All `signal?` parameters are optional and trail existing positional args. Verified by the existing test pass before publish. |
| Retry policy double-charges the customer's provider on a partial-then-retry sequence. | The retry-on allowlist is conservative: only routes with server-side dedupe (`client_request_id`, hash dedupe, single-use tokens). All others must opt in. |
| `withRetry` on `iterate()` could double-fetch a page on 429. | Pagination is naturally idempotent (server-side cursors are positional). Retrying a page is safe. |
| `streamSse` parsing breaks on an SSE flavor we haven't seen. | Reference `apps/api/src/synthesis/streaming.ts` for the exact frame shape we emit; test against the same fixtures. |
| `@textral/profiles` extraction breaks the MCP server. | Phase 1 day 1 is exactly this work + running every existing MCP test. |
| The 0.2.0 lockstep bump leaves a sub-package un-bumped. | The `MCP_RELEASE.md` runbook hard-gate enforces all-four-bumped. |

---

## 14. Done when

- [ ] `@textral/profiles@0.2.0` published; MCP + SDK consume it.
- [ ] `client.query.stream(body)` works end-to-end against prod
      with abort + interrupt cases tested.
- [ ] Default retry policy fires on 429/5xx for all GET/DELETE +
      idempotent POSTs; respects `Retry-After`.
- [ ] Every public method accepts `signal?: AbortSignal`.
- [ ] Every list method has an `iterate()` async iterator.
- [ ] `examples/` has 7 cookbook scripts, all type-check clean.
- [ ] README rewritten with the new sections.
- [ ] Test coverage ≥ 80% line.
- [ ] All existing API + MCP + sandbox tests still pass.
- [ ] `@textral/{contracts,profiles,sdk,mcp}@0.2.0` live on npm in
      lockstep.

---

## 15. Followups for after Phase 1

(Tracked here so they don't slip through the cracks once we move
to Phase 2 / Python.)

- **Method-level retry override.** Adding
  `client.namespaces.create(body, { retry: { ... } })` is a small
  ergonomic win if a customer wants per-call retry policy. Defer
  until asked.
- **Browser SDK (`@textral/sdk-browser`).** Stripped-down build
  that omits `@textral/profiles` (no `node:fs`). Defer until a
  customer asks.
- **Observability hooks.** Today `retry.onRetry` is the only
  callback. A general `client.observe({ onRequest, onResponse,
  onError })` hook would let users wire up their own tracing.
  Defer.
- **Method-surface parity test against Python.** Once the Python
  SDK lands, write a TS-side test that reads the Python SDK's
  introspected surface and asserts equality. Phase 3 work.
