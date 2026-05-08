// Secrets Store helpers + the provider-key resolver.
//
// Every BYOK provider key is stored under a deterministic name:
//   pkey-{tenant_id}-{provider}-{label}
//
// Phase 1 limitation: a Cloudflare Secrets Store binding requires the
// deploy-time API token to have store permissions, which the dev token
// doesn't. Until that's resolved the secrets ride on top of KV, which
// IS bound. The behavioral contract is identical (write-once, read-many,
// deterministic names) so swapping in a real Secrets Store binding
// later is a one-file change.
//
// Tests use an in-process Map: KV doesn't auto-emulate, but tests need
// the same write/read shape, so the helper detects the absence of CACHE
// and falls back to a Map kept on the env object.

import type { Env } from '../types.js';

interface SecretsStoreClient {
  put(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
}

// In-memory test-only client. Kept on the env so it survives across
// route invocations within a single test.
const TEST_STORE_KEY = '__TEST_PROVIDER_KEY_STORE__';

function getTestStore(env: Env): Map<string, string> {
  const e = env as unknown as Record<string, unknown>;
  let store = e[TEST_STORE_KEY] as Map<string, string> | undefined;
  if (!store) {
    store = new Map();
    e[TEST_STORE_KEY] = store;
  }
  return store;
}

const KV_PREFIX = 'pkey/';

export function getSecretsStoreClient(env: Env): SecretsStoreClient {
  // If a test has installed an in-process override map, prefer it over
  // KV so that test-side stubs work transparently.
  const e = env as unknown as Record<string, unknown>;
  const testMap = e[TEST_STORE_KEY] as Map<string, string> | undefined;
  if (testMap) {
    return {
      async put(name, value) {
        testMap.set(name, value);
      },
      async get(name) {
        return testMap.get(name) ?? null;
      },
      async delete(name) {
        testMap.delete(name);
      },
    };
  }
  // Presence detection via the runtime-shared `KvStore` shape.
  // When the runtime binds a real KV (CF: KVNamespace; Node: ioredis),
  // `env.kv.put` is a function. When tests run without a KV binding
  // the runtime adapter still supplies a `KvStore` instance, but in
  // the cf-pool test path `env.CACHE` is unbound and the constructor
  // wraps `undefined` — which surfaces as `env.kv.put` being a
  // function but throwing on call. The legacy probe sniffed
  // `env.CACHE` directly; the V3 Phase 2 shape sniffs the abstracted
  // adapter instead.
  const kv = env.kv;
  if (!kv || typeof kv.put !== 'function') {
    // PROD GUARD (audit §7 / smaller finding #7): the silent
    // fallback to in-process Map is fine for tests, dangerous in
    // prod (provider keys evaporate between isolates). Refuse to
    // boot rather than silently downgrade.
    if (env.runtimeEnv === 'prod') {
      throw new Error(
        'SECRETS_STORE_UNAVAILABLE: runtimeEnv=prod requires a KV binding (CF) ' +
          'or Redis (Node). The in-process Map fallback is dev/test only.',
      );
    }
    return {
      async put(name, value) {
        getTestStore(env).set(name, value);
      },
      async get(name) {
        return getTestStore(env).get(name) ?? null;
      },
      async delete(name) {
        getTestStore(env).delete(name);
      },
    };
  }
  return {
    async put(name, value) {
      await kv.put(KV_PREFIX + name, value);
    },
    async get(name) {
      return (await kv.get(KV_PREFIX + name)) ?? null;
    },
    async delete(name) {
      await kv.delete(KV_PREFIX + name);
    },
  };
}

export function providerKeySecretName(tenantId: string, provider: string, label: string): string {
  return `pkey-${tenantId}-${provider}-${label}`;
}

/** Distinct prefix from `pkey-` so the two key kinds can never collide
 *  in the underlying KV — even if a tenant registers a provider-key
 *  with provider='pinecone' (which would be rejected upstream by the
 *  ProviderName enum, but defense in depth costs nothing). */
export function infraKeySecretName(tenantId: string, provider: string, label: string): string {
  return `ikey-${tenantId}-${provider}-${label}`;
}
