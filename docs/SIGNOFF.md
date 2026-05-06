# Textral MVP — Sign-off Checklist

Tag `v0.1.0` after every box is checked. Each box has an owner and a
link to the evidence (a green CI run, a runbook entry, a PR, etc.).

## Phase exit criteria

- [ ] **Phase 0–7 exit criteria all green** —
      see `docs/2-PHASES.md` for the per-phase list.
      Owner: ___ Evidence: ___
- [ ] **Phase 8 exit criteria all green** — every step in this
      doc has its tests passing.
      Owner: ___ Evidence: ___

## E2E + reliability

- [ ] **`apps/api/test/e2e/happy-path.test.ts` green for 7
      consecutive days** against deployed dev. Run with
      `LIVE_E2E=1 LIVE_WORKER_URL=... LIVE_API_KEY=... OPENAI_API_KEY=... pnpm test e2e`.
      Owner: ___ Evidence: ___
- [ ] **DLQ + retry exercised on a real injected incident.**
      Either a planned drill (rotate a key, observe DLQ, retry
      after fix) or a captured incident.
      Owner: ___ Evidence: ___
- [ ] **Cost reconciliation** within ±$0.01 for one tenant-day.
      Owner: ___ Evidence: docs/runbooks/COST_RECONCILIATION.md

## Security

- [ ] **No P0/P1 security findings open** in `THREAT_MODEL.md`.
      Owner: ___ Evidence: docs/security/THREAT_MODEL.md
- [ ] **Threat model reviewed** by at least one engineer outside
      the original authoring group. Reviewer: ___
      Evidence: docs/security/REVIEW_<date>.md
- [ ] **Redaction fuzz** with five novel key shapes passes (re-run
      `provider-redaction.test.ts`).
      Owner: ___ Evidence: ___
- [ ] **Tenant isolation** — `pnpm test test/security/tenant-isolation.test.ts`
      green; reviewer confirms no probe returns 403 on the
      existence boundary.
      Owner: ___ Evidence: ___

## Performance

- [ ] **Sustained 20 QPS for 5 min, p95 ≤ 4 s, 5xx ≤ 0.5%.**
      Captured via `tools/load/oha-query.sh`.
      Owner: ___ Evidence: docs/runbooks/LOAD_TEST_RESULTS.md

## Migration

- [ ] **Migration runbook tested on a fresh CF account.**
      End-to-end: clone → install → migrate-prod → deploy-prod →
      seed-prod → query.
      Tester: ___ Evidence: ___

## Onboarding

- [ ] **Quickstart works for an outside reader** in ≤ 60 minutes.
      Owner: ___ Evidence: ___
- [ ] **At least one external tenant onboarded** against dev in a
      real use case. Tenant: ___ Evidence: ___

## Docs

- [ ] **README.md current** — repo layout, status, links to all
      runbooks.
- [ ] **API.md current** — auto-generated OpenAPI link works,
      flagship-flow code samples run.
- [ ] **QUICKSTART.md current** — step-by-step verifies clean
      against a fresh dev deploy.
- [ ] **All runbooks reviewed** — DEPLOY, INCIDENTS, ALERTS,
      COST_RECONCILIATION, LOAD_TEST_RESULTS.

## Sign-off line

> "I have checked every box above and confirmed the linked evidence.
> The MVP is shippable."
>
> — _<name>_, _<date>_

Tag `v0.1.0` in the same PR.
