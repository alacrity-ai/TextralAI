// Build the runtime-agnostic `Bindings` shape from a CF Worker
// `Env`. Spreads the source env onto the result so legacy code that
// reads `c.env.DB`, `c.env.BLOBS`, etc. keeps working through the
// migration period (see `apps/api/src/types.ts` — Env extends
// Bindings).

import type { Env } from '../../types.js';
import type {
  Bindings,
  VectorizeIndexHandle,
  VectorStoreFactory,
} from '../shared/interfaces.js';
import { vectorStoreFor } from '../../retrieval/vector-store.js';
import { D1Db } from './d1-db.js';
import { R2BlobStore } from './r2-blob-store.js';
import { CfKvStore } from './kv-store.js';
import { CfQueueProducer } from './cf-queue.js';
import { DoContainerInvoker } from './do-container-invoker.js';
import { CfBackgroundTasks, NoopBackgroundTasks } from './bg-tasks.js';
import { DigestStreamHasher } from './digest-stream-hasher.js';
import { AeMetricsSink, NoopMetricsSink } from './ae-metrics.js';
import { Fts5SparseSearch } from './fts5-sparse-search.js';

export function buildCfBindings(env: Env, ctx: ExecutionContext | null): Env {
  // The Vectorize binding lives on `env.VECTORIZE_OPENAI_LARGE` (legacy
  // CF binding name); `vectorStoreFor` reads it as `env.vectorize` (the
  // runtime-shared shape). Inject it onto the env handed to the factory
  // so the vectorize-backend branch can find the binding. Without this
  // closure-time merge, `env.vectorize` is undefined and every
  // vectorize-backed namespace upsert/query 400s with
  // "no Vectorize binding is available on this deploy".
  const envWithVectorize: Env = env.VECTORIZE_OPENAI_LARGE
    ? ({
        ...env,
        vectorize: env.VECTORIZE_OPENAI_LARGE as unknown as VectorizeIndexHandle,
      } as Env)
    : env;
  const factory: VectorStoreFactory = {
    forBinding: (b) => vectorStoreFor(envWithVectorize, b),
  };

  const db = new D1Db(env.DB);
  const newShape: Bindings = {
    db,
    blobs: new R2BlobStore(env.BLOBS),
    kv: new CfKvStore(env.CACHE),
    queue: new CfQueueProducer(env.INGEST_QUEUE),
    vectors: factory,
    sparseSearch: new Fts5SparseSearch(db),
    containerInvoker: new DoContainerInvoker(env.INGEST_CONTAINER),
    metrics: env.AE_METRICS ? new AeMetricsSink(env.AE_METRICS) : new NoopMetricsSink(),
    bg: ctx ? new CfBackgroundTasks(ctx) : new NoopBackgroundTasks(),
    hash: new DigestStreamHasher(),
    runtime: 'cf',
    ...(env.AI ? { ai: env.AI } : {}),
    // Cast through `unknown`: the runtime-shared `VectorizeIndexHandle`
    // declares a wider `filter?: unknown` parameter, which CF's
    // `Vectorize.query(filter: VectorizeVectorMetadataFilter)` is not
    // strict-function-type-assignable to (parameter contravariance).
    // The values are structurally compatible at runtime — the cast
    // bridges the variance gap between the structural shape and the
    // narrower CF type.
    ...(env.VECTORIZE_OPENAI_LARGE
      ? { vectorize: env.VECTORIZE_OPENAI_LARGE as unknown as VectorizeIndexHandle }
      : {}),
    runtimeEnv: env.ENV,
    apiKeyPepper: env.API_KEY_PEPPER,
    ...(env.INTERNAL_HMAC_SECRET ? { internalHmacSecret: env.INTERNAL_HMAC_SECRET } : {}),
    ...(env.ADMIN_BOOTSTRAP_TOKEN ? { adminBootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN } : {}),
    ...(env.AUDIT_HASH_SALT ? { auditHashSalt: env.AUDIT_HASH_SALT } : {}),
    ...(env.WORKER_INTERNAL_URL ? { workerInternalUrl: env.WORKER_INTERNAL_URL } : {}),
    ...(env.AI_GATEWAY_BYPASS !== 'true' && env.CF_ACCOUNT_ID && env.AI_GATEWAY_ID
      ? {
          aiGateway: {
            baseUrl: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}`,
            metadataHeaderPrefix: 'cf-aig-' as const,
            // Each provider's gateway segment must match what
            // Cloudflare AI Gateway publishes — and crucially,
            // include the provider's API-version subpath when the
            // gateway expects it. Concrete URL composition is
            // `${baseUrl}/${segment}/${path}`, where `path` is
            // whatever the provider adapter's `post(...)` call sends.
            //
            // OpenAI: gateway STRIPS `/v1/` (special-cased upstream),
            //   so segment='openai' and adapter path='chat/completions'.
            // Anthropic: keeps `v1/` — but the adapter already prepends
            //   it on the path side, so segment='anthropic' is fine.
            // Voyage: segment is published as `voyageai` (not `voyage`)
            //   AND keeps `/v1/`. Voyage adapter sends path='rerank' and
            //   directBaseUrl=`api.voyageai.com/v1`, so we encode `v1`
            //   into the gateway segment to match `<gw>/voyageai/v1/rerank`.
            // Cohere: keeps `/v2/`. Cohere adapter directBaseUrl ends
            //   in `/v2`, so we mirror that into the gateway segment.
            // workers_ai: published as `workers-ai`.
            providerSegment: (p: string) => {
              switch (p) {
                case 'workers_ai':
                  return 'workers-ai';
                case 'voyage':
                  return 'voyageai/v1';
                case 'cohere':
                  return 'cohere/v2';
                default:
                  return p;
              }
            },
          },
        }
      : {}),
    ...(env.QDRANT_URL ? { qdrantUrl: env.QDRANT_URL } : {}),
    ...(env.QDRANT_API_KEY ? { qdrantApiKey: env.QDRANT_API_KEY } : {}),
    ...(env.PINECONE_API_KEY ? { pineconeApiKey: env.PINECONE_API_KEY } : {}),
  };

  // Spread the source env onto the new shape so legacy `c.env.DB` /
  // `c.env.BLOBS` / etc. accessors keep working until each call site
  // migrates to `c.env.db` / `c.env.blobs` / etc.
  return { ...env, ...newShape } as Env;
}
