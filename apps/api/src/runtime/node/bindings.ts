// Build the runtime-agnostic `Bindings` shape from a Node
// `process.env` for the self-host deployment. Mirrors
// `runtime/cf/bindings.ts` — both produce an `Env`-typed object so
// the Hono app (`apps/api/src/app.ts`) can run unchanged.
//
// Connection lifecycles (pgPool, redis, s3) are owned by the
// returned `NodeRuntimeContext`. The entrypoint (`index.ts`) and
// the consumer (`workers/ingest-consumer.ts`) close them on
// SIGTERM. Buildling these per-process (not per-request) is the
// whole point — connection pools amortize across requests.

import { Pool } from 'pg';
import Redis from 'ioredis';
import { S3Client } from '@aws-sdk/client-s3';
import type {
  Bindings,
  VectorStoreFactory,
} from '../shared/interfaces.js';
import { vectorStoreFor, type VectorBinding } from '../../retrieval/vector-store.js';
import type { Env } from '../../types.js';
import { PgDb } from './pg-db.js';
import { PgSparseSearch } from './pg-sparse-search.js';
import { S3BlobStore } from './s3-blob-store.js';
import { RedisKvStore } from './redis-kv.js';
import { RedisQueueProducer } from './redis-queue.js';
import { HttpContainerInvoker } from './http-container-invoker.js';
import { NodeBackgroundTasks } from './bg-tasks.js';
import { NodeCryptoHasher } from './node-crypto-hasher.js';
import { StdoutMetricsSink } from './stdout-metrics.js';

export interface NodeRuntimeContext {
  /** The Env-shaped binding object the Hono app consumes. Includes
   *  both the runtime-agnostic `Bindings` slots (lowercase) and the
   *  legacy CF-binding-typed uppercase fields that a few unmigrated
   *  consumers still read directly (e.g., `env.API_KEY_PEPPER` in
   *  `auth/pepper.ts`, `env.QDRANT_URL` in `retrieval/vector-store.ts`). */
  bindings: Env;
  /** BackgroundTasks adapter — exposed so the SIGTERM handler can
   *  call `bg.drain()` before tearing down the pool. */
  bg: NodeBackgroundTasks;
  /** Owned resources — close on shutdown. */
  pgPool: Pool;
  redis: Redis;
  s3: S3Client;
}

function buildPool(env: NodeJS.ProcessEnv): Pool {
  if (env.POSTGRES_URL) {
    return new Pool({
      connectionString: env.POSTGRES_URL,
      max: Number(env.POSTGRES_MAX_CONNECTIONS ?? 10),
    });
  }
  return new Pool({
    host: env.POSTGRES_HOST ?? 'localhost',
    port: Number(env.POSTGRES_PORT ?? 5432),
    user: env.POSTGRES_USER ?? 'textral',
    password: env.POSTGRES_PASSWORD ?? 'textral_dev',
    database: env.POSTGRES_DB ?? 'textral',
    max: Number(env.POSTGRES_MAX_CONNECTIONS ?? 10),
  });
}

