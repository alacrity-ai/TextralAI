// Cloudflare Vectorize V2 adapter. The V2 API returns
// `{ mutationId }` (V1 returned `{ ids, count }` and is being
// deprecated). The binding handle is supplied at Bindings-build time
// by the CF runtime (`bindings.vectorize = env.VECTORIZE_OPENAI_LARGE`)
// and read by the factory in `runtime/cf/bindings.ts`. This class
// doesn't reach `env` directly.
//
// The constructor accepts the runtime-shared `VectorizeIndexHandle`
// structural shape rather than the CF-specific `Vectorize` type, so
// the file can compile against `runtime/shared/interfaces.ts` only —
// no CF-specific types pulled in.

import type { VectorizeIndexHandle } from '../../runtime/shared/interfaces.js';
import type { DenseFilter, DenseHit, VectorRecord, VectorStore } from '../vector-store.js';

export class VectorizeV2Adapter implements VectorStore {
  constructor(private readonly index: VectorizeIndexHandle) {}

  async upsert(records: VectorRecord[]): Promise<{ mutation_id: string | null }> {
    if (records.length === 0) return { mutation_id: null };
    const result = await this.index.upsert(records);
    return { mutation_id: result.mutationId ?? null };
  }

  async query(
    vector: number[],
    opts: { topK: number; filter: DenseFilter },
  ): Promise<DenseHit[]> {
    const result = await this.index.query(vector, {
      topK: opts.topK,
      // Vectorize V2 metadata filter format. Accepts the operator
      // shape ($in, etc.) directly; passed through as `unknown`.
      filter: opts.filter,
      returnMetadata: 'all',
    });
    return result.matches.map((m) => ({
      chunk_id: m.id,
      score: m.score,
    }));
  }

  async deleteByIds(ids: string[]): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    await this.index.deleteByIds(ids);
    return { count: ids.length };
  }
}
