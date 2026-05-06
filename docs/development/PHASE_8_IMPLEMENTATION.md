# Phase 8 — Implementation Steps

> Companion to `docs/2-PHASES.md`. Concrete, ordered steps for Phase 8
> (verification + sign-off). At completion, the MVP is declared
> shippable.

---

**At completion, you will have:**

- A single happy-path E2E test that walks tenant register → namespace
  → upload → ingest → query → eval → audit, against deployed dev.
- Multi-tenant isolation tests that prove cross-tenant probes return
  404 (never 403; never leak existence).
- Failure-injection tests for the four canonical bad-day modes:
  invalid_api_key, insufficient_quota, embedding_profile_mismatch,
  AI-Gateway outage.
- Load-test scripts (k6 or oha) and a runbook capturing measured
  baselines.
- A threat model + security review document.
- A cost-reconciliation script that compares `query_events.total_cost_usd_micros`
  against AI Gateway dashboard numbers within ±1¢ for a sample day.
- Public-facing docs: `README.md`, `docs/QUICKSTART.md`,
  `docs/API.md`, `docs/runbooks/DEPLOY.md`.
- A `SIGNOFF.md` checklist with every box checkable.

By the end of this phase, an outside engineer can clone the repo,
follow the QUICKSTART, and have a working dev deploy in under 60
minutes; that same engineer can read the API doc and write a working
client without the rest of the codebase open.

---

## What Phase 8 specifically does NOT do

- **No production deploy.** Sign-off enables it; it doesn't perform
  it. A separate runbook (`DEPLOY.md`) is the operator's checklist.
- **No load test against prod.** Baselines are measured against
  deployed dev. Prod numbers are owned by the operations runbook.
- **No tenant onboarding.** "Onboard one external tenant" is on the
  sign-off checklist as a hard prerequisite, but doing the onboarding
  is operator work outside this doc.
- **No new features.** Anything that would land here as "while we're
  in there" goes to a follow-up issue, not into MVP.

---

## Prerequisites recap

End of Phase 7:

- 238 + N api tests green, including: error-envelope-route-snapshot,
  admin-ingestion-jobs, observability-metrics, ai-gateway-tag-coverage,
  query-stream, usage-records, admin-enrichment-runs, eval-route,
  eval-judges.
- `make test-live` and `make test-live-phase5` green; the live test
  now includes the streaming smoke + eval baseline.
- The narrative + legal corpus profiles work end-to-end.
- DLQ admin endpoints and bulk enrichment-only admin endpoint live.
- `usage_records` populated by every successful query + ingestion.
- AE metric writes live (no-ops if binding absent).

Operational prereqs:

- `pnpm` and Node 24.
- Dev deploy intact + populated with test data.
- `OPENAI_API_KEY`, `VOYAGE_API_KEY`, `LIVE_API_KEY` configured.
- A second test tenant in dev (for isolation tests).

---

## Locked-in technology choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| E2E test runner | **vitest with `@cloudflare/vitest-pool-workers`**, gated by `LIVE_E2E=1` env var | Reuses the existing pool; no new framework. Live mode runs against deployed dev; default-off keeps `pnpm test` fast. |
| Isolation tests | **In-Worker tests using two distinct tenant rows + two API keys** | Doesn't require a real second deploy. |
| Failure-injection tests | **Mock `globalThis.fetch` per test**; for AI-Gateway outage, mock all upstreams as 503 | Same pattern as existing provider tests. |
| Load test tool | **`oha`** (a `hey`-like Rust binary) | Tiny dependency footprint; `oha -q 50 -c 100 -z 5m -m POST -d @body.json -H ...` is a one-liner. k6 alternative documented but not required. |
| Threat model format | **STRIDE-by-system-component** matrix | Standard; reviewable. |
| Reconciliation tool | **TypeScript script run via `tsx`**; no new package | Reuses workspace. |
| README baseline | **Top-level project README; ~150 lines.** | Concise sales pitch + a quickstart link. |
| API doc strategy | **Auto-generated from `/openapi.json`** (already exposed in Phase 1.7) plus a hand-written intro | Don't manually maintain a parallel API doc that drifts. |
| Quickstart length | **5-minute target** | If a step takes longer, it doesn't belong in the quickstart. |
| Sign-off format | **Markdown checklist with one box per claim**, owner column, evidence link | Reviewable; auditable. |

---

## Naming and locations

