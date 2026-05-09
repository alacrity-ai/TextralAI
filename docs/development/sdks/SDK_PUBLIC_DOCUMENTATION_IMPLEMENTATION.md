# SDK Public Documentation — Implementation Plan

> **Status.** Ready to build. Companion to
> [`SDK_PUBLIC_DOCUMENTATION.md`](./SDK_PUBLIC_DOCUMENTATION.md). Lands the
> hybrid Scalar plan: SDK code samples on every flagship endpoint
> + an "SDKs" tag group with two README-transcluded pages.
>
> **Targets.** No version bumps. The work is additive to
> `apps/api/src/openapi/*` and consumes the existing
> `packages/sdk/README.md` + `packages/sdk-python/README.md` as
> the canonical source of SDK content. No changes to the SDK
> packages themselves.
>
> **Last drafted:** 2026-05-08.

---

## 1. Decisions locked from the design plan

The recommendation in `SDK_PUBLIC_DOCUMENTATION.md` is final;
this doc doesn't relitigate it. The implications below are the
implementation-time consequences:

| # | Decision | Implication |
|---|---|---|
| 1 | Scalar at `/docs` is the single doc surface | All work goes into `apps/api/src/openapi/*` and `apps/api/src/routes/docs.ts`. No new hostname, no second deploy pipeline. |
| 2 | Replace raw-`fetch` / raw-`requests` SDK samples with idiomatic `@textral/sdk` and `textral` calls | Every entry in `apps/api/src/openapi/code-samples.ts` gets rewritten. ~13 entries × 2 langs. |
| 3 | Repo READMEs stay canonical; Scalar transcludes them | New build step: `apps/api/scripts/build-sdk-readmes.ts` reads `packages/sdk/README.md` + `packages/sdk-python/README.md` and emits a generated TS file with the contents inlined. The Worker bundle has no filesystem access at runtime, so transclusion has to happen at build time. |
| 4 | Curl stays as a tab; Try-It clients (`hiddenClients`) untouched | The `[ curl ] [ Node ] [ Python ]` tabs come from `x-codeSamples`. Try-It clients (Scalar's auto-generated snippets in the right pane) are a separate mechanism and stay configured the same way. |
| 5 | Cookbooks link to GitHub source, not embedded | The "Cookbook" section of each SDK page renders a list with GitHub blob links. No copy of the cookbook scripts in `/docs`. |
| 6 | One "SDKs" tag group, two members (`SDK · Node`, `SDK · Python`) | Adds two entries to `TAG_DESCRIPTIONS` and one entry to `TAG_GROUPS` in `apps/api/src/routes/docs.ts`. |

The 4 open questions in `SDK_PUBLIC_DOCUMENTATION.md §11` are
flagged as risks, validated mid-implementation, and folded back
into the doc when answered. They're not blockers.

---

## 2. File-touch summary

| Action | Path | Why |
|---|---|---|
| Add | `apps/api/scripts/build-sdk-readmes.ts` | §3 — codegen step that reads READMEs + emits inlined TS |
| Add | `apps/api/src/openapi/sdk-readmes.gen.ts` | §3 — generated; gitignored; produced by the script above |
| Edit | `apps/api/.gitignore` | add `src/openapi/sdk-readmes.gen.ts` |
| Edit | `apps/api/package.json` | `prebuild` + `predev` hook: `tsx scripts/build-sdk-readmes.ts` |
| Add | `apps/api/src/openapi/sdk-pages.ts` | §4 — assembles SDK tag descriptions from the gen file + adds the cookbook callouts and version footer |
| Edit | `apps/api/src/openapi/code-samples.ts` | §5 — every existing entry: replace `js (TypeScript fetch)` and `python (requests)` with `js (Node @textral/sdk)` and `python (textral)`. Add streaming sample using `client.query.stream(...)`. Add bulk-orchestrator sample. |
| Edit | `apps/api/src/openapi/tag-descriptions.ts` | §6 — add `'SDK · Node'` and `'SDK · Python'` keys, sourced from `sdk-pages.ts` |
| Edit | `apps/api/src/routes/docs.ts` | §6 — add `SDKs` entry to `TAG_GROUPS`. No other changes; `applyCodeSamples()` and tag rendering are already wired. |
| Edit | `apps/api/src/openapi/__tests__/code-samples.test.ts` (or wherever it lives) | §7 — pin operationIds; assert each entry has 3 langs; assert SDK samples present |
| Add | `apps/api/src/openapi/__tests__/sdk-pages.test.ts` | §7 — assert tag descriptions populated, assert version footer auto-injected, assert links to cookbook resolve to real GitHub blob URLs |
| Edit | `docs/SCALAR_DOCS_ENHANCEMENT_PLAN.md` | §8 — flip §10 ("Code samples — flagship flows") and §13.D3 to **Done**; note future work moved to this doc |
| Edit | `apps/api/src/openapi/landing-description.ts` (or `apps/api/src/routes/docs.ts` `info.description`) | §9 — add `npm install @textral/sdk` / `pip install textral` to landing page; mention SDKs above the fold |
| Edit (light) | `apps/api/src/openapi/tag-descriptions.ts` | §9 — append "see also: SDK pages" links to `Query`, `Documents`, `Ingestion`, `Bulk Ingest` tag descriptions |

Net: **2 new source files**, **1 new gen file** (gitignored),
**1 new test file**, **5 light edits** to existing files. No
runtime dependencies added.

---

## 3. Build-time README transclusion

The Worker runtime can't read files from disk. The build step
flattens the READMEs into a single generated TS file that the
spec extension code imports.

### 3.1 Why a codegen step (not a Vite plugin or `?raw` import)

We use this approach for the same reason `packages/sdk-python/codegen/`
emits Pydantic models from JSON Schemas: codegen is portable
across runtimes, easy to reason about, and shows up in `git diff`
when stale (catching drift).

A Vite plugin (`?raw`, `?inline`) would work but couples us to
that bundler; if `apps/api` ever switches build tools the plugin
breaks silently. An esbuild text loader has the same problem.

The codegen step is ~30 lines and works under every bundler.

### 3.2 `apps/api/scripts/build-sdk-readmes.ts`

```ts
// Reads packages/{sdk,sdk-python}/README.md and emits an inlined
// `apps/api/src/openapi/sdk-readmes.gen.ts` for the spec
// extension to consume at render time.
//
// Run by:
//   - `pnpm --filter @textral/api dev`   (predev hook)
//   - `pnpm --filter @textral/api build` (prebuild hook)
//   - CI before the test job

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

const NODE_README = readFileSync(
  resolve(ROOT, 'packages/sdk/README.md'),
  'utf8',
);
const PYTHON_README = readFileSync(
  resolve(ROOT, 'packages/sdk-python/README.md'),
  'utf8',
);

const NODE_VERSION = JSON.parse(
  readFileSync(resolve(ROOT, 'packages/sdk/package.json'), 'utf8'),
).version;
const PYTHON_VERSION = readFileSync(
  resolve(ROOT, 'packages/sdk-python/src/textral/_version.py'),
  'utf8',
).match(/__version__\s*=\s*"([^"]+)"/)?.[1];
if (!PYTHON_VERSION) {
  throw new Error('build-sdk-readmes: failed to parse Python SDK version');
}

const out = `// AUTO-GENERATED by apps/api/scripts/build-sdk-readmes.ts.
// Do not edit by hand. Re-runs on every \`pnpm dev\` / \`pnpm build\`.
//
// Sources:
//   - packages/sdk/README.md
//   - packages/sdk-python/README.md

export const SDK_NODE_README = ${JSON.stringify(NODE_README)};
export const SDK_NODE_VERSION = ${JSON.stringify(NODE_VERSION)};

export const SDK_PYTHON_README = ${JSON.stringify(PYTHON_README)};
export const SDK_PYTHON_VERSION = ${JSON.stringify(PYTHON_VERSION)};
`;

writeFileSync(resolve(HERE, '../src/openapi/sdk-readmes.gen.ts'), out);
console.log(
  `[build-sdk-readmes] wrote sdk-readmes.gen.ts (Node ${NODE_VERSION}, Python ${PYTHON_VERSION})`,
);
```

### 3.3 Wiring into the build

```jsonc
// apps/api/package.json (additive)
{
  "scripts": {
    "predev":   "tsx scripts/build-sdk-readmes.ts",
    "prebuild": "tsx scripts/build-sdk-readmes.ts",
    "test":     "tsx scripts/build-sdk-readmes.ts && vitest"
  }
}
```

The `prebuild` / `predev` / `pretest` hooks ensure the gen file
exists before the bundler / dev server / tests look for it. The
gen file is gitignored to prevent diff churn from author email
changes etc.

CI: the existing CI lane runs `pnpm install --frozen-lockfile`
followed by `pnpm -r test`. The `pretest` hook runs the codegen
in every CI shard that touches `@textral/api`. No explicit CI
edit needed.

### 3.4 Drift check (CI-side)

To catch contract drift (e.g. README updated but spec hasn't
re-rendered), add a CI step that asserts the gen file matches
the freshly-built version:

```yaml
- name: Verify SDK README transclusion is up to date
  run: |
    pnpm --filter @textral/api exec tsx scripts/build-sdk-readmes.ts
    if ! git diff --quiet apps/api/src/openapi/sdk-readmes.gen.ts; then
      echo '::error::sdk-readmes.gen.ts drift detected'
      exit 1
    fi
```

But: the gen file is gitignored. We can't `git diff` it. Option:
ungitignore + commit the gen file (matches Pydantic codegen
pattern). Then the drift check works as written. Pick one
convention; recommend ungitignored + committed for parity with
the Python codegen.

---

## 4. SDK pages composer (`sdk-pages.ts`)

The composer takes the raw README content + version + cookbook
links and produces the final tag-description markdown that
Scalar renders. This is the right layer for any
Scalar-vs-GitHub markdown massaging.

```ts
// apps/api/src/openapi/sdk-pages.ts

import {
  SDK_NODE_README,
  SDK_NODE_VERSION,
  SDK_PYTHON_README,
  SDK_PYTHON_VERSION,
} from './sdk-readmes.gen.js';

const REPO = 'https://github.com/alacrity-ai/TextralAI';

const TRY_IT_BANNER = (operationPath: string) => `
> **Want to skip the prose?** Hit the [\`${operationPath}\`](#tag/query)
> Try-It panel in the API reference. The SDK code samples on every
> operation page show the same call as the snippets below.
`;

const VERSION_FOOTER = (
  pkgName: string,
  version: string,
  installCmd: string,
) => `
---

## Install & version

\`\`\`bash
${installCmd}
\`\`\`

Current version: **${version}**. Released in lockstep with
\`@textral/contracts\`. See the [SDKs design plan](${REPO}/blob/main/docs/development/sdks/SDKS_DESIGN_PLAN.md)
for the version policy.
`;

export function nodeSdkPage(): string {
  return [
    TRY_IT_BANNER('POST /v1/query'),
    SDK_NODE_README,
    VERSION_FOOTER(
      '@textral/sdk',
      SDK_NODE_VERSION,
      'npm install @textral/sdk',
    ),
  ].join('\n');
}

export function pythonSdkPage(): string {
  return [
    TRY_IT_BANNER('POST /v1/query'),
    SDK_PYTHON_README,
    VERSION_FOOTER('textral', SDK_PYTHON_VERSION, 'pip install textral'),
  ].join('\n');
}
```

### 4.1 Markdown massaging — what to scrub or augment

The READMEs target npm / PyPI consumers. A few sections render
oddly in Scalar; the composer is the right place to handle that:

| Issue | Treatment |
|---|---|
| `## License` heading at end of README | Strip — license is on the tag-group level, not per-page |
| Internal-only links (e.g. `https://github.com/.../docs/development/...`) | Keep — they're useful as escape hatches; the dev doc audience overlaps |
| Top-of-README `npm install`/`pip install` block | Move to the `VERSION_FOOTER` (so version is dynamic). Strip the original. |
| Cookbook section | Keep as-is. Already has GitHub blob links. |

A simple regex-based scrubber inside `nodeSdkPage()` /
`pythonSdkPage()` covers the License removal:

```ts
function stripTrailingLicense(md: string): string {
  return md.replace(/\n## License\b[\s\S]*$/m, '');
}
```

The "move install block to footer" is a one-time README edit
(remove the `npm install` snippet from the top of each README;
the version footer becomes the canonical install reference). One
README edit per package, total of 2.

### 4.2 Validation: render check at startup

The render step happens once per Worker boot. If the gen file is
missing or empty, fail loudly:

```ts
// in sdk-pages.ts
if (!SDK_NODE_README || !SDK_NODE_VERSION) {
  throw new Error(
    'sdk-readmes.gen.ts is missing or stale; run `tsx apps/api/scripts/build-sdk-readmes.ts`',
  );
}
```

This converts a silent doc regression into a startup failure
that CI catches.

---

## 5. Code-samples upgrade

The biggest mechanical task. Every existing entry in
`apps/api/src/openapi/code-samples.ts` needs its `js` and
`python` samples rewritten to use the SDKs.

### 5.1 The rewrite contract

For every entry:

```ts
// Before
{ lang: 'js',     label: 'TypeScript (fetch)',  source: '/* fetch */' }
{ lang: 'python', label: 'Python (requests)',   source: '/* requests */' }

// After
{ lang: 'js',     label: 'Node (@textral/sdk)', source: '/* SDK call */' }
{ lang: 'python', label: 'Python (textral)',    source: '/* SDK call */' }
```

The `lang` value is unchanged so Scalar's syntax highlighting
keeps working. The `label` is what the user sees in the tab.
The `source` is what we rewrite.

### 5.2 Sample-writing conventions

Each new sample must:

1. **Use profile mode** — `new TextralClient({ profile: 'hosted-prod' })` /
   `Client(profile="hosted-prod")`. Profile mode is the
   recommended path; explicit credentials are a footnote.
2. **Be standalone-runnable.** Each sample is one paste; don't
   reference state from a previous sample. This means each one
   imports the client, constructs it, and makes one call.
3. **Show types where they matter.** TS: always show the
   destructured response shape (`const { answer, citations } = ...`).
   Python: show the dict-key access (`r["answer"]`) since most
   responses are `dict[str, Any]` by default. Pydantic typed
   access is a separate "Typed responses" section in the SDK
   page; samples don't need to demo it.
4. **Stay short.** 8–15 lines per sample. Anything longer
   belongs in `examples/` and gets linked from the SDK page.
5. **Use `client_request_id` only when teaching idempotency.**
   Adds noise to the canonical samples otherwise.
6. **Use `with` / `async with`** in Python where applicable —
   shows the right cleanup pattern.
7. **Match placeholder convention.** Today's samples use
   `{{TENANT_API_KEY}}` / `{{WORKER_URL}}`. SDK samples replace
   these with profile mode (no placeholders for credentials);
   `{{NAMESPACE}}` etc. for the parts the user provides.

### 5.3 Example: `POST /v1/query` (sync)

Before (current):

```python
import requests
r = requests.post(
    f"{WORKER_URL}/v1/query",
    headers={"X-Textral-Api-Key": API_KEY},
    json={
        "namespace": "my-docs",
        "query": "...",
        "embedding": {...},
        "inference": {...},
    },
)
print(r.json()["answer"])
```

After:

```python
from textral import Client

with Client(profile="hosted-prod") as client:
    r = client.query(
        namespace="my-docs",
        query="What survived the Library of Alexandria?",
        embedding={"provider": "openai", "model": "text-embedding-3-large", "dimensions": 1536},
        inference={"provider": "openai", "model": "gpt-4o-mini"},
    )
    print(r["answer"])
```

TS equivalent:

```ts
import { TextralClient } from '@textral/sdk';

const client = new TextralClient({ profile: 'hosted-prod' });
const { answer, citations } = await client.query({
  namespace: 'my-docs',
  query: 'What survived the Library of Alexandria?',
  embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536 },
  inference:  { provider: 'openai', model: 'gpt-4o-mini' },
});
console.log(answer);
console.log(`citations: ${citations?.length ?? 0}`);
```

### 5.4 Example: `POST /v1/query?stream=sse` (streaming)

Streaming gets its own sample block (`STREAMING_QUERY_SAMPLE` in
the existing file). Both SDKs' streaming surface lives only on
the async client, so the samples are async-only.

```ts
import { TextralClient } from '@textral/sdk';

const client = new TextralClient({ profile: 'hosted-prod' });

for await (const frame of client.query.stream({
  namespace: 'my-docs',
  query: 'Who was Hypatia?',
  embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536 },
  inference:  { provider: 'openai', model: 'gpt-4o-mini' },
})) {
  if (frame.type === 'token') process.stdout.write(frame.value);
}
```

```python
import asyncio
from textral import AsyncClient

async def main():
    async with AsyncClient(profile="hosted-prod") as client:
        async for frame in client.query.stream(
            namespace="my-docs",
            query="Who was Hypatia?",
            embedding={"provider": "openai", "model": "text-embedding-3-large", "dimensions": 1536},
            inference={"provider": "openai", "model": "gpt-4o-mini"},
        ):
            if frame.get("event") == "answer_token":
                print(frame.get("value", ""), end="", flush=True)

asyncio.run(main())
```

### 5.5 Example: `POST /v1/ingest/bulk` (orchestrator)

The bulk submit endpoint has a TS sample today that walks the
manifest dance manually. Replace with the orchestrator helper —
that's the whole point of the helper.

```ts
import { TextralClient, bulkIngestOrchestrate } from '@textral/sdk';
import { readFileSync } from 'node:fs';

const client = new TextralClient({ profile: 'hosted-prod' });

const result = await bulkIngestOrchestrate(client, {
  namespace: 'my-docs',
  config: {
    embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536 },
    chunking: { profile: 'generic', target_tokens: 600, overlap_tokens: 80 },
    mode: 'full',
  },
  files: [
    { filename: 'a.md', bytes: readFileSync('a.md'), size_bytes: 1234, content_type: 'text/markdown' },
  ],
  on_existing: 'skip_if_unchanged',
  auto_finalize: true,
});

console.log(result.bulk_job_id, result.final_status.state);
```

```python
from textral import Client, BulkOrchestrateFile, bulk_ingest_orchestrate
from pathlib import Path

with Client(profile="hosted-prod") as client:
    result = bulk_ingest_orchestrate(
        client,
        namespace="my-docs",
        config={
            "embedding": {"provider": "openai", "model": "text-embedding-3-large", "dimensions": 1536},
            "chunking": {"profile": "generic", "target_tokens": 600, "overlap_tokens": 80},
            "mode": "full",
        },
        files=[
            BulkOrchestrateFile(
                filename="a.md",
                bytes_=Path("a.md").read_bytes(),
                size_bytes=Path("a.md").stat().st_size,
                content_type="text/markdown",
            ),
        ],
        on_existing="skip_if_unchanged",
        auto_finalize=True,
    )

print(result.bulk_job_id, result.final_status["state"])
```

### 5.6 Per-entry checklist

Apply to each of the 13 existing entries. Order matches the file
layout:

- [ ] `GET /v1/me` — auth sanity check (3 lines per language)
- [ ] `POST /v1/provider-keys` — register a provider key
- [ ] `POST /v1/namespaces` — create a namespace
- [ ] `POST /v1/namespaces/:slug/documents` — register a document
- [ ] `POST /v1/documents/:id/uploads` — request an upload slot
- [ ] `POST /v1/documents/:id/uploads/:upload_id/finalize` — finalize an upload
- [ ] `POST /v1/documents/:id/ingest` — kick off ingestion
- [ ] `GET /v1/ingestion-jobs/:id` — poll loop
- [ ] `POST /v1/query` — sync query (5.3)
- [ ] streaming append on `/v1/query` — `STREAMING_QUERY_SAMPLE` (5.4)
- [ ] `POST /v1/namespaces/:slug/eval-sets` — register eval set
- [ ] `POST /v1/namespaces/:slug/eval-sets/:id/runs` — run eval
- [ ] `POST /v1/ingestion-jobs/:id/retry` — retry a DLQ'd job
- [ ] `GET /v1/admin/ingestion-jobs?dead_lettered=1` — list DLQ
- [ ] **NEW** `POST /v1/ingest/bulk` — bulk orchestrator (5.5)

The cookbook variants (`COOKBOOK_STRUCTURED_SIMPLE`,
`COOKBOOK_DOC_SUBSET`, etc.) on `/v1/query` get the same TS-fetch
→ Node-SDK conversion. They're variants of the same call shape.

### 5.7 Refactoring the file structure

Today the file is 1384 lines; after this work it'll be ~2200.
That's manageable but worth one structural change:

- Extract per-language helpers — `nodeSdkSample(spec)` and
  `pythonSdkSample(spec)` builders that take the API call shape
  and produce a `CodeSample` object. Saves boilerplate in each
  entry (most of the imports + client construction is identical
  across calls).

```ts
function nodeSdk(callBody: string): CodeSample {
  return {
    lang: 'js',
    label: 'Node (@textral/sdk)',
    source: `import { TextralClient } from '@textral/sdk';

const client = new TextralClient({ profile: 'hosted-prod' });
${callBody}`,
  };
}

function pythonSdk(callBody: string): CodeSample {
  return {
    lang: 'python',
    label: 'Python (textral)',
    source: `from textral import Client

with Client(profile="hosted-prod") as client:
${callBody}`,
  };
}
```

Then each entry becomes:

```ts
const ME: SampleEntry = {
  key: { method: 'get', path: '/v1/me' },
  samples: [
    curl('curl', '${URL}/v1/me'),
    nodeSdk('const me = await client.me();\nconsole.log(me.tenant_id);'),
    pythonSdk('    me = client.me()\n    print(me["tenant_id"])'),
  ],
};
```

This isn't a refactor required to ship — but the file gets
much more reviewable, and onboarding new endpoints later is
cheaper.

---

## 6. SDK tag group

### 6.1 `tag-descriptions.ts` additions

Append two entries to the `TAG_DESCRIPTIONS` map:

```ts
import { nodeSdkPage, pythonSdkPage } from './sdk-pages.js';

export const TAG_DESCRIPTIONS: Record<string, string> = {
  // ... existing entries ...
  'SDK · Node':   nodeSdkPage(),
  'SDK · Python': pythonSdkPage(),
};
```

The function calls evaluate at module-load time so the README
content is read once per Worker boot. That's fine — boot
happens infrequently and the extra ~30 KB of strings is in the
noise.

### 6.2 `docs.ts` tag-group + display-name

```ts
const TAG_GROUPS = [
  { name: 'Get started',    tags: ['Meta', 'Auth'] },
  { name: 'Core integration', tags: [/* ... */] },
  { name: 'Operations',     tags: ['Admin'] },
  { name: 'Tenancy & keys', tags: ['Tenancy', 'API Keys'] },
  { name: 'Agent integration', tags: ['MCP'] },
  { name: 'SDKs',           tags: ['SDK · Node', 'SDK · Python'] }, // new
];
```

Add display-name entries to the `displayName` switch in
`docs.ts` so the sidebar reads "Node SDK" / "Python SDK" instead
of the prefixed forms:

```ts
case 'SDK · Node':   return 'Node SDK';
case 'SDK · Python': return 'Python SDK';
```

The `'SDK · '` prefix in the tag name keeps the keys
namespace-distinct from any future `Node` or `Python` operation
tag (unlikely, but cheap insurance).

### 6.3 What about operations under these tags?

The `SDK · Node` and `SDK · Python` tags don't have any
operations attached — they're prose-only. Scalar handles this
gracefully: a tag with a description but no operations renders
as a top-level page in the sidebar with the description as its
body. Validated this against Scalar's behavior on `/docs` with
the existing `Meta` tag (which is light on operations).

If Scalar surprises us here (e.g., refuses to render the tag
without ops), the fallback is to attach a placeholder op like
`GET /v1/sdk-info` that returns `{ language: 'node' }` and tag
it `SDK · Node`. Don't pre-build that escape hatch; only reach
for it if the Phase 2 visual check shows the tag missing.

---

## 7. Tests

### 7.1 Code-samples regression

Existing `code-samples.test.ts` (or wherever `FLAGSHIP_OPERATION_KEYS`
is consumed) extends with:

```ts
it('every flagship op has 3 SDK code samples', () => {
  for (const entry of ALL_SAMPLES) {
    const langs = entry.samples.map((s) => s.lang).sort();
    expect(langs).toEqual(['js', 'python', 'shell']);
    expect(entry.samples.find((s) => s.lang === 'js')?.label).toBe('Node (@textral/sdk)');
    expect(entry.samples.find((s) => s.lang === 'python')?.label).toBe('Python (textral)');
  }
});

it('SDK samples import the SDK packages', () => {
  for (const entry of ALL_SAMPLES) {
    const node = entry.samples.find((s) => s.lang === 'js')?.source ?? '';
    const python = entry.samples.find((s) => s.lang === 'python')?.source ?? '';
    expect(node).toContain('@textral/sdk');
    expect(python).toContain('from textral');
  }
});
```

These two tests catch an entire class of regressions at once
(someone adding a new flagship endpoint without an SDK sample,
someone reverting a sample to raw fetch, etc.).

### 7.2 SDK pages

```ts
// apps/api/src/openapi/__tests__/sdk-pages.test.ts

import { nodeSdkPage, pythonSdkPage } from '../sdk-pages.js';

describe('SDK pages', () => {
  it('Node page contains the README content', () => {
    const md = nodeSdkPage();
    expect(md).toContain('# @textral/sdk');
    expect(md).toContain('## Quick start');
    expect(md).toContain('## Streaming');
    expect(md).toContain('## Retry & backoff');
  });

  it('Node page has the version footer', () => {
    const md = nodeSdkPage();
    expect(md).toMatch(/Current version: \*\*\d+\.\d+\.\d+\*\*/);
    expect(md).toContain('npm install @textral/sdk');
  });

  it('Python page contains the README content', () => {
    const md = pythonSdkPage();
    expect(md).toContain('# textral');
    expect(md).toContain('Pydantic');
    expect(md).toContain('async with AsyncClient');
  });

  it('Python page has the version footer', () => {
    const md = pythonSdkPage();
    expect(md).toMatch(/Current version: \*\*\d+\.\d+\.\d+\*\*/);
    expect(md).toContain('pip install textral');
  });

  it('License section is stripped from both', () => {
    expect(nodeSdkPage()).not.toMatch(/^## License\b/m);
    expect(pythonSdkPage()).not.toMatch(/^## License\b/m);
  });
});
```

### 7.3 End-to-end spec assertion

The existing `docs.test.ts` (or equivalent) renders the full
spec and inspects it. Extend with:

```ts
it('spec includes SDK tag descriptions', async () => {
  const spec = await renderOpenApiSpec();
  const tags = spec.tags ?? [];
  expect(tags.find((t: any) => t.name === 'SDK · Node')?.description).toBeTruthy();
  expect(tags.find((t: any) => t.name === 'SDK · Python')?.description).toBeTruthy();
});

it('spec has SDKs tag group', async () => {
  const spec = await renderOpenApiSpec();
  const groups = spec['x-tagGroups'] as Array<{ name: string; tags: string[] }>;
  const sdkGroup = groups.find((g) => g.name === 'SDKs');
  expect(sdkGroup).toBeTruthy();
  expect(sdkGroup?.tags).toEqual(['SDK · Node', 'SDK · Python']);
});
```

---

## 8. Discovery & polish (Phase 4 from the design)

### 8.1 Landing-page mention

Edit the OpenAPI `info.description` (or `landing-description.ts`
if extracted) to put SDK install commands above the canonical
flow:

```diff
 # Textral

 RAG infrastructure for AI agents …

+## Install

+```bash
+npm install @textral/sdk     # Node / TypeScript
+pip install textral           # Python
+```
+
+Both SDKs are typed, share the same wire contract, and resolve
+credentials from `~/.textral/profiles.toml`. See [Node SDK](#tag/sdk-node)
+/ [Python SDK](#tag/sdk-python).
+
 ## Canonical flow
 ...
```

### 8.2 "See also" footers on tag descriptions

For the four tags that have meaningful SDK abstractions, append
a "see also" line at the end of their descriptions:

| Tag | Footer |
|---|---|
| `Query` | `See also: \`client.query\` and \`client.query.stream\` in the [Node SDK](#tag/sdk-node) / [Python SDK](#tag/sdk-python).` |
| `Documents` | `See also: \`client.documents.*\` and \`client.documents.iterateChunks(...)\`.` |
| `Ingestion` | `See also: \`client.documents.ingest(...)\` and \`client.ingestionJobs.get(...)\` poll loops.` |
| `Bulk Ingest` | `See also: \`bulkIngestOrchestrate(...)\` (one helper drives the manifest → upload → finalize → poll dance).` |

These are 1-liners; total addition is ~4 lines across
`tag-descriptions.ts`.

---

## 9. Phasing

Each phase ships value independently. Don't conflate.

### Phase 1 — Build pipeline + SDK pages (4–6h)

The order matters: pages first, then samples. The SDK page
makes the tab labels meaningful — without the SDKs being
discoverable in the sidebar, users see "Node (@textral/sdk)" in
a tab and have nowhere to find the SDK documented.

- [ ] §3 — `build-sdk-readmes.ts` script
- [ ] §3 — wire `prebuild`/`predev`/`pretest` hooks
- [ ] §3 — gen file ungitignored + committed (parity with
       Pydantic codegen)
- [ ] §4 — `sdk-pages.ts` composer with the version footer
- [ ] §4 — README `## License` strip + `npm install`/`pip install`
       block move
- [ ] §6 — `TAG_DESCRIPTIONS` entries + `TAG_GROUPS` group +
       display-name overrides
- [ ] §7.2, §7.3 — tests
- [ ] **Visual check** — boot the dev server, navigate to /docs,
       confirm SDKs tag group renders + each page shows the
       README content + version footer is correct

### Phase 2 — Code samples (4–6h)

- [ ] §5.7 — extract `nodeSdk()` / `pythonSdk()` helpers
- [ ] §5.6 — rewrite each of the 14 entries (the 13 existing +
       the new bulk-orchestrator one)
- [ ] §5.4 — streaming sample
- [ ] §5.5 — bulk orchestrator sample
- [ ] §7.1 — code-samples regression tests
- [ ] **Visual check** — open a flagship endpoint in /docs,
       confirm `[ curl ] [ Node ] [ Python ]` tabs render with
       correct labels and syntax highlighting

### Phase 3 — Discovery (2h)

- [ ] §8.1 — landing-page install block
- [ ] §8.2 — `see also: SDK pages` footers on Query / Documents /
       Ingestion / Bulk Ingest
- [ ] Update `SCALAR_DOCS_ENHANCEMENT_PLAN.md` §10 + §13.D3 to
       **Done** with a pointer to this implementation doc

### Phase 4 — Validate & deploy (1h)

- [ ] Confirm Scalar-side markdown rendering matches GitHub's
       on the README content (the open question from the design
       doc §11.1)
- [ ] Confirm deep links to operations from inside the SDK pages
       work (`#tag/query` → operations of the Query tag)
- [ ] Deploy to dev; smoke-test the full /docs experience as a
       fresh user
- [ ] Deploy to prod

### Phase 5 — Optional, post-launch

Out of scope for this implementation, tracked in the design doc §11:

- Per-language search filtering
- Inline type signatures on operation reference
- Migration guide pages (1.0 release)

---

## 10. Validation matrix

Before marking the work done, confirm each:

| Gate | How |
|---|---|
| Codegen runs in CI | `tsx scripts/build-sdk-readmes.ts` is in the prebuild/pretest hook; gen file is committed and matches a fresh build |
| All flagship ops have 3 lang tabs | §7.1 regression test |
| SDK tab labels are correct | §7.1 regression test |
| SDK pages render in Scalar sidebar | Visual check in dev |
| SDK page version is current | §7.2 unit test (regex match) |
| README → Scalar transclusion preserves headings | Visual check + §7.2 contains-string assertions |
| License section stripped | §7.2 unit test |
| Tag group "SDKs" appears in sidebar | §7.3 spec assertion + visual |
| Streaming sample uses async client | §7.1 + visual |
| Bulk orchestrator sample uses the helper | §7.1 + visual |
| Drift check works | Manually edit a README, run CI, expect failure |
| Existing curl samples unchanged | Diff-only on the existing entries; no curl tab regressions |

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Scalar's markdown parser chokes on a README construct (e.g. nested code fences in tables) | Phase 1 visual check is the gate. If a section renders badly, fix the README; the README is canonical and any GitHub-only construct is technical debt. |
| README drift between repo and `/docs` between deploys | Codegen + drift CI step. Worst case: README ships ahead of `/docs` until next deploy. Acceptable. |
| `info.description` becomes too long with the SDK install block | Limit the install block to ~5 lines; keep canonical-flow content above the fold. Existing description is ~400–600 words by design plan. |
| Scalar tag without operations doesn't render | §6.3 — fallback is a placeholder op tagged `SDK · Node`. Don't pre-build; reach for it only if needed. |
| Code-samples file balloons past 2000 lines and review pain compounds | §5.7 — extract `nodeSdk()` / `pythonSdk()` helpers to make each entry one-line-per-language. |
| New operations land without SDK samples and break the regression test | The §7.1 regression test catches this in CI. The fix is to add samples — that's the desired behavior, not an obstacle. |
| Worker bundle size regresses materially from inlined READMEs | Two READMEs ≈ 30–40 KB total post-gzip. Negligible against the existing ~1 MB Worker bundle. Confirmed during Phase 1 build check. |

---

## 12. TL;DR

Three new files (build script, gen file, composer module). One
existing file gets ~13 entries rewritten. Two tag entries +
one tag group added. ~12 hours of work, four phases, four
visible deliverables: SDK pages in the Scalar sidebar, idiomatic
SDK tabs on every flagship endpoint, install commands on the
landing page, "see also" links between tag descriptions and SDK
pages.

Implementation is ready to start when you are.
