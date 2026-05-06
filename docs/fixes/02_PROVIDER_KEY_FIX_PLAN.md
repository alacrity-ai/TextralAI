# Fix Plan 02 — Provider-key resolution consolidation

> Resolves audit finding §2: four near-clones of "look up a provider
> key" with three different return shapes and two different "key not
> found" semantics. Phase 5 added a try/catch wrapper around one of
> them to swallow `BAD_REQUEST` because the rerank-config path
> *expects* "no key" to be a normal state.

## Goal

One `resolveProviderKey(env, tenantId, lookup, opts)` function with:

- A discriminated `KeyLookup` input type (id / ref / optional_ref).
- A single result shape (`{ id, raw_key?, meta }`).
- Optional-ref returns `null` instead of throwing when the lookup
  doesn't supply enough info — eliminates exception-as-control-flow.

## Files

**New:**
- `apps/api/src/auth/provider-key-resolver.ts` — the unified function.

**Edit:**
- `apps/api/src/auth/provider-keys.ts` — delete `resolveProviderKey`
  and `resolveProviderKeyById`; re-export the new one for legacy
  consumers (provider-keys route uses one for "test this key").
- `apps/api/src/ingestion/dispatch.ts` — `resolveProviderKey` becomes
  a thin call to the new function with `KeyLookup` shape.
- `apps/api/src/routes/query.ts` — same. The Phase 5 try/catch
  workaround for rerank deletes.
- `apps/api/src/routes/internal/providers.ts` — embedding key
  resolution becomes a one-liner.

## Interface

```ts
export type KeyLookup =
  | { kind: 'id'; provider: string; id: string }
  | { kind: 'ref'; provider: string; ref: string }
  | { kind: 'either'; provider: string; id?: string; ref?: string }    // throws if both missing
  | { kind: 'optional_ref'; provider: string; ref?: string };           // returns null if missing

export interface ResolveOpts {
  /** When true, the helper also fetches the raw key from Secrets
   *  Store. Default false (most call sites just need the ID). */
  include_raw?: boolean;
  /** Workers AI binding tier has no key — short-circuit with a
   *  sentinel id so call sites don't have to special-case. Default
   *  true. */
  short_circuit_workers_ai?: boolean;
}

export interface ResolvedKey {
  id: string;
  /** Only populated when include_raw=true. */
  raw_key?: string;
  meta: {
    provider: string;
    label: string;
    secrets_store_secret_name: string;
  };
}

export async function resolveProviderKey(
  env: Env,
  tenant_id: string,
  lookup: KeyLookup,
  opts?: ResolveOpts,
): Promise<ResolvedKey | null>;
```

### Behavior matrix

| Lookup kind | Found | Not found | Insufficient info |
|---|---|---|---|
| `id` | returns | throws `PROVIDER_KEY_NOT_FOUND` | n/a (id is required) |
| `ref` | returns | throws `PROVIDER_KEY_NOT_FOUND` | n/a (ref is required) |
| `either` | returns | throws `PROVIDER_KEY_NOT_FOUND` | throws `BAD_REQUEST` |
| `optional_ref` | returns | returns `null` | returns `null` |

The Phase-5 rerank path uses `optional_ref` and deletes its
try/catch.

## What's NOT in scope

- Caching key lookups within a request — D1 + KV are already cheap;
  Phase 6+ if profiling shows it's worth it.
- Audit-mode redaction of `raw_key` in error logs — that's the
  Phase-1.6 redaction middleware's job, not this resolver's.

## Tests

- `apps/api/test/provider-key-resolver.test.ts` (new):
  - Each `KeyLookup` shape × found/not-found/insufficient → expected
    return / throw.
  - `include_raw=true` returns Secrets Store value; `false` doesn't.
  - `short_circuit_workers_ai=true` returns the synthetic
    `__workers_ai_no_key__` ID without hitting D1.
- Existing `provider-keys.test.ts`, `query-route.test.ts`, and the
  ingestion dispatch tests continue passing.

## Acceptance

- `pnpm --filter @textral/api typecheck` clean.
- `pnpm --filter @textral/api test` green.
- Both live e2es green.
- `grep -rEn 'function resolveProviderKey' apps/api/src/` returns
  exactly one hit.
- `grep -rEn 'try {.*resolveProviderKey' apps/api/src/` returns zero
  hits.

## Sequencing

Best done after §3 (D1 helpers) since the new resolver should reach
`db/provider-keys.ts` for its lookups instead of inline SQL. Becomes
a prereq for §5 (query.ts pipeline split): the rerank-stage extract
is much cleaner once the try/catch is gone.
