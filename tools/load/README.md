# Load test tooling

Phase 8.4 deliverables. Two scripts + a body fixture.

## Prereqs

- `oha` (https://github.com/hatoo/oha) — `cargo install oha` or `brew install oha`
- `jq` (for the ingest script)
- A deployed dev environment + a tenant with:
  - An API key in `LIVE_API_KEY`
  - An OpenAI BYOK registered with label `load-test`

## Scripts

- `oha-query.sh` — sustained 100-concurrent / 20 QPS for 5 min against
  `/v1/query`. Captures latency percentiles + 5xx rate to a timestamped
  results file under `tools/load/`.
- `oha-ingest.sh` — fans out 50 parallel ingestion jobs (via the
  full upload → finalize → ingest sequence). Operator monitors job
  state via the admin endpoints.

## Targets (from Phase 8.4 exit criteria)

| Metric | Target |
|--------|--------|
| Sustained QPS | ≥ 20 over 5 min |
| p95 latency | ≤ 4 s |
| 5xx error rate | ≤ 0.5% |
| Ingestion throughput | per-Container-instance baseline (no hard target) |

Capture results in `docs/runbooks/LOAD_TEST_RESULTS.md`.

## k6 alternative

If `oha` is unavailable, k6 works:

```js
// tools/load/k6-query.js
import http from 'k6/http';
import { check } from 'k6';
export const options = {
  vus: 100,
  duration: '5m',
  thresholds: {
    http_req_duration: ['p(95)<4000'],
    http_req_failed: ['rate<0.005'],
  },
};
export default () => {
  const r = http.post(`${__ENV.LIVE_WORKER_URL}/v1/query`,
    JSON.stringify(require('./query-body.json')),
    { headers: {
      'content-type': 'application/json',
      'x-textral-api-key': __ENV.LIVE_API_KEY,
    } });
  check(r, { '200': (x) => x.status === 200 });
};
```