export function buildNodeBindings(env: NodeJS.ProcessEnv): NodeRuntimeContext {
  const pgPool = buildPool(env);
  const redis = new Redis(env.REDIS_URL ?? 'redis://localhost:6379');
  const s3 = new S3Client({
    endpoint: env.MINIO_ENDPOINT ?? 'http://localhost:9000',
    region: env.S3_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: env.MINIO_ROOT_USER ?? 'textral',
      secretAccessKey: env.MINIO_ROOT_PASSWORD ?? 'textral_dev',
    },
    forcePathStyle: true,
  });

  // The factory closure needs `env.QDRANT_URL` / `env.PINECONE_API_KEY`
  // (uppercase, legacy). We forward those from process.env onto a
  // partial Env shape — `vectorStoreFor` only reads the fields its
  // selected backend needs; vectorize is gated at namespace-create
  // (Phase 2 Step 14) so it never reaches the factory in self-host.
  const factory: VectorStoreFactory = {
    forBinding: (b: VectorBinding) =>
      vectorStoreFor(
        {
          QDRANT_URL: env.QDRANT_URL ?? '',
          ...(env.QDRANT_API_KEY ? { QDRANT_API_KEY: env.QDRANT_API_KEY } : {}),
          ...(env.PINECONE_API_KEY ? { PINECONE_API_KEY: env.PINECONE_API_KEY } : {}),
        } as unknown as Env,
        b,
      ),
  };

  const bg = new NodeBackgroundTasks();
  const db = new PgDb(pgPool);

  const newShape: Bindings = {
    db,
    blobs: new S3BlobStore(s3, env.MINIO_BUCKET ?? 'textral-blobs'),
    kv: new RedisKvStore(redis),
    queue: new RedisQueueProducer(redis),
    vectors: factory,
    sparseSearch: new PgSparseSearch(db),
    containerInvoker: new HttpContainerInvoker({
      host: env.CONTAINER_HOST ?? 'ingest',
      ...(env.CONTAINER_PORT ? { port: Number(env.CONTAINER_PORT) } : {}),
    }),
    metrics: new StdoutMetricsSink(),
    bg,
    hash: new NodeCryptoHasher(),
    runtime: 'node',
    // `ai` and `vectorize` deliberately omitted — Node deploys are
    // BYOK for inference (workers_ai 501s on absence) and use
    // qdrant/pinecone for vectors (vectorize gated at namespace
    // create — Phase 2 Step 14).
    runtimeEnv: 'self-host',
    apiKeyPepper: env.API_KEY_PEPPER ?? '',
    ...(env.INTERNAL_HMAC_SECRET ? { internalHmacSecret: env.INTERNAL_HMAC_SECRET } : {}),
    ...(env.ADMIN_BOOTSTRAP_TOKEN ? { adminBootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN } : {}),
    ...(env.AUDIT_HASH_SALT ? { auditHashSalt: env.AUDIT_HASH_SALT } : {}),
    ...(env.WORKER_INTERNAL_URL ? { workerInternalUrl: env.WORKER_INTERNAL_URL } : {}),
    ...(env.AI_GATEWAY_BASE_URL
      ? {
          aiGateway: {
            baseUrl: env.AI_GATEWAY_BASE_URL,
            metadataHeaderPrefix: 'x-aig-' as const,
            providerSegment: (p: string) => p,
          },
        }
      : {}),
    ...(env.QDRANT_URL ? { qdrantUrl: env.QDRANT_URL } : {}),
    ...(env.QDRANT_API_KEY ? { qdrantApiKey: env.QDRANT_API_KEY } : {}),
    ...(env.PINECONE_API_KEY ? { pineconeApiKey: env.PINECONE_API_KEY } : {}),
  };

  // Build the Env-shaped object the Hono app expects. Lowercase
  // `Bindings` slots from `newShape`, plus uppercase legacy fields
  // populated from process.env for the consumers that haven't
  // migrated to `c.env.<lowercase>` yet:
  //   - `env.API_KEY_PEPPER`        (auth/pepper.ts — string|SecretsStore detection)
  //   - `env.QDRANT_URL/_API_KEY`   (retrieval/vector-store.ts)
  //   - `env.PINECONE_API_KEY`      (retrieval/vector-store.ts)
  //   - `env.AUDIT_HASH_SALT`       (audit/query-events.ts)
  //   - `env.INTERNAL_HMAC_SECRET`  (middleware/internal-auth.ts)
  //   - `env.ADMIN_BOOTSTRAP_TOKEN` (routes/admin/bootstrap.ts)
  //   - `env.ENABLE_DEBUG_ROUTES`   (3 dev routes — left empty so they 404)
  // The CF-only fields (DB, BLOBS, INGEST_QUEUE, AI, VECTORIZE_*,
  // INGEST_CONTAINER, AE_METRICS, CF_ACCOUNT_ID, AI_GATEWAY_ID) are
  // omitted; Node never exercises them. The `as unknown as Env`
  // cast bridges the structural gap during the Phase-2 cohabitation
  // period (mirrors `runtime/cf/bindings.ts:77`).
  const envShaped = {
    ...newShape,
    ENV: 'prod' as const,
    ENABLE_DEBUG_ROUTES: env.ENABLE_DEBUG_ROUTES ?? '',
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS ?? '',
    CF_ACCOUNT_ID: '',
    AI_GATEWAY_ID: '',
    API_KEY_PEPPER: env.API_KEY_PEPPER ?? '',
    ...(env.AUDIT_HASH_SALT ? { AUDIT_HASH_SALT: env.AUDIT_HASH_SALT } : {}),
    ...(env.INTERNAL_HMAC_SECRET ? { INTERNAL_HMAC_SECRET: env.INTERNAL_HMAC_SECRET } : {}),
    ...(env.ADMIN_BOOTSTRAP_TOKEN ? { ADMIN_BOOTSTRAP_TOKEN: env.ADMIN_BOOTSTRAP_TOKEN } : {}),
    ...(env.WORKER_INTERNAL_URL ? { WORKER_INTERNAL_URL: env.WORKER_INTERNAL_URL } : {}),
    ...(env.QDRANT_URL ? { QDRANT_URL: env.QDRANT_URL } : {}),
    ...(env.QDRANT_API_KEY ? { QDRANT_API_KEY: env.QDRANT_API_KEY } : {}),
    ...(env.PINECONE_API_KEY ? { PINECONE_API_KEY: env.PINECONE_API_KEY } : {}),
    // Phase A — self-service tenant registration. `services/mailgun.ts`
    // short-circuits when MAILGUN_API_KEY/DOMAIN are missing, so
    // self-host operators who don't want this flow leave them unset
    // and `/v1/auth/register` becomes a no-op (the route layer further
    // gates on prod env).
    ...(env.MAILGUN_API_KEY ? { MAILGUN_API_KEY: env.MAILGUN_API_KEY } : {}),
    ...(env.MAILGUN_DOMAIN ? { MAILGUN_DOMAIN: env.MAILGUN_DOMAIN } : {}),
    ...(env.MAILGUN_FROM ? { MAILGUN_FROM: env.MAILGUN_FROM } : {}),
    ...(env.MAILGUN_BASE_URL ? { MAILGUN_BASE_URL: env.MAILGUN_BASE_URL } : {}),
    ...(env.TEXTRAL_PUBLIC_BASE ? { TEXTRAL_PUBLIC_BASE: env.TEXTRAL_PUBLIC_BASE } : {}),
    ...(env.RATE_LIMIT_IP_SALT ? { RATE_LIMIT_IP_SALT: env.RATE_LIMIT_IP_SALT } : {}),
  } as unknown as Env;

  return { bindings: envShaped, bg, pgPool, redis, s3 };
}
