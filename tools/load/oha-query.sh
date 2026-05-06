#!/usr/bin/env bash
# Phase 8.4 — load test script for /v1/query.
#
# Usage:
#   LIVE_WORKER_URL=https://textral-dev.workers.dev \
#   LIVE_API_KEY=sk-textral-... \
#   ./tools/load/oha-query.sh
#
# Targets (per Phase 8.4 exit criteria):
#   - QPS ≥ 20 sustained for 5 min
#   - p95 ≤ 4 s
#   - 5xx error rate ≤ 0.5%
#
# Requires `oha` (https://github.com/hatoo/oha): `brew install oha` /
# `cargo install oha`. k6 alternative documented in tools/load/README.md.

set -euo pipefail
: "${LIVE_WORKER_URL:?missing LIVE_WORKER_URL}"
: "${LIVE_API_KEY:?missing LIVE_API_KEY}"

OUT="tools/load/results-$(date +%Y%m%d-%H%M%S).txt"
echo "Writing results to $OUT"

oha \
  -q 20 \
  -c 100 \
  -z 5m \
  -m POST \
  -T 'application/json' \
  -H "x-textral-api-key: $LIVE_API_KEY" \
  -d "$(cat tools/load/query-body.json)" \
  --no-tui \
  "$LIVE_WORKER_URL/v1/query" \
  | tee "$OUT"

echo
echo "Targets: p95 ≤ 4 s, 5xx ≤ 0.5%, sustained ≥ 20 QPS"
echo "Capture results in docs/runbooks/LOAD_TEST_RESULTS.md."