```
apps/api/
├── test/
│   ├── e2e/
│   │   └── happy-path.test.ts          ← NEW (Phase 8.1)
│   ├── security/
│   │   └── tenant-isolation.test.ts    ← NEW (Phase 8.2)
│   └── failure/
│       └── injection.test.ts           ← NEW (Phase 8.3)
tools/
├── load/
│   ├── oha-query.sh                    ← NEW (Phase 8.4)
│   ├── oha-ingest.sh                   ← NEW (Phase 8.4)
│   ├── query-body.json                 ← NEW
│   └── README.md                       ← NEW
└── billing/
    └── reconcile.ts                    ← NEW (Phase 8.6)
docs/
├── security/
│   ├── THREAT_MODEL.md                 ← NEW (Phase 8.5)
│   └── REVIEW_2026-05-04.md            ← NEW (template)
├── runbooks/
│   ├── DEPLOY.md                       ← NEW (Phase 8.7)
│   ├── INCIDENTS.md                    ← NEW (Phase 8.7)
│   ├── COST_RECONCILIATION.md          ← NEW (Phase 8.6)
│   └── LOAD_TEST_RESULTS.md            ← NEW (Phase 8.4)
├── API.md                              ← NEW (Phase 8.7)
├── QUICKSTART.md                       ← NEW (Phase 8.7)
└── SIGNOFF.md                          ← NEW (Phase 8.8)
README.md                               ← REWRITTEN (Phase 8.7)
```

---

## Phase 8 — step-by-step

### Step 8.1 — E2E happy-path test

**8.1.1** New test `apps/api/test/e2e/happy-path.test.ts`. Gated by
`LIVE_E2E=1`; without it, the suite skips with a `it.skip` and a
console message.

**8.1.2** Test body covers:
1. Register provider key (OpenAI BYOK, label `e2e-{timestamp}`).
2. Create namespace `e2e-{timestamp}` with `corpus_profile='narrative'`.
3. Register a document; PUT the narrative-tiny fixture; finalize.
4. POST `/ingest` with mode `full`.
5. Poll the job until `status='completed'` (timeout 240 s).
6. Wait 25 s for Vectorize propagation.
7. Run a synchronous query: assert citations include narrative
   chunks; assert `audit.reranker.executed === true`.
8. Run a **streaming** query: assert tokens arrive; assert `done`
   carries the audit.
9. Register an eval set with the narrative-baseline questions;
   POST run; poll completion; assert pass-rate ≥ 66%.
10. Fetch `/v1/query-events/:id` for the sync query: assert audit
    fields present.
11. Cleanup: revoke the provider key (idempotent — works even if
    re-running with the same timestamp).

**8.1.3** Failure-mode handling: any step failure aborts the test
with a clear error (the cleanup happens in `afterEach`, regardless of
where the test failed).

**Exit criteria for 8.1**
- The test runs green against deployed dev.
- Sustained green for 7 consecutive days (tracked manually until
  step 8.8 sign-off).
- Wall-clock time under 8 minutes.

---

### Step 8.2 — Multi-tenant isolation tests

**8.2.1** New test `apps/api/test/security/tenant-isolation.test.ts`.
Pure in-Worker; no live deploy needed.

**8.2.2** Setup: seed two tenants (A and B). Each gets a namespace,
document, version_index, query_event. Each gets its own API key.

**8.2.3** Probe matrix — every probe sent with tenant A's API key,
target's tenant B's resource:

