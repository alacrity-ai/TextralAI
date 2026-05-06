// Backwards-compat shim around the new VectorStore abstraction
// (vector-store.ts). Existing callers (hybrid.ts) get the same
// `denseQuery(env, args)` signature; the abstraction picks the
// right adapter for the given VectorBinding.

import type { Env } from '../types.js';
import type { DenseFilter, DenseHit, VectorBinding } from './vector-store.js';

export type { DenseHit };

export interface DenseQueryArgs {
  vector: number[];
  topK: number;
  filter: DenseFilter;
  /** V3 Phase 1: fully describes the backing store. Resolved by
   *  the route handler from the namespace + version_index rows. */
  binding: VectorBinding;
}

export async function denseQuery(env: Env, args: DenseQueryArgs): Promise<DenseHit[]> {
  const store = env.vectors.forBinding(args.binding);
  return await store.query(args.vector, { topK: args.topK, filter: args.filter });
}
