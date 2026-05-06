# Textral Sandbox Frontend — Design

> **Audience:** developer building the sandbox. **Status:** design draft;
> nothing implemented yet. Companion to
> `docs/v3/PHASE-2_DETAILED_DESIGN.md` (the self-host runtime that
> makes this sandbox useful) and
> `docs/SELF_HOSTING.md` (the operator runbook for the stack the
> sandbox will talk to).

## 1. Goal

Build a small, **opinionated React app** that lets an operator iterate
on **retrieval quality** against a running Textral deploy. Not a
product, not a customer-facing UI — a developer tool whose job is to
make every audit field, retrieval candidate, citation decision, and
provider call **directly visible and trivially comparable**.

The use case the sandbox is optimised for, end-to-end:

> "I want to know whether `top_k_dense=8 + reranker=voyage-3` produces
> better citations on the `narrative` profile than the current default,
> against the same seven test queries, on the same corpus."

Everything below derives from that. If something doesn't help that
operator, it doesn't go in.

## 2. Why now

V3 Phase 2 finished today: the Hono app runs on a fully self-hostable
Postgres + Redis + MinIO + Qdrant stack with parity-tested routes.
The cookbook validator passes 8/8 against it. That stack is the
**right substrate to iterate retrieval on** — fast local feedback
loops, no Cloudflare deploy round-trips, real provider calls
(operator's own keys), bit-exact API contract with the managed
deploy. A web sandbox in front of it is the next force multiplier.

## 3. Audit of the existing frontend

The previous Textral codebase shipped a substantial React app at
`apps/frontend/` (relative to the V2 repo root, outside this WIP
refactor). We will **mine it for chrome and reusable components**, not
adopt its concept model.

### 3.1 What's there

```
apps/frontend/
├── src/
│   ├── App.tsx                      router skeleton
│   ├── main.tsx                     vite entry
│   ├── api-client/client.ts         REST client (V2 surface)
│   ├── context/
│   │   ├── AuthContext.tsx          email/password + JWT-like Bearer token
│   │   ├── ToastContext.tsx         toast notifications
│   │   └── ConfirmContext.tsx       confirm dialogs
│   ├── hooks/
│   │   ├── useHotkeys.ts            global keyboard shortcuts
│   │   ├── useResizablePanes.ts     split-pane state
│   │   ├── useBreakpoint.ts         responsive breakpoints
│   │   ├── useWriterSync.ts         writer-mode autosave
│   │   └── useLayoutMode.ts         writer-mode layout
│   ├── styles/tokens.ts             design tokens (spacing, color, radii)
│   ├── components/
│   │   ├── CommandPalette.tsx       ⌘K navigation
│   │   ├── HelpOverlay.tsx          keyboard cheatsheet
│   │   ├── layout/{AppShell,Navbar,ResizablePane}.tsx
│   │   ├── ui/{Button,Card,Badge,EmptyState,Input,Markdown,
│   │   │       SearchInput,Skeleton,Spinner,InlineEditable}.tsx
│   │   ├── conversation/
│   │   │   ├── AnswerAuditDrawer.tsx     ★ retrieval audit viewer
│   │   │   ├── ChatMessage.tsx
│   │   │   ├── QueryInput.tsx
│   │   │   └── LayoutModeSwitcher.tsx
│   │   ├── source/SourcePanel.tsx        ★ chunk viewer
│   │   ├── library/{AddToCollectionMenu,LibrarySidebar,NewDocumentModal}.tsx
│   │   ├── book/{CharactersTab,EnrichmentStrip,ThemesTab}.tsx
│   │   └── writer/{Editor,Palette,AIContextMenu,AIEditPreview,
│   │                SyncIndicator,WriterConversationPanel,contextualMarkdown}.ts(x)
│   └── pages/
│       ├── LoginPage.tsx, RegisterPage.tsx
│       ├── LibraryPage.tsx, BookDetailPage.tsx, UploadPage.tsx
│       ├── ReaderPage.tsx, WriterPage.tsx, WritersModePage.tsx
│       ├── ConversationPage.tsx
│       └── Admin/{AdminLayout,SystemPage,IngestionJobsPage,
│                   QueriesPage,ModelsPage,UsagePage}.tsx
```

Stack: React 19, Vite 6, react-router-dom 7, TypeScript 5.8, CodeMirror 6,
react-markdown + remark-gfm. Identical major versions to what we
should adopt — no upgrade work needed.

### 3.2 Lift-and-shift inventory

These transfer near-verbatim. They're concept-neutral chrome.

| Path | Why it lifts cleanly |
|---|---|
| `components/layout/AppShell.tsx` | Generic top-bar + content frame |
| `components/layout/Navbar.tsx` | Generic, swap link targets |
| `components/layout/ResizablePane.tsx` | Pure split-pane primitive |
| `components/CommandPalette.tsx` | ⌘K nav — re-target the registry |
| `components/HelpOverlay.tsx` | Keyboard cheatsheet — re-author entries |
| `components/ui/*` (10 files) | Button, Card, Badge, EmptyState, Input, Markdown, SearchInput, Skeleton, Spinner, InlineEditable — all primitive, all keep |
| `components/conversation/AnswerAuditDrawer.tsx` | **Highest-value lift.** Already renders `audit.tokens.*`, `audit.degradation_level`, `audit.reranker.executed`, `audit.candidates_returned`. Drop-in for our retrieval-debug story. |
| `components/source/SourcePanel.tsx` | Chunk viewer (text + metadata). Lifted as-is for inspecting retrieved chunks. |
| `context/ToastContext.tsx` | Generic toast — keep |
| `context/ConfirmContext.tsx` | Generic confirm dialog — keep |
| `hooks/useHotkeys.ts` | Generic — keep |
| `hooks/useResizablePanes.ts` | Generic — keep |
| `hooks/useBreakpoint.ts` | Generic — keep |
| `styles/tokens.ts` | Design tokens — keep, may rename narrative-y values |

### 3.3 Discard (narrative-coupled or out of scope)

These pages and components encode V2's "novel-writing app" product
shape. The sandbox's concept model is "namespace → document → query
→ audit," not "library → book → conversation."

| Path | Why drop |
|---|---|
| `pages/LibraryPage.tsx`, `BookDetailPage.tsx` | "Library/book" metaphor; sandbox uses `namespace → document` |
| `pages/ReaderPage.tsx` | Read-the-document UX is product-y; we want chunk inspection, not reading |
| `pages/WriterPage.tsx`, `WritersModePage.tsx` | Writer mode (continue/reword/tighten/expand) hits V2-only `/write/*` endpoints not in V3 |
| `pages/ConversationPage.tsx` | Conversation-thread state is V2-only; V3 has stateless `/v1/query` |
| `components/writer/*` (7 files) | Same — Writer-mode-only |
| `components/library/*` (3 files) | Collections/sidebar — narrative-app metaphor |
| `components/book/{CharactersTab,EnrichmentStrip,ThemesTab}.tsx` | Narrative-profile-specific UI (V3 still has those enrichments, but the sandbox should surface them generically as enrichment metadata, not as character/theme tabs) |
| `components/conversation/{ChatMessage,QueryInput,LayoutModeSwitcher}.tsx` | Conversation-thread UI; sandbox is one-shot query → audit |
| `hooks/{useWriterSync,useLayoutMode}.ts` | Writer-mode-only |
| `pages/{LoginPage,RegisterPage}.tsx` | V3 has no email/password; auth is API-key paste |
| `context/AuthContext.tsx` | Same — auth model differs |
| `pages/Admin/*` | V3 admin endpoints are a different shape; rebuild thin |

### 3.4 The shape this leaves

After mining the lift list above, what we get for free:

- A polished AppShell with command palette, help overlay, and toasts
- Working hotkeys, resizable splits, responsive breakpoints
- A solid `ui/*` primitive set (10 components, ~600 LoC total)
- **`AnswerAuditDrawer`** — the most important component for our use
  case, already written, already rendering V3-shaped audit fields
- **`SourcePanel`** — chunk inspector

Everything else is a fresh write against the V3 API. That's the
right ratio: keep the stuff that took three months to polish, throw
out the stuff that encoded the wrong product.

## 4. V3 backend surface — what the sandbox calls

The OpenAPI spec at `/openapi.json` is the source of truth; this
section is a curated subset by feature area, with notes on what
each route gives the sandbox.

### 4.1 Auth

- `GET /v1/me` — sanity check + tenant info display

Auth header on every request:
```
X-Textral-Api-Key: tx_live_...
```

The key is pasted by the operator on first load, stored in
`localStorage`, and sent verbatim with every request. No login flow.

### 4.2 Namespaces (the "scope picker" of the whole UI)

- `GET /v1/namespaces` — list, populates the picker
- `POST /v1/namespaces` — create, with backend + profile + embedding choice
- `GET /v1/namespaces/{slug}` — detail (corpus profile, vector backend, default embedding)
- `DELETE /v1/namespaces/{slug}` — soft-delete

A namespace is the unit of "compare retrieval quality." The sandbox
header carries the active namespace; every query goes to it; switching
namespace changes everything below.

### 4.3 Documents + ingestion

- `POST /v1/namespaces/{slug}/documents` — register
- `POST /v1/documents/{id}/uploads` → PUT bytes → `POST .../finalize`
- `POST /v1/documents/{id}/ingest` — kick off the pipeline (mode, chunking, embedding)
- `GET /v1/ingestion-jobs/{id}` — poll for status
- `GET /v1/documents/{id}` — metadata
- `GET /v1/documents/{id}/source` — original bytes (download link)

Sandbox surface: an **Ingest panel** for "drop a markdown file → pick
profile → watch it stream through fetch/normalize/chunk/embed/index."
Tight enough that an operator can re-ingest with a tweaked profile
in <30s.

### 4.4 Provider keys (BYOK)

- `GET /v1/provider-keys` — list (metadata only; raw keys never returned)
- `POST /v1/provider-keys` — register (per-provider, per-label)
- `DELETE /v1/provider-keys/{id}` — soft-delete (Migration 0007 made
  this safe to revoke + re-register under the same label)
- `POST /v1/provider-keys/{id}/test` — round-trip a probe call

Sandbox surface: a **Provider Keys page** for first-run setup. No
fancy validation UI — just a list, an add form, and a delete button.

### 4.5 Query (the core surface)

- `POST /v1/query` — sync; returns answer + citations + audit
- `POST /v1/query?stream=sse` — same, streamed
- `GET /v1/query-events` — list past queries
- `GET /v1/query-events/{id}` — full audit

This is the **QueryBench** — the page operators will spend 90% of
their time on. Every input that affects retrieval lives in one form;
every output is rendered alongside, with the full audit inspectable
via the lifted `AnswerAuditDrawer`.

### 4.6 Admin (lightweight)

- `GET /v1/admin/ingestion-jobs?status=...` — DLQ + recent jobs
- `POST /v1/admin/ingestion-jobs/{id}/retry`
- `GET /v1/admin/namespaces/{slug}/enrichment-runs` — re-run enrichment
- `POST /v1/admin/namespaces/{slug}/enrichment-runs` — same

Sandbox surface: a thin **Admin** drawer or page with two tabs (Jobs,
Enrichment). Not a full ops console — just enough to unstick a
broken ingest while iterating.

### 4.7 What the sandbox does NOT call

- `/internal/*` — Container ↔ api back-channel. HMAC-authed, never UI-facing.
- `/v1/eval/*` — eval contract has its own CLI (`packages/eval-cli`).
  Fine to defer to v2 of the sandbox if there's demand.

## 5. Sandbox feature scope

### 5.1 Must (M1 — first usable build)

| Feature | Why |
|---|---|
| API-key paste + persisted auth | Without this the app is a brick |
| Namespace picker (top of every page) | The "scope" of every other action |
| Ingest panel: drop file → pick profile → watch stream | Fast iteration on profile + chunking |
| QueryBench: form + answer + citations + AuditDrawer | The core feedback loop |
| QueryHistoryPage: last N runs with audit drill-down | "How did that change affect the last 50 queries?" |

That's the MVP. If those five surfaces work, the sandbox earns its
keep.

### 5.2 Should (M2)

| Feature | Why |
|---|---|
| **Compare view**: run the same query against two namespaces / two retrieval configs side-by-side | The "is this change better?" question |
| Provider Keys page (list + register + delete + test) | First-run setup + key rotation; today operators have to curl |
| Document inspector: per-document chunk list + per-chunk text + embedding metadata | Debugging "why did this chunk not surface?" |
| Streaming SSE in QueryBench (toggle) | Latency UX + token-by-token feel |

### 5.3 Won't (explicit non-goals)

- Reader / Writer / annotation surfaces — that's a product, not a sandbox
- Conversation threads / chat history persistence — V3 is stateless on purpose
- Multi-user auth / RBAC UI — single API key, single tenant
- Mobile-first responsive — desktop-only; an operator at a workstation
- i18n — English-only
- A "publish to production" button — it's a sandbox; nothing it does is meant to be irreversible at scale

If a feature hits one of those, push back and document why.

## 6. Stack + monorepo layout

### 6.1 Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node 24 | Matches the rest of the workspace; aligns with our `feedback_node_version` rule |
| Bundler | Vite 6 | Same as the old FE; React 19 + TS 5 work fine |
| Framework | React 19 | Latest; same as old FE |
| Router | react-router-dom 7 | Same as old FE — no learning curve |
| Styling | CSS modules + design tokens (lifted) | No styled-components, no Tailwind — keep it close to the metal so token tweaks don't fight a system |
| Forms | Native + small zod-validated wrappers | No formik / react-hook-form; the sandbox's forms are simple |
| Markdown | react-markdown + remark-gfm (lifted) | Same as old FE |
| HTTP | Native `fetch` | The old FE's `request<T>` helper is ~30 lines; we'll write a slimmer V3 version inline |
| State | React contexts + hooks | No Redux / Zustand / Jotai — page-scoped state is fine for a sandbox |
| Types | OpenAPI-generated client (post-M1, optional) | Hand-typed for M1; consider `openapi-typescript` later |

### 6.2 Project layout

```
apps/sandbox/                                NEW — sibling of apps/api/, apps/ingest/
├── package.json                             "@textral/sandbox"
├── vite.config.ts                           dev proxy → http://localhost:8787
├── index.html
├── tsconfig.json                            extends ../../tsconfig.base.json
├── Dockerfile                               (M3 — for "selfhost-up" co-launch)
├── public/                                  static assets, favicon
└── src/
    ├── main.tsx                             vite entry
    ├── App.tsx                              router skeleton
    ├── api/                                 V3 client + types
    │   ├── client.ts                        fetch wrapper + ApiKey context glue
    │   ├── types.ts                         hand-typed for M1 (or generated post-M2)
    │   └── sse.ts                           streaming-query reader
    ├── auth/                                API-key paste + localStorage
    │   ├── ApiKeyContext.tsx
    │   └── ApiKeyGate.tsx                   modal that blocks UI until a key is set
    ├── pages/
    │   ├── QueryBench.tsx                   M1 — the main page
    │   ├── QueryHistory.tsx                 M1
    │   ├── Ingest.tsx                       M1
    │   ├── ProviderKeys.tsx                 M2
    │   ├── NamespaceList.tsx                M2 (small CRUD)
    │   ├── DocumentInspector.tsx            M2
    │   ├── Compare.tsx                      M2 (side-by-side)
    │   └── Admin.tsx                        M2 (jobs + enrichment)
    ├── components/                          MIXED: lifted + new
    │   ├── (lifted) layout/{AppShell,Navbar,ResizablePane}.tsx
    │   ├── (lifted) ui/{Button,Card,…}.tsx
    │   ├── (lifted) {CommandPalette,HelpOverlay}.tsx
    │   ├── (lifted) source/SourcePanel.tsx
    │   ├── (lifted) AnswerAuditDrawer.tsx
    │   ├── (new) NamespacePicker.tsx        scope dropdown in header
    │   ├── (new) QueryForm.tsx              the input form for /v1/query
    │   ├── (new) AnswerCard.tsx             rendered answer + citations
    │   ├── (new) AuditTimeline.tsx          per-stage timing strip
    │   ├── (new) IngestStreamLog.tsx        ingestion poll → live log
    │   └── (new) RetrievalCandidates.tsx    table of dense + sparse hits w/ scores
    ├── hooks/                               LIFTED
    │   ├── (lifted) useHotkeys.ts
    │   ├── (lifted) useResizablePanes.ts
    │   └── (lifted) useBreakpoint.ts
    ├── context/                             MIXED
    │   ├── (lifted) ToastContext.tsx
    │   ├── (lifted) ConfirmContext.tsx
    │   └── (new) NamespaceContext.tsx       which namespace is active
    └── styles/
        └── (lifted) tokens.ts
```

### 6.3 Vite dev config

```ts
// apps/sandbox/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1':       { target: 'http://localhost:8787', changeOrigin: true },
      '/healthz':  { target: 'http://localhost:8787', changeOrigin: true },
      '/openapi.json': { target: 'http://localhost:8787', changeOrigin: true },
      '/docs':     { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
```

The proxy forwards `/v1/*` to the local self-host stack (or
`wrangler dev` for the CF runtime); the sandbox app code calls
`/v1/...` directly with no `API_BASE` prefix, sidestepping CORS.

For production self-host, the Dockerfile (M3) builds a static bundle
and serves it via the same domain as the api (or behind the
operator's reverse proxy on a different path). No CORS in either deploy.

## 7. Auth model

### 7.1 First-run flow

1. App loads. `ApiKeyGate` mounts, finds no key in localStorage, shows
   a centered modal with one input: "Paste your `tx_live_...` key."
2. Operator pastes; we POST nothing — we just stash it and call
   `GET /v1/me` to validate. On 200, store it; on 401, show "key
   invalid."
3. Once valid, the modal dismisses and the app proceeds.
4. Every subsequent request adds `X-Textral-Api-Key: <stored>`.

### 7.2 Key rotation / clear

Header menu has "Forget key" → clears localStorage + remounts the
gate.

### 7.3 Why not OAuth / SSO

This is a developer sandbox. The key is the operator's, on the
operator's machine, against the operator's local Postgres. SSO is a
product concern.

### 7.4 Security posture

- `localStorage` is fine for a single-user dev tool. Don't ship this
  shape to a multi-user/managed product without revisiting.
- Provider keys (OpenAI, Anthropic) **never reach the FE** — they go
  via `/v1/provider-keys` and live server-side in the secrets store.
  The FE never displays a raw provider key.
- The Textral API key is technically powerful — `*` scope keys
  can do everything in the tenant. The sandbox treats it the same way
  the operator's curl shell does.

## 8. Pages — sketches

### 8.1 QueryBench (M1, the centerpiece)

```
┌─ AppShell ──────────────────────────────────────────────────────────────┐
│  Textral Sandbox  │  [namespace: cookbook-qdrant ▼]  │  ⌘K  │  ?  │  ⎋ │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌─ Query input ────────────────────────────┐ ┌─ Latest run ─────────┐  │
│   │ Question:  ▢ multi-line                  │ │ Answer:              │  │
│   │ Embedding: openai · text-embedding-3-l   │ │  …                   │  │
│   │ Inference: openai · gpt-4o-mini          │ │ Citations: [1] [2]   │  │
│   │ Retrieval:                               │ │                      │  │
│   │   ◉ hybrid_rrf   ○ dense_only            │ │ ▸ Open AuditDrawer   │  │
│   │   top_k_dense  [5]   top_k_sparse [5]    │ │                      │  │
│   │   ☐ rerank.enabled                       │ │ Latency: 1.8s        │  │
│   │ Output:                                  │ │ Tokens in/out: 980 / │  │
│   │   ◉ text   ○ structured (schema…)        │ │   210                │  │
│   │ Stream: ☐                                │ │ Degradation: full    │  │
│   │ ▸ Run                                    │ │                      │  │
│   └──────────────────────────────────────────┘ └──────────────────────┘  │
│                                                                          │
│   ┌─ Retrieval candidates (dense + sparse, RRF-fused) ─────────────────┐ │
│   │ rank │ id              │ src        │ dense │ sparse │ rrf │ used? │ │
│   │   1  │ chunk_01H…      │ ch3 §2     │ 0.91  │ 0.84   │ … │  ✓     │ │
│   │   2  │ chunk_01H…      │ ch5 §1     │ 0.87  │  —     │ … │  ✓     │ │
│   │   …                                                                  │ │
│   │ ▸ Click row → Source panel slides in (lifted SourcePanel)            │ │
│   └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

Everything important is on one page. The form is sticky-left when
you scroll. Hitting Enter (with Cmd) re-runs. The Audit Drawer slides
in from the right with the full `query_events` row. The candidates
table is the part that doesn't exist in the old FE and is the
**single highest-leverage view** for retrieval-quality work.

### 8.2 QueryHistory (M1)

Table of recent `query_events` (last 100). Columns:

| timestamp | namespace | query | latency | citations | degradation |

Click a row → the QueryBench opens pre-filled with that query's
inputs **and** the AuditDrawer for that historical run. So the
operator can replay it, tweak one parameter, see the new audit
side-by-side.

### 8.3 Compare (M2, the killer feature)

Two QueryBench panels side-by-side, both bound to a shared
`query` input but each with its own retrieval/embedding/inference
config. Hit Run → both fire in parallel → both audit drawers open
stacked → diff highlighted in the candidates table (ranks +/-, score
deltas, citation set symmetric diff).

This is the answer to "is this change actually better?" — replacing
the current "run two curls and eyeball the audit" workflow.

### 8.4 Ingest (M1)

```
┌─ Drop file or browse ───────────────────────────────────────┐
│   sample.md  (16 KB)                                         │
├──────────────────────────────────────────────────────────────┤
│   Title:               [ Sample doc                       ]  │
│   doc_type:            [ passage ▼  ]                        │
│   embedding profile:   [ openai-text-embedding-3-large ▼ ]   │
│   chunking profile:    [ generic ▼ ]                         │
│   target tokens:       [ 200 ]   overlap: [ 30 ]             │
│   mode:                [ full ▼ ]                            │
│                                                              │
│   ▸ Ingest                                                   │
└──────────────────────────────────────────────────────────────┘

┌─ Job stream ────────────────────────────────────────────────┐
│  job_01HZ…                                                   │
│  ⏵ pending  → claimed by ingest-worker-…                    │
│  ✓ fetch     12ms                                            │
│  ✓ normalize 41ms                                            │
│  ✓ chunk     19ms (28 chunks)                                │
│  ✓ embed   1.4s   (28/28 OK)                                 │
│  ✓ index   210ms                                             │
│  ⏵ enrich    … running                                       │
│                                                              │
│  Total elapsed: 2.1s                                         │
└──────────────────────────────────────────────────────────────┘
```

Polls `/v1/ingestion-jobs/{id}` every 1.5s. Stage transitions stream
into the log. Stage failures surface the `error_code` +
`error_message` inline.

### 8.5 DocumentInspector (M2)

Per-namespace document list → click a document → tabs:

- **Chunks** — every chunk's id, section path, token count, text. Click → SourcePanel slides in.
- **Versions** — version history with content hashes
- **Enrichments** — what enrichment runs have been applied (matters for non-`generic` profiles)
- **Re-ingest** — quick-action button to re-trigger with a tweaked profile

### 8.6 ProviderKeys (M2)

Plain table:

| provider | label | last_validated_at | status | actions |

"Add" form has provider dropdown + label input + key field (password-
masked, never persisted in FE state after submit). Delete + Test
buttons per row.

### 8.7 NamespaceList (M2)

Plain table with:

| slug | corpus_profile | embedding_profile | vector_backend | doc count |

"Create namespace" form for sandbox-flavored quick provisioning. The
`namespace_vector_backend` defaults respect the runtime
(qdrant on self-host, vectorize on CF) — same logic
`seed-self-host.ts` does today.

### 8.8 Admin (M2, light)

Two tabs:

- **Ingestion jobs** — DLQ + recent failures + retry buttons. Reads `/v1/admin/ingestion-jobs`.
- **Enrichment runs** — start a re-enrichment for an existing namespace. Reads `/v1/admin/namespaces/{slug}/enrichment-runs`.

That's it. Anything heavier (e.g., D1 query inspection) belongs in
`docs/runbooks/` and a psql shell, not the sandbox.

## 9. Component map — lifted vs new

### 9.1 Lifted (paths relative to `/home/leif/textral/apps/frontend/src/`)

```
components/CommandPalette.tsx                  →  src/components/CommandPalette.tsx
components/HelpOverlay.tsx                     →  src/components/HelpOverlay.tsx
components/layout/AppShell.tsx                 →  src/components/layout/AppShell.tsx
components/layout/Navbar.tsx                   →  src/components/layout/Navbar.tsx
components/layout/ResizablePane.tsx            →  src/components/layout/ResizablePane.tsx
components/conversation/AnswerAuditDrawer.tsx  →  src/components/AnswerAuditDrawer.tsx ★
components/source/SourcePanel.tsx              →  src/components/SourcePanel.tsx ★
components/ui/{Button,Card,Badge,EmptyState,Input,Markdown,
              SearchInput,Skeleton,Spinner,InlineEditable,index}.tsx
                                               →  src/components/ui/* (all 11)
context/ToastContext.tsx                       →  src/context/ToastContext.tsx
context/ConfirmContext.tsx                     →  src/context/ConfirmContext.tsx
hooks/useHotkeys.ts                            →  src/hooks/useHotkeys.ts
hooks/useResizablePanes.ts                     →  src/hooks/useResizablePanes.ts
hooks/useBreakpoint.ts                         →  src/hooks/useBreakpoint.ts
styles/tokens.ts                               →  src/styles/tokens.ts
```

★ = highest-value lifts.

### 9.2 New components (with rough size estimates)

| Component | Size | Notes |
|---|---|---|
| `auth/ApiKeyContext.tsx` | 60 LoC | Trivial state holder |
| `auth/ApiKeyGate.tsx` | 80 LoC | Modal + `/v1/me` validation |
| `api/client.ts` | 150 LoC | fetch wrapper, headers, 401 handling, error envelope unwrap |
| `api/sse.ts` | 80 LoC | EventSource-style reader for `?stream=sse` |
| `components/NamespacePicker.tsx` | 120 LoC | Dropdown + create-new modal |
| `components/QueryForm.tsx` | 250 LoC | All `/v1/query` body fields |
| `components/AnswerCard.tsx` | 100 LoC | Markdown answer + citation list |
| `components/AuditTimeline.tsx` | 100 LoC | Tiny stage-by-stage timing strip |
| `components/RetrievalCandidates.tsx` | 200 LoC | Sortable candidates table |
| `components/IngestStreamLog.tsx` | 150 LoC | Job-poll loop + stage strip |
| `pages/QueryBench.tsx` | 180 LoC | Glue |
| `pages/QueryHistory.tsx` | 120 LoC | Table + click-to-replay |
| `pages/Ingest.tsx` | 150 LoC | Drag-drop + stream log |
| `pages/Compare.tsx` (M2) | 250 LoC | Two QueryBench panels + diff |
| `pages/{ProviderKeys,NamespaceList,DocumentInspector,Admin}.tsx` (M2) | ~150 LoC each |

Total: M1 ~1.5K LoC of new code, ~600 LoC of lifted code adapted, ~600 LoC of generic primitives lifted unchanged. Roughly a week of focused work for M1.

## 10. Implementation phases

### M1 — usable core (target: ~5 days)

**Goal:** an operator can paste their key, pick a namespace, ingest a
markdown file, run queries, drill into audit, and replay history.

- [ ] Scaffold `apps/sandbox/` with Vite + React 19 + TS + the lifted
      generic primitives (chrome, ui/, hooks, context).
- [ ] `ApiKeyGate` + `ApiKeyContext` + `/v1/me` validation.
- [ ] `api/client.ts` + types for the routes M1 touches.
- [ ] `NamespaceContext` + `NamespacePicker` (header dropdown).
- [ ] `Ingest` page — drop file → POST register → upload PUT →
      finalize → ingest → poll-until-done → stream log.
- [ ] `QueryBench` page — form covering every `/v1/query` body field;
      result panel; `RetrievalCandidates` table; `AnswerAuditDrawer`
      lifted in.
- [ ] `QueryHistory` page — list + click-to-replay-into-bench.
- [ ] CSS using lifted `tokens.ts`. Keep it close to the bone — no
      tailwind, no style framework.
- [ ] `make sandbox-dev` Makefile target that runs `vite` against
      the local self-host stack (assumes `make selfhost-up`
      already-running).

**Acceptance:**
- Drop `apps/api/test/fixtures/narrative-tiny.md` → ingest →
  query "Who calculated the circumference of the Earth?" → answer
  with citations rendered → AuditDrawer shows
  `degradation_level=full`, dense+sparse candidate counts > 0,
  rerank.executed in {true, false} as configured.
- Cookbook fixture validation: every pattern in the cookbook
  validator runs cleanly from the QueryBench (one click each, no
  curl).

### M2 — the comparison/inspection tier (target: ~5 days)

**Goal:** the sandbox is *better* than curl + jq for retrieval
iteration.

- [ ] `Compare` page (side-by-side; the killer feature).
- [ ] `ProviderKeys` page (list/add/delete/test).
- [ ] `NamespaceList` page (CRUD + create-form respecting runtime
      defaults).
- [ ] `DocumentInspector` (chunk list + per-chunk text).
- [ ] `Admin` page (jobs DLQ + enrichment runs).
- [ ] SSE streaming toggle in QueryBench.
- [ ] Generated types via `openapi-typescript` (replaces hand-typed
      `api/types.ts`).

**Acceptance:**
- Run two configs against the same query, eyeball the diff in the
  candidates table, decide which to ship — without leaving the page.
- Ingest job stuck on `failed` → click Retry from Admin → confirm via
  the stream log it's now running.

### M3 — production-shape build + ship (target: ~2 days)

**Goal:** the sandbox is part of `make selfhost-up`.

- [ ] `apps/sandbox/Dockerfile` — multi-stage, vite build → nginx
      static or `serve dist/` (decide based on bundle size).
- [ ] Wire into `infrastructure/docker/docker-compose.yml` as a
      `sandbox` service (port 5173 by default; behind the same
      reverse proxy as the api in production).
- [ ] CI lane: `pnpm --filter @textral/sandbox build` runs in the
      Node CI matrix; failure is a release blocker.
- [ ] `docs/SELF_HOSTING.md` updated: "open
      `http://localhost:5173` after `make selfhost-up`."
- [ ] Update `README.md` quickstart to mention the sandbox URL.

**Acceptance:**
- `make selfhost-up` brings up 8 services healthy (now
  postgres/redis/qdrant/minio/api/ingest-worker/ingest/sandbox).
- A clean clone, `cp .env.selfhost.example .env.selfhost`, fill
  secrets, `make selfhost-up`, open `http://localhost:5173`, paste
  the seeded API key, ingest the cookbook fixture, run a query — all
  inside 15 minutes, no curl required.

## 11. Open questions

1. **Streaming UI shape** — token-by-token append vs final-render? Lean
   toward final-render for correctness (citations only land at end);
   token-by-token can be a polish item.
2. **Multi-tenancy** — single key per sandbox load, or quick-switch
   between keys for multi-tenant testing? Lean toward single. Adding
   later is easy.
3. **Persistence of "experiment runs"** — should the sandbox save
   a named "experiment" (= query + retrieval config) and replay it?
   Current answer: no, lean on `query_events` history. Revisit if
   operators ask.
4. **Theming / dark mode** — `tokens.ts` already has color tokens.
   Wire a class toggle or skip until M2+? Lean toward skipping.
5. **Generated types vs hand-typed** — start with hand-typed for M1
   (fastest to bootstrap), generate via `openapi-typescript` in M2.

## 12. What this is NOT

To prevent scope creep, the sandbox **is not**:

- A customer-facing UI for any tenant
- A multi-user app (single API key, single tenant scope)
- A way to make irreversible changes (deletes are soft; backed by
  the same V3 endpoints that have always been soft-delete)
- An eval-runs UI (the eval CLI in `packages/eval-cli` is the right
  surface)
- A replacement for `/docs` (Scalar) — this is the *playground*; Scalar
  is the *reference*. Sandbox links out to `/docs` from the help
  overlay.

## 13. References

- V3 backend: `docs/v3/PHASE-2_DETAILED_DESIGN.md`,
  `docs/development/v3/PHASE_2_IMPLEMENTATION.md`
- Self-host operator runbook: `docs/SELF_HOSTING.md`
- Scalar API reference: any deploy's `/docs` route
- Old FE source (mining target):
  `/home/leif/textral/apps/frontend/src/` (V2 repo)
- API contract: any deploy's `/openapi.json` (or
  `apps/api/src/openapi/` in source)
