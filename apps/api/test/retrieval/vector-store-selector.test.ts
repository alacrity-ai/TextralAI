// V3 Phase 1 — pin the dispatcher behavior in `vectorStoreFor()`:
//   - vectorize / qdrant / pinecone return the right adapter class
//   - missing operator config (QDRANT_URL / PINECONE_API_KEY) → 400
//   - missing per-namespace vector_index_name → 400
//
// Mocks `Env` directly (no cloudflare:test) — the selector is pure
// dispatch logic; we don't need a worker runtime to exercise it.

import { describe, it, expect } from 'vitest';
import { vectorStoreFor } from '../../src/retrieval/vector-store.js';
import type { VectorBinding } from '../../src/retrieval/vector-store.js';
import { VectorizeV2Adapter } from '../../src/retrieval/adapters/vectorize.js';
import { QdrantAdapter } from '../../src/retrieval/adapters/qdrant.js';
import { PineconeAdapter } from '../../src/retrieval/adapters/pinecone.js';
import type { Env } from '../../src/types.js';

function envWith(overrides: Partial<Env> = {}): Env {
  // Test stub. The selector only reads vector-backend env fields;
  // cast through `unknown` so the Phase-2 expanded Env extends
  // Bindings shape (db, blobs, kv, ...) doesn't require populating
  // adapter mocks here.
  const vectorizeMock = { __id: 'vectorize-mock' };
  return {
    ENV: 'dev',
    ENABLE_DEBUG_ROUTES: 'false',
    ALLOWED_ORIGINS: '*',
    CF_ACCOUNT_ID: 'acc',
    AI_GATEWAY_ID: 'gw',
    DB: {} as D1Database,
    BLOBS: {} as R2Bucket,
    INGEST_QUEUE: {} as Queue<unknown>,
    VECTORIZE_OPENAI_LARGE: vectorizeMock as unknown as Vectorize,
    // V3 Phase 2 G-2: vectorStoreFor reads `env.vectorize` (the
    // structural Bindings field) instead of the legacy CF binding.
    // Stub it with the same mock so the selector resolves a Vectorize
    // adapter when the backend is 'vectorize'.
    vectorize: vectorizeMock,
    CACHE: {} as KVNamespace,
    API_KEY_PEPPER: 'pepper',
    INGEST_CONTAINER: {} as DurableObjectNamespace,
    AI: {} as Ai,
    QDRANT_URL: '',
    ...overrides,
  } as unknown as Env;
}

const dims = 1536;

describe('vectorStoreFor()', () => {
  describe('vectorize backend', () => {
    it('returns VectorizeV2Adapter regardless of QDRANT_URL / PINECONE_API_KEY', () => {
      const binding: VectorBinding = {
        backend: 'vectorize',
        index_name: null,
        embedding_dimensions: dims,
        namespace: null,
      };
      const store = vectorStoreFor(envWith(), binding);
      expect(store).toBeInstanceOf(VectorizeV2Adapter);
    });
  });

  describe('qdrant backend', () => {
    const binding: VectorBinding = {
      backend: 'qdrant',
      index_name: 'my-collection',
      embedding_dimensions: dims,
      namespace: null,
    };

    it('throws BAD_REQUEST when QDRANT_URL is empty/unset on the deploy', () => {
      expect(() => vectorStoreFor(envWith({ QDRANT_URL: '' }), binding)).toThrow(
        /QDRANT_URL is unset/i,
      );
    });

    it('throws BAD_REQUEST when binding lacks vector_index_name', () => {
      const noIdx: VectorBinding = { ...binding, index_name: null };
      expect(() =>
        vectorStoreFor(envWith({ QDRANT_URL: 'http://q:6333' }), noIdx),
      ).toThrow(/requires vector_index_name/i);
    });

    it('returns QdrantAdapter when both env + binding are populated', () => {
      const store = vectorStoreFor(
        envWith({ QDRANT_URL: 'http://q:6333', QDRANT_API_KEY: 'k' }),
        binding,
      );
      expect(store).toBeInstanceOf(QdrantAdapter);
    });
  });

  describe('pinecone backend', () => {
    // Migration to per-tenant infra keys (table 0011): the factory
    // reads the resolved Pinecone API key from `binding.pineconeApiKey`,
    // which the call site populates via `resolveVectorBinding(env,
    // tenantId, ...)`. The old `env.PINECONE_API_KEY` worker-secret
    // path was removed.
    const binding: VectorBinding = {
      backend: 'pinecone',
      index_name: 'https://idx.svc.us-east-1.pinecone.io',
      embedding_dimensions: dims,
      namespace: 'lighthouse-tales',
      pineconeApiKey: 'pcsk_test',
    };

    it('throws INFRA_KEY_NOT_FOUND when binding lacks pineconeApiKey', () => {
      const noKey: VectorBinding = { ...binding };
      delete noKey.pineconeApiKey;
      expect(() => vectorStoreFor(envWith(), noKey)).toThrow(
        /tenant-registered infra key/i,
      );
    });

    it('throws BAD_REQUEST when binding lacks vector_index_name', () => {
      const noIdx: VectorBinding = { ...binding, index_name: null };
      expect(() => vectorStoreFor(envWith(), noIdx)).toThrow(/requires vector_index_name/i);
    });

    it('returns PineconeAdapter when binding carries the resolved api key', () => {
      const store = vectorStoreFor(envWith(), binding);
      expect(store).toBeInstanceOf(PineconeAdapter);
    });
  });
});
