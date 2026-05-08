// Vendor-agnostic vector store abstraction. Three backends today:
// Vectorize (CF), Qdrant (self-host or Qdrant Cloud), Pinecone
// (managed). Each implements the `VectorStore` interface. The
// selector picks an adapter based on the `VectorBinding` the
// caller hands in (resolved from a namespace or version_index row).

import { TextralError } from '@textral/contracts';
import type { Env } from '../types.js';
import { VectorizeV2Adapter } from './adapters/vectorize.js';
import { QdrantAdapter } from './adapters/qdrant.js';
import { PineconeAdapter } from './adapters/pinecone.js';

export type VectorBackend = 'vectorize' | 'qdrant' | 'pinecone';

export interface VectorBinding {
  backend: VectorBackend;
  /** Backend-meaningful handle. Vectorize: ignored. Qdrant: collection name.
   *  Pinecone: full host URL (https://....pinecone.io). */
  index_name: string | null;
  /** Vector dimensionality. Used for collection creation in Qdrant
   *  and verification in Pinecone. */
  embedding_dimensions: number;
  /** Vector-store-side partition handle.
   *  Pinecone: native namespace inside the index — many Textral namespaces
   *  can share one Pinecone index by varying this field. Empty string means
   *  Pinecone's default (unnamed) namespace.
   *  Qdrant / Vectorize: ignored (null). */
  namespace: string | null;
  /** Tenant-resolved Pinecone API key. Pre-resolved at the call site
   *  via `resolveInfraKey(env, tenantId, 'pinecone')` and passed in
   *  rather than fetched inside the factory — keeps `vectorStoreFor`
   *  synchronous. Required when `backend === 'pinecone'`; absent for
   *  other backends. */
  pineconeApiKey?: string;
}

export interface VectorMetadata {
  tenant_id: string;
  namespace_id: string;
  document_id: string;
  version_id: string;
  version_index_id: string;
  artifact_type: string;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface DenseFilter {
  tenant_id: string;
  namespace_id: string;
  version_id?: { $in: string[] } | string;
  artifact_type?: { $in: string[] } | string;
}

export interface DenseHit {
  chunk_id: string;
  score: number;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<{ mutation_id: string | null }>;
  query(
    vector: number[],
    opts: { topK: number; filter: DenseFilter },
  ): Promise<DenseHit[]>;
  deleteByIds(ids: string[]): Promise<{ count: number }>;
  /** Idempotent backing-resource creation. Called once at namespace
   *  create time. Adapters that need no provisioning (Vectorize)
   *  return immediately. */
  ensureBackingExists?(): Promise<void>;
}

export function vectorStoreFor(env: Env, binding: VectorBinding): VectorStore {
  switch (binding.backend) {
    case 'vectorize': {
      // V3 Phase 2: read the Vectorize handle from `bindings.vectorize`
      // (populated by the CF runtime adapter). Self-host mode rejects
      // this backend at namespace-create time, but guard here too.
      if (!env.vectorize) {
        throw new TextralError(
          'BAD_REQUEST',
          400,
          'Vectorize backend selected but no Vectorize binding is available on this deploy',
        );
      }
      return new VectorizeV2Adapter(env.vectorize);
    }
    case 'qdrant': {
      // `QDRANT_URL` is declared in `[env.dev.vars]` as `""` to mark
      // "Qdrant backend not enabled on this deploy". Empty string is
      // falsy, so `!env.QDRANT_URL` covers both unset and empty.
      if (!env.QDRANT_URL) {
        throw new TextralError(
          'BAD_REQUEST',
          400,
          'Qdrant backend selected but QDRANT_URL is unset on this deploy',
        );
      }
      if (!binding.index_name) {
        throw new TextralError(
          'BAD_REQUEST',
          400,
          'Qdrant backend requires vector_index_name (collection name)',
        );
      }
      return new QdrantAdapter({
        url: env.QDRANT_URL,
        ...(env.QDRANT_API_KEY ? { apiKey: env.QDRANT_API_KEY } : {}),
        collection: binding.index_name,
        dimensions: binding.embedding_dimensions,
      });
    }
    case 'pinecone': {
      // Per-tenant credential. Caller resolves it via
      // `resolveInfraKey(env, tenantId, 'pinecone')` and threads it
      // into the binding before invoking the factory. The previous
      // path read a `PINECONE_API_KEY` worker secret — replaced by
      // tenant-scoped infra_keys (see migration 0011).
      if (!binding.pineconeApiKey) {
        throw new TextralError(
          'INFRA_KEY_NOT_FOUND',
          400,
          'Pinecone backend requires a tenant-registered infra key. Register one via POST /v1/infra-keys (provider=pinecone).',
        );
      }
      if (!binding.index_name) {
        throw new TextralError(
          'BAD_REQUEST',
          400,
          'Pinecone backend requires vector_index_name (full index host URL)',
        );
      }
      return new PineconeAdapter({
        host: binding.index_name,
        apiKey: binding.pineconeApiKey,
        dimensions: binding.embedding_dimensions,
        // Empty string and null both mean "use Pinecone's default
        // unnamed namespace" — adapter reads `cfg.namespace` and
        // omits the field on the wire when falsy.
        namespace: binding.namespace ?? null,
      });
    }
    default: {
      // Compile-time exhaustiveness guard: if `VectorBackend` gains a
      // new variant without a corresponding case above, TS flags this.
      const _exhaustive: never = binding.backend;
      throw new Error(`Unhandled vector backend: ${String(_exhaustive)}`);
    }
  }
}
