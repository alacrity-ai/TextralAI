#!/usr/bin/env bash
# Phase 8.4 — load test script for the ingest path.
#
# Enqueues 50 ingestion jobs in parallel against the dev tenant's
# narrative namespace. Throughput tracking is operator-side (poll
# `/v1/admin/ingestion-jobs?dead_lettered=1` for failures, watch
# `version_indexes.status` distribution).
#
# Requires: LIVE_WORKER_URL, LIVE_API_KEY, OPENAI_KEY_REF (a registered
# provider key on the test tenant).

set -euo pipefail
: "${LIVE_WORKER_URL:?missing}"
: "${LIVE_API_KEY:?missing}"
: "${OPENAI_KEY_REF:?missing}"

NAMESPACE="${NAMESPACE:-narrative}"
COUNT="${COUNT:-50}"
FIXTURE="${FIXTURE:-apps/api/test/fixtures/narrative-tiny.md}"

if [ ! -f "$FIXTURE" ]; then
  echo "fixture not found: $FIXTURE"
  exit 1
fi

ts=$(date +%s)
for i in $(seq 1 "$COUNT"); do
  (
    title="load-${ts}-${i}"
    doc=$(curl -s -X POST "$LIVE_WORKER_URL/v1/namespaces/$NAMESPACE/documents" \
      -H "x-textral-api-key: $LIVE_API_KEY" \
      -H 'content-type: application/json' \
      -d "{\"title\":\"$title\",\"doc_type\":\"narrative\"}")
    doc_id=$(echo "$doc" | jq -r .id)
    upload=$(curl -s -X POST "$LIVE_WORKER_URL/v1/documents/$doc_id/uploads" \
      -H "x-textral-api-key: $LIVE_API_KEY" \
      -H 'content-type: application/json' \
      -d "{\"content_type\":\"text/markdown\",\"size_bytes\":$(stat -c%s "$FIXTURE")}")
    upload_url=$(echo "$upload" | jq -r .url)
    upload_id=$(echo "$upload" | jq -r .upload_id)
    curl -s -X PUT "$upload_url" \
      -H 'content-type: text/markdown' \
      -H "x-textral-api-key: $LIVE_API_KEY" \
      --data-binary "@$FIXTURE" > /dev/null
    finalize=$(curl -s -X POST "$LIVE_WORKER_URL/v1/documents/$doc_id/uploads/$upload_id/finalize" \
      -H "x-textral-api-key: $LIVE_API_KEY" \
      -H 'content-type: application/json' \
      -d '{}')
    ver=$(echo "$finalize" | jq -r .version_id)
    curl -s -X POST "$LIVE_WORKER_URL/v1/documents/$doc_id/ingest" \
      -H "x-textral-api-key: $LIVE_API_KEY" \
      -H 'content-type: application/json' \
      -d "{\"version_id\":\"$ver\",\"embedding\":{\"provider\":\"openai\",\"model\":\"text-embedding-3-large\",\"dimensions\":1536,\"provider_key_ref\":\"$OPENAI_KEY_REF\"},\"chunking\":{\"profile\":\"generic\",\"target_tokens\":200,\"overlap_tokens\":30},\"mode\":\"full\"}" \
      > /dev/null
    echo "queued $title"
  ) &
done
wait
echo "queued $COUNT ingestion jobs"