| Probe | Expected |
|-------|----------|
| `GET /v1/namespaces/:slug` (B's namespace) | 404 NAMESPACE_NOT_FOUND |
| `GET /v1/documents/:id` (B's doc) | 404 DOCUMENT_NOT_FOUND |
| `POST /v1/documents/:id/ingest` (B's doc) | 404 DOCUMENT_NOT_FOUND |
| `GET /v1/ingestion-jobs/:id` (B's job) | 404 NOT_FOUND |
| `GET /v1/query-events/:id` (B's event) | 404 NOT_FOUND |
| `GET /v1/admin/ingestion-jobs?dead_lettered=1` | A's only; B's never appear |
| `POST /v1/ingestion-jobs/:id/retry` (B's job) | 404 DLQ_NOT_FOUND |
| `POST /v1/admin/namespaces/:slug/enrichment-runs` (B's slug) | 404 NAMESPACE_NOT_FOUND |
| `GET /v1/namespaces/:slug/eval-sets/:id` (B's set) | 404 EVAL_SET_NOT_FOUND |
| Direct Vectorize query with malicious metadata filter targeting B's tenant_id | returns 0 rows |

**8.2.4** Each row in the matrix is one assertion. Total ≈ 10
assertions.

**8.2.5** A sub-test: cross-tenant via the audit query path. Issue a
query as A, then attempt to read the resulting `query_event` as B.
Expect 404.

**Exit criteria for 8.2**
- All 10+ probes pass.
- A code-reviewer sign-off (captured in commit message): "I confirmed
  no probe returns 403 on the existence boundary."

---

### Step 8.3 — Failure-injection tests

**8.3.1** New test `apps/api/test/failure/injection.test.ts`.

**8.3.2** Sub-tests:

| Scenario | Mock | Expected behavior |
|----------|------|--------------------|
| `invalid_api_key` at ingest | OpenAI 401 with `code: 'invalid_api_key'` | Job fatal-fails; `dead_lettered=1`; error_code `PROVIDER_KEY_INVALID`; clean error message; no retry. |
| `insufficient_quota` at query | OpenAI 429 with `code: 'insufficient_quota'` | Query degrades to `cannot_answer`; `audit.synthesis_status='failed'`; error_code `PROVIDER_QUOTA_EXHAUSTED`; no retry. |
| `EMBEDDING_PROFILE_MISMATCH` at query | Run a query with a profile distinct from the namespace's vector index | 400 with code; no retrieval issued. |
| AI Gateway outage | Mock all upstream as 503 with `Retry-After: 60` | Both query + ingest fall back to direct provider call. If direct also fails: query → `cannot_answer`; ingest → DLQ. |
| DLQ retry post key fix | Run a job that DLQ's, replace the key, retry | New attempt succeeds; `dead_lettered=0`; status reaches `completed`. |

**8.3.3** Each scenario is one `it()`. The injection mocks are scoped
to the `it()` block (vi.restoreAllMocks in afterEach).

**Exit criteria for 8.3**
- All scenarios pass.
- The error codes returned match the catalog exactly (verified via the
  Phase 6.1 catalog gating test).

---

### Step 8.4 — Load test tooling

**8.4.1** Create `tools/load/oha-query.sh`:

```bash
#!/usr/bin/env bash
# Usage:
#   LIVE_WORKER_URL=... LIVE_API_KEY=... ./tools/load/oha-query.sh
set -euo pipefail
: "${LIVE_WORKER_URL:?missing}"; : "${LIVE_API_KEY:?missing}"
oha -q 20 -c 100 -z 5m \
    -m POST -T 'application/json' -H "x-textral-api-key: $LIVE_API_KEY" \
    -d "$(cat tools/load/query-body.json)" \
    "$LIVE_WORKER_URL/v1/query" \
  | tee tools/load/results-$(date +%s).txt
```

**8.4.2** Create `tools/load/oha-ingest.sh` similarly: 50 ingestion
jobs queued in parallel against the dev tenant's narrative namespace.
The script enqueues + polls; the runbook owns the math on throughput.

**8.4.3** `tools/load/query-body.json`:

```json
{
  "namespace": "narrative",
  "query": "Who calculated the circumference of the Earth?",
  "embedding": { "provider": "openai", "model": "text-embedding-3-large", "dimensions": 1536, "provider_key_ref": "load-test" },
  "inference": { "provider": "openai", "model": "gpt-4o-mini", "provider_key_ref": "load-test" },
  "retrieval": { "strategy": "hybrid_rrf", "top_k_dense": 5, "top_k_sparse": 5 }
}
```

**8.4.4** `docs/runbooks/LOAD_TEST_RESULTS.md` is a template:
- Date, deploy version, results table (p50/p95/p99 latency, error
  rate, total queries).
- A "compared to MVP target" column: target QPS ≥ 20, p95 ≤ 4 s,
  5xx rate ≤ 0.5%.
- A "blocking issues found" section (left blank for the first run).

**8.4.5** Run the load test once against deployed dev. Capture
results in the runbook. If targets aren't met, file issues and
re-run.

**Exit criteria for 8.4**
- Sustained 20 QPS for 5 min, 5xx ≤ 0.5%, p95 ≤ 4 s.
- The runbook captures results from a real run.
- (If targets aren't met on first try, that's not a Phase 8 failure
  — the test is the deliverable; the result tells the operator
  what's left.)

---

### Step 8.5 — Security review

**8.5.1** `docs/security/THREAT_MODEL.md` covers, by component:

- **Worker entry point.** Threats: malformed input → DoS; auth
  bypass; key extraction. Mitigations: Zod validation, redaction
  middleware, scoped API keys, HMAC for internal back-channel.
- **D1 access.** Threats: tenant boundary bypass via constructed
  queries. Mitigations: every helper takes `tenant_id` as a required
  arg; CI guard prevents inline SQL outside `src/db/`.
- **Vectorize.** Threats: cross-tenant query via metadata-filter
  manipulation. Mitigations: filter is constructed Worker-side from
  the authenticated tenant_id; never passed through from request body.
- **R2.** Threats: cross-tenant object read; presign URL leak.
  Mitigations: prefixed bucket layout `{tenant_id}/...`; Worker-proxy
  upload (no presign); list operations are tenant-prefixed.
- **Provider keys.** Threats: raw key in logs / error envelopes.
  Mitigations: redaction middleware, fuzz tests, KV-backed Secrets
  Store, prod-boot guard against in-process Map fallback.
- **Internal back-channel.** Threats: replay, body forgery.
  Mitigations: HMAC + 5-min window, body-hash in canonical string,
  ownership check via `assertOwnership`.
- **Container.** Threats: side-loading malicious profile YAML;
  spoofed worker callbacks. Mitigations: profiles bundled in image
  at build time; back-channel HMAC; queue messages signed.

**8.5.2** STRIDE matrix per component (Spoofing, Tampering,
Repudiation, Info disclosure, DoS, Elevation). For each: status (✓
mitigated / ⚠ accepted-residual / ✗ open). MVP needs zero ✗.

**8.5.3** Review checklist exercises:
- Redaction middleware: re-run the existing fuzz test with novel key
  shapes (sk-proj-, sk-ant-, sk-anth-, voy-, randomized 40+ char).
- Tenant isolation: re-run the suite from 8.2.
- API-key revocation latency: revoke a key; ensure subsequent
  requests get 401 within 60 s. (Document the test recipe; if KV TTL
  delays it, document the workaround.)
- Dev-only `__redaction_check` route: assert it returns 404 in prod
  via a config-gated test.

**8.5.4** `docs/security/REVIEW_2026-05-04.md` template. The first
review uses today's date; subsequent reviews follow the same shape.

**Exit criteria for 8.5**
- THREAT_MODEL.md complete with no ✗ entries.
- One outside engineer signs off (commit message + reviewer line).
- Each checklist exercise passes.

---

### Step 8.6 — Cost reconciliation

**8.6.1** Create `tools/billing/reconcile.ts`:

```ts
// Usage: tsx tools/billing/reconcile.ts --tenant ten_xxx --date 2026-05-03
//
// Pulls:
//   - sum(total_cost_usd_micros) from query_events for the tenant + day
//   - aggregated AI Gateway usage via the AIG export API
//   - tenant's provider dashboard (manual entry; this script can't pull)
// Diffs each pair; reports if > 1¢ off.
```

The script accepts `--source query_events` and `--source aig` flags
to print just one column at a time.

**8.6.2** `docs/runbooks/COST_RECONCILIATION.md` documents:
- Expected divergences (< 1¢ acceptable; tax differences are
  excluded; refunds/credits are out of scope).
- The 90-day prune query for `usage_records` (per Phase 6.7 close-out
  note).
- A reproducible day-1 baseline for the dev tenant.

**8.6.3** Run reconcile against dev for one day. Capture the result
in the runbook.

**Exit criteria for 8.6**
- Script runs end-to-end against deployed dev.
- All three numbers (provider dashboard, AIG, query_events) agree
  within ±1¢.

---

### Step 8.7 — Documentation pass

**8.7.1** Top-level `README.md`. Sections:
- One-paragraph elevator pitch.
- "What it is / what it isn't" (3 bullets each).
- Quickstart link.
- Repo layout (workspace packages enumerated).
- Status banner ("MVP candidate; v0.1.0 sign-off pending — see
  SIGNOFF.md").

**8.7.2** `docs/QUICKSTART.md` — 5-minute target:
1. Clone + `pnpm install`.
2. `cp .env.example .env`; fill in keys.
3. `make migrate-dev` + `make deploy-dev`.
4. `make seed-tenant` (registers a tenant + API key + OpenAI BYOK).
5. `make ingest-narrative` (uploads + ingests narrative-tiny).
6. `make query-narrative` (runs the canonical "circumference" query).

The Makefile targets are stubs in the existing Makefile; verify each
runs cleanly. If a Makefile target is missing, add it.

**8.7.3** `docs/API.md`:
- Intro: 1-page overview of the request shape conventions, error
  envelope, audit trails, idempotency rules.
- The rest is a generator note: "Full reference is auto-generated at
  `/openapi.json` and rendered at `/docs` (Scalar UI)."
- Code samples: curl + minimal TypeScript SDK for the four flagship
  flows (register tenant, ingest, query, eval).

**8.7.4** `docs/runbooks/DEPLOY.md`:
- Pre-flight: required CF account permissions, all bindings in
  `wrangler.toml` are real not placeholders, every env vars set.
- Step-by-step: migrate, deploy worker, deploy container, verify
  health.
- Verification: hit `/health`, run `test-live` against the new
  deploy, check AIG dashboard for tag presence.
- Rollback: `wrangler deploy --version-id <prev>` + DB rollback note.

**8.7.5** `docs/runbooks/INCIDENTS.md`:
- The four MVP alerts from `ALERTS.md` (Phase 6.6).
- For each: triage steps, common causes, mitigations.
- A "war stories" section with placeholder entries to fill in
  post-MVP.

**Exit criteria for 8.7**
- A new engineer can clone the repo and reach a working query in
  under 60 minutes following only QUICKSTART.md.
- API.md links resolve; OpenAPI doc renders.
- DEPLOY.md tested against a fresh dev deploy.

---

### Step 8.8 — Sign-off checklist

**8.8.1** Create `docs/SIGNOFF.md`:

```markdown
# Textral MVP — Sign-off Checklist

Tag `v0.1.0` after every box is checked.

## Phase exit criteria
- [ ] Phase 0–7 exit criteria all green (link to each phase doc's
      close-out section).
- [ ] Phase 8 exit criteria all green (link to each step's exit
      criteria).

## E2E + reliability
- [ ] `apps/api/test/e2e/happy-path.test.ts` green for 7 consecutive
      days.
- [ ] DLQ + alerts proven via a real injected incident.
- [ ] Cost reconciliation accurate within ±1¢.

## Security
- [ ] No P0/P1 security findings open.
- [ ] Threat model reviewed by at least one engineer outside the
      authoring group. Reviewer: ___
- [ ] Redaction fuzz with five novel key shapes passes.

## Performance
- [ ] Sustained 20 QPS for 5 min, p95 ≤ 4 s, 5xx ≤ 0.5%
      (LOAD_TEST_RESULTS.md captures the run).

## Migration
- [ ] Migration runbook tested on a fresh CF account end-to-end.
      Tester: ___

## Onboarding
- [ ] Quickstart works for an outside reader (≤ 60 min).
- [ ] At least one tenant onboarded against dev environment in a real
      use case.

## Docs
- [ ] README.md current.
- [ ] API.md current.
- [ ] QUICKSTART.md current.
- [ ] All runbooks reviewed.
```

**8.8.2** Each box is a hard pass/fail. The PR that flips the last
box is the one that tags `v0.1.0`.

**Exit criteria for 8.8**
- All boxes checked + git-tag `v0.1.0` exists.

---

## Cross-phase verification at close-out

Before declaring Phase 8 complete (and the MVP shippable):

1. Every test (api + contracts + corpus-profiles + ingest +
   eval-cli) green.
2. Every live e2e (`make test-live`, `make test-live-phase5`,
   `apps/api/test/e2e/happy-path.test.ts` with `LIVE_E2E=1`) green.
3. The full set of CI guards (typecheck, lint, no-inline-d1,
   error-envelope-route-snapshot, ai-gateway-tag-coverage,
   tag-coverage tests) green.
4. SIGNOFF.md every box checked.
5. A `v0.1.0` tag exists on `main`.

---

## FAQ — anticipated review questions

| Q | A |
|---|---|
| Why oha not k6? | k6 has more features, but oha is a single static binary; for the single-host MVP load test, oha's simpler. Either works; the script can be ported to k6 trivially. |
| Why is the threat model STRIDE-by-component instead of attack-tree? | STRIDE is more coverage-friendly for a complete system; attack trees are sharper for a known-targeted threat. MVP needs the breadth more than the depth. |
| Why is the load test target only 20 QPS? | First-customer scale; the architecture scales horizontally via Workers, so 20 QPS is just the proof-of-life baseline. Phase 9 would set higher bars. |
| Why does the cost reconcile script not pull provider dashboards automatically? | Provider billing APIs are inconsistent; manual entry is fine for a sign-off ritual. A future tool can pull from OpenAI's billing endpoint specifically. |
| Why does API.md defer to /openapi.json? | We already auto-generate the spec from the route definitions. A hand-maintained API doc would drift; the generator is the single source. |
| Why is "onboard an external tenant" on the sign-off list? | Internal e2e tests prove the code works; an external tenant proves the docs work. They're complementary signals. |
| Why isn't there a Phase 9? | MVP is the goal. Phase 9 (advanced features, multi-region, custom embedding profiles, etc.) is a separate planning exercise after MVP is live. |

---

End of Phase 8 implementation guide. The next document is `SIGNOFF.md`.
