# Threat Model

Phase 8.5 deliverable. STRIDE-by-component matrix. The unit of
analysis is the request flow — entry points, persistence layers,
provider fanouts.

## Components in scope

1. **Worker entry point** — `apps/api/src/index.ts` and routes.
2. **Auth + scope gate** — `apps/api/src/auth/`.
3. **D1** — every helper in `apps/api/src/db/*`.
4. **Vectorize V2** — `apps/api/src/retrieval/vector-store.ts`.
5. **R2** — `apps/api/src/lib/r2-presign.ts` (now Worker-proxy only).
6. **Provider keys + Secrets Store** — `apps/api/src/lib/secrets-store.ts`.
7. **Internal back-channel** — `/internal/*` HMAC-signed routes.
8. **Container** — `apps/ingest/`, queue claim, profile YAML loader.

## STRIDE matrix

Status: ✓ mitigated · ⚠ accepted-residual · ✗ open. MVP needs zero ✗.

| Component | Spoofing | Tampering | Repudiation | Info disclosure | DoS | Elevation |
|-----------|----------|-----------|-------------|-----------------|-----|-----------|
| Worker entry | ✓ TLS + Cloudflare edge | ✓ Zod request validation | ✓ `request_id` + structured logs | ✓ redaction middleware | ⚠ rate limits TBD beyond admin | ✓ scopes |
| Auth + scope gate | ✓ HMAC pepper, not SHA | ✓ key revocation propagates ≤ 60s | ✓ `api_key_id` logged on every request | ✓ key never logged in plaintext | ⚠ KV cache TTL drift | ✓ scope check |
| D1 | ✓ tenant_id required arg in every helper | ✓ CI guard prevents inline SQL | ✓ row created_at columns | ✓ tenant_id WHERE on every read | ✓ row caps (16KB metadata) | ✓ helper layer doesn't escalate |
| Vectorize V2 | ✓ binding tied to env | ✓ Worker constructs filter from authenticated tenant_id | ✓ each upsert has `mutationId` | ✓ tenant_id in metadata; query filter is server-side | ⚠ no per-tenant Vectorize quotas | ✓ no user-supplied filter shape |
| R2 | ✓ binding tied to env | ✓ Worker-proxy only (no presign) | ✓ `source.{ext}` paths are deterministic | ✓ tenant prefix on every key | ⚠ object size limits TBD | ✓ no user-controlled prefix |
| Provider keys + Secrets Store | ✓ HMAC validation | ✓ raw key never re-emitted | ✓ provider_key_id audited | ✓ redaction middleware fuzzed | ⚠ KV fallback in dev | ✓ prod-boot guard |
| Internal back-channel | ✓ HMAC + 5-min window | ✓ body hash in canonical string | ✓ HMAC ts logged | ✓ all calls server-side | ⚠ no message-replay cache (5-min window relies on clock sync) | ✓ ownership verified |
| Container | ✓ HMAC client | ✓ profile YAML built into image | ✓ stage-attempt rows | ✓ no client-supplied secrets | ⚠ container retry storm self-mitigates via DLQ | ✓ runs in own DO instance |

No ✗ entries.

## Residual risks (⚠) — acceptance rationale

- **Per-tenant rate limits beyond admin:** the public `/v1/query` and
  `/v1/documents/:id/ingest` aren't rate-limited at the Worker. We
  rely on Cloudflare's edge protection + AI Gateway's per-key quota.
  If a tenant burns their AIG quota, the next call returns
  `PROVIDER_QUOTA_EXHAUSTED`. Post-MVP: a Worker-side per-tenant token
  bucket if abuse pattern emerges.

- **KV cache TTL drift on revocation:** revoking an API key takes up
  to 60 s to propagate (KV TTL). Documented in design doc §7.1; the
  trade-off is the 90%+ cache hit rate that keeps the auth path fast.

- **No per-tenant Vectorize quotas:** Vectorize V2 doesn't yet expose
  per-tenant rate-limit knobs. We rely on AIG quotas (which gate the
  *embedding* call upstream of Vectorize). Vectorize itself has
  account-wide limits.

- **R2 object size limits:** documented at the upload-presign step
  (`size_bytes` is in the request body), but we don't yet enforce a
  hard cap. Phase 9 work.

- **No back-channel replay cache:** a 5-min HMAC window plus
  body-hash binding means the same exact request can be replayed
  inside that window. The signed body includes `started_at` for
  idempotency at the writer side, so functional impact is bounded.
  Adding a Redis-style nonce store is post-MVP.

- **KV fallback in dev:** `secrets-store.ts` falls back to KV in dev
  when no real Secrets Store binding is present. Prod boot fails
  loudly if this fallback would activate. No user impact.

- **Container retry storm:** a buggy Container that fails repeatedly
  before heartbeat would re-enqueue itself. Mitigated by the
  `attempt_count >= 3 → dead_lettered=1` rule in the queue handler.

## Review checklist exercises

Run before sign-off (per Phase 8.5 step 8.5.3):

- [ ] Provider redaction fuzz: re-run `provider-redaction.test.ts`
      with five novel key shapes (sk-proj-, sk-ant-, sk-anth-, voy-, a
      40-char random). All pass.
- [ ] Tenant isolation: `pnpm test test/security/tenant-isolation.test.ts`
      — 9 probes pass.
- [ ] API-key revocation latency: revoke a key in dev; subsequent
      `/v1/me` returns 401 within 60 s.
- [ ] `__redaction_check` route: in dev `ENABLE_DEBUG_ROUTES=true`,
      route returns 200; flip flag to false, returns 404. Verify via
      `GET /__redaction_check` against a config-gated test deploy.
- [ ] Bulk enrichment-only rate-limit: confirm 11 calls/min returns
      429 (Phase 6.8 test pins it).

## Reviewer sign-off

This file changes over time. The end-of-Phase-8 sign-off requires:

- One outside engineer (not the original authors) reviews this matrix
  and signs in `docs/security/REVIEW_<date>.md`.
- They explicitly note any ✗ they can't justify; sign-off is not
  granted while a ✗ is open.
- They re-run the checklist exercises.
