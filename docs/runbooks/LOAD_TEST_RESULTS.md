# Load Test Results

Template for capturing load-test runs. Each run gets a stanza below.

## How to run

See `tools/load/README.md`.

## Targets

| Metric | Target | Source |
|--------|--------|--------|
| Sustained QPS | ≥ 20 over 5 min | Phase 8.4 |
| p95 latency | ≤ 4 s | Phase 8.4 |
| 5xx error rate | ≤ 0.5% | Phase 8.4 |

## Run log

### YYYY-MM-DD — initial baseline

- **Deploy version:** _(git sha)_
- **Tenant:** _(tenant id)_
- **Env:** dev
- **Tooling:** oha
- **Duration:** 5m, 20 QPS, 100 concurrent

| Metric | Result |
|--------|--------|
| Sustained QPS | _ |
| p50 latency | _ |
| p95 latency | _ |
| p99 latency | _ |
| 5xx rate | _ |
| Total queries | _ |

**Targets met?** _yes / no — and if no, what's blocking_.

**Blocking issues found:** _none / list_.

**Notes:** _free-form_.

---

(Add a new dated stanza for each run. Keep historical entries; load
profile changes over time should be visible.)
