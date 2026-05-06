// Hybrid retrieval orchestrator.
//
// Promise.allSettled across dense + sparse arms. Single-arm failure
// degrades to the surviving arm; both failing → RETRIEVAL_FAILED.

import { TextralError } from '@textral/contracts';
import type { Env } from '../types.js';
import { buildFts5Match } from './fts5-query.js';
import { denseQuery } from './vectorize-query.js';
import { rrf, type FusedHit } from './rrf.js';
import { countMissingEmbeddings } from '../db/chunks.js';
import type { VectorBinding } from './vector-store.js';

export type RetrievalStatus = 'full' | 'dense_only' | 'sparse_only' | 'empty';

export interface HybridArgs {
  /** Pre-computed query embedding. The query path runs the embed call
   *  via the Phase 2 provider abstraction before invoking us. */
  query_vector: number[];
  /** Raw query string for sparse arm. */
  query_text: string;
  tenant_id: string;
  namespace_id: string;
  version_ids: string[];
  artifact_types: string[];
  top_k_dense: number;
  top_k_sparse: number;
  rrf_k: number;
  embedding_status_filter?: 'embedded' | 'all';
  /** V3 Phase 1 — picks the dense-arm vector store. */
  binding: VectorBinding;
}

export interface HybridResult {
  candidates: FusedHit[];
  retrieval_status: RetrievalStatus;
  dense_count: number;
  sparse_count: number;
  embedding_missing_count: number;
}

interface SparseRow {
  id: string;
  score: number;
}

export async function runHybridRetrieval(env: Env, args: HybridArgs): Promise<HybridResult> {
  const denseFilter = {
    tenant_id: args.tenant_id,
    namespace_id: args.namespace_id,
    version_id: { $in: args.version_ids },
    artifact_type: { $in: args.artifact_types },
  };

  const matchExpr = buildFts5Match(args.query_text);

  const [denseRes, sparseRes] = await Promise.allSettled([
    denseQuery(env, {
      vector: args.query_vector,
      topK: args.top_k_dense,
      filter: denseFilter,
      binding: args.binding,
    }),
    sparseSearch(env, {
      tenant_id: args.tenant_id,
      namespace_id: args.namespace_id,
      version_ids: args.version_ids,
      artifact_types: args.artifact_types,
      match: matchExpr,
      top_k: args.top_k_sparse,
    }),
  ]);

  const dense = denseRes.status === 'fulfilled' ? denseRes.value : [];
  const sparse = sparseRes.status === 'fulfilled' ? sparseRes.value : [];

  const denseOk = denseRes.status === 'fulfilled';
  const sparseOk = sparseRes.status === 'fulfilled';
  let retrieval_status: RetrievalStatus;
  if (!denseOk && !sparseOk) {
    throw new TextralError('RETRIEVAL_FAILED', 503, 'Both retrieval arms failed', {
      dense_error: extractError(denseRes),
      sparse_error: extractError(sparseRes),
    });
  } else if (denseOk && sparseOk) {
    retrieval_status = 'full';
  } else if (denseOk) {
    retrieval_status = 'dense_only';
  } else {
    retrieval_status = 'sparse_only';
  }

  if (dense.length === 0 && sparse.length === 0) {
    return {
      candidates: [],
      retrieval_status: 'empty',
      dense_count: 0,
      sparse_count: 0,
      embedding_missing_count: 0,
    };
  }

  const arms: Array<Array<{ chunk_id: string }>> = [];
  if (dense.length > 0) arms.push(dense);
  if (sparse.length > 0) arms.push(sparse.map((s) => ({ chunk_id: s.id })));
  const fused = rrf(arms, { k: args.rrf_k });

  const missing = await countMissingEmbeddings(env.db, args.tenant_id, args.version_ids);

  return {
    candidates: fused,
    retrieval_status,
    dense_count: dense.length,
    sparse_count: sparse.length,
    embedding_missing_count: missing,
  };
}

interface SparseArgs {
  tenant_id: string;
  namespace_id: string;
  version_ids: string[];
  artifact_types: string[];
  match: string;
  top_k: number;
}

async function sparseSearch(env: Env, args: SparseArgs): Promise<SparseRow[]> {
  return await env.sparseSearch.search(args);
}

function extractError(p: PromiseSettledResult<unknown>): string | null {
  if (p.status === 'rejected') {
    const err = p.reason as { message?: string } | undefined;
    return err?.message ?? String(p.reason);
  }
  return null;
}
