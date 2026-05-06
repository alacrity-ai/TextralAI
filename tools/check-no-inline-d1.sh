#!/usr/bin/env bash
# CI guard: every D1 SQL goes through src/db/.
#
# Allowlist:
#   - apps/api/src/db/**         the helpers themselves
#
# (The previously-allowlisted `ingestion/lease.ts` and
#  `audit/query-events.ts` modules now go through the runtime-shared
#  `Db` interface — no more inline `db.prepare(...)` outside src/db/.)
#
# Usage:
#   bash tools/check-no-inline-d1.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HITS=$(grep -rEn 'env\.DB\.prepare|c\.env\.DB\.prepare' apps/api/src/ \
  | grep -vE 'apps/api/src/db/' \
  | grep -vE '\.md:' \
  || true)

if [ -n "$HITS" ]; then
  echo "ERROR: inline D1 SQL found outside the allowlist."
  echo "Move it into apps/api/src/db/<entity>.ts."
  echo
  echo "$HITS"
  exit 1
fi

echo "OK: no inline D1 SQL outside src/db/"
