#!/usr/bin/env bash
# CI guard: refuse Node-runtime imports outside runtime/node/*.
#
# Patterns flagged (import specifiers):
#   - pg                  (Postgres client)
#   - ioredis             (Redis client)
#   - @aws-sdk/client-s3  (S3 client)
#   - node:*              (Node builtins — fs, crypto, stream, …)
#   - @hono/node-server   (Node HTTP adapter)
#
# Allowlist:
#   - apps/api/src/runtime/node/**   (the Node runtime itself)
#
# CF-runtime code must use Web APIs / WebCrypto / fetch / R2 / D1
# bindings; pulling node:crypto or pg into shared or CF code would
# break the Workers build.
#
# Usage:
#   bash tools/check-no-node-imports-in-cf.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PATTERN="from '(pg|pg-native|ioredis|@aws-sdk/client-s3|node:[a-z]+|@hono/node-server)'"

HITS=$(grep -rEn "$PATTERN" apps/api/src/ \
  | grep -vE 'apps/api/src/runtime/node/' \
  | grep -vE '\.md:' \
  || true)

if [ -n "$HITS" ]; then
  echo "ERROR: Node-runtime imports found outside runtime/node/."
  echo "Move Node-specific code into runtime/node/, or thread it"
  echo "through a Bindings interface in runtime/shared/interfaces.ts."
  echo
  echo "$HITS"
  exit 1
fi

echo "OK: no Node-runtime imports outside runtime/node/"
