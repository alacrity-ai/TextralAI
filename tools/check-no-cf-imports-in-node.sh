#!/usr/bin/env bash
# CI guard: refuse Cloudflare-runtime imports outside runtime/cf/* and
# the Worker entrypoint. Runs grep against the source tree under
# apps/api/src/ and exits 1 on any hit.
#
# What we flag (anchored on real syntax, not bare words — strings and
# comments mentioning "Vectorize" don't trip):
#
#   1. `import …` from a cloudflare: scheme or @cloudflare/* package.
#   2. Type-annotation usage of CF binding type names (D1Database,
#      R2Bucket, KVNamespace, DurableObject{Namespace,Stub},
#      Vectorize, MessageBatch, AnalyticsEngineDataset, Ai, Queue).
#      These types come from @cloudflare/workers-types — referencing
#      one outside the allowlist means CF-only code has leaked into
#      shared / Node-runtime code.
#   3. `crypto.DigestStream` — Workers-only WebCrypto extension.
#
# Allowlist:
#   - apps/api/src/runtime/cf/**           (the CF runtime itself)
#   - apps/api/src/runtime/shared/interfaces.ts
#         declares structural shapes (WorkersAiBinding,
#         VectorizeIndexHandle) by name; mention-only.
#   - apps/api/src/types.ts
#         the `Env extends Bindings` cohabitation type — references
#         the CF binding-type names in field declarations. Erased at
#         emit time; the Node bundle never imports them. Removed
#         when Phase-2 cleanup collapses Env back to Bindings.
#   - apps/api/src/index.ts
#         the Worker entrypoint — re-exports `IngestContainer` from
#         runtime/cf/container.ts and dispatches the queue handler.
#
# Usage:
#   bash tools/check-no-cf-imports-in-node.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# (1) Imports from CF packages.
IMPORT_RE="from ['\"]cloudflare:|from ['\"]@cloudflare/"

# (2) Type-annotation usage. We require one of `: `, `<`, `extends `,
#     `implements ` immediately before the type name so we don't trip
#     on substrings inside strings/comments. Matches:
#       `: D1Database`, `<D1Database>`, `extends Ai`, etc.
TYPE_RE=':\s*(D1Database|R2Bucket|KVNamespace|DurableObjectNamespace|DurableObjectStub|Vectorize|MessageBatch|AnalyticsEngineDataset|Ai|Queue)\b|<\s*(D1Database|R2Bucket|KVNamespace|DurableObjectNamespace|DurableObjectStub|Vectorize|MessageBatch|AnalyticsEngineDataset|Ai|Queue)\b'

# (3) Workers-only DigestStream API.
API_RE='\bcrypto\.DigestStream\b'

PATTERN="$IMPORT_RE|$TYPE_RE|$API_RE"

HITS=$(grep -rEn "$PATTERN" apps/api/src/ \
  | grep -vE 'apps/api/src/runtime/cf/' \
  | grep -vE 'apps/api/src/runtime/shared/interfaces\.ts:' \
  | grep -vE 'apps/api/src/types\.ts:' \
  | grep -vE 'apps/api/src/index\.ts:' \
  | grep -vE '\.md:' \
  | grep -vE ':[0-9]+:[[:space:]]*//' \
  | grep -vE ':[0-9]+:[[:space:]]*\*' \
  || true)

if [ -n "$HITS" ]; then
  echo "ERROR: Cloudflare-runtime imports/references found outside runtime/cf/."
  echo "Move runtime-specific code into runtime/cf/, or shape the"
  echo "import through a Bindings interface in runtime/shared/interfaces.ts."
  echo
  echo "$HITS"
  exit 1
fi

echo "OK: no CF-runtime imports outside runtime/cf/"
