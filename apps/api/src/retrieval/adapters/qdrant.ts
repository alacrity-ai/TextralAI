// Qdrant adapter. Uses the REST API directly (no SDK dep). One
// collection per Textral namespace; collection name comes from
// the namespace's `vector_index_name`. Distance metric: cosine.
//
// Point ID translation: Qdrant requires UUID or unsigned int.
// Textral chunk_ids are like `chk_ver_<ulid>_<ord>` — not valid.
// We deterministically derive a UUIDv5 from the chunk_id and
// store the original chunk_id in the point's payload. v1's
// `apps/rag-core/app/clients/qdrant.py` used the same trick
// (with `uuid.NAMESPACE_DNS`).

import { TextralError } from '@textral/contracts';
import { NAMESPACE_DNS, uuidv5 } from '../../lib/uuidv5.js';
import type {
  DenseFilter,
  DenseHit,
  VectorMetadata,
  VectorRecord,
  VectorStore,
} from '../vector-store.js';

const DISTANCE = 'Cosine';

interface QdrantConfig {
  url: string;
  apiKey?: string;
  collection: string;
  dimensions: number;
}

interface QdrantPointPayload extends VectorMetadata {
  chunk_id: string;
}

export class QdrantAdapter implements VectorStore {
  constructor(private readonly cfg: QdrantConfig) {}

  // ── Collection lifecycle ───────────────────────────────────
  async ensureBackingExists(): Promise<void> {
    // Qdrant: PUT /collections/{name} is idempotent only when the
    // body matches; otherwise it returns 4xx. Use GET first, PUT
    // only on 404.
    const head = await this.fetch(`/collections/${this.cfg.collection}`, { method: 'GET' });
    if (head.status === 200) return;
    if (head.status !== 404) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Qdrant collection check failed (${head.status})`,
      );
    }
    const create = await this.fetch(`/collections/${this.cfg.collection}`, {
      method: 'PUT',
      body: JSON.stringify({
        vectors: { size: this.cfg.dimensions, distance: DISTANCE },
      }),
    });
    if (!create.ok) {
      const text = await create.text();
      throw new TextralError(
        'INTERNAL',
        500,
        `Qdrant create-collection failed: ${create.status} ${text.slice(0, 200)}`,
      );
    }
    // Add a payload index on the high-cardinality fields we filter
    // by. Indexes are idempotent — safe on collection re-create.
    for (const field of ['tenant_id', 'version_id', 'artifact_type']) {
      await this.fetch(`/collections/${this.cfg.collection}/index`, {
        method: 'PUT',
        body: JSON.stringify({ field_name: field, field_schema: 'keyword' }),
      });
    }
  }

  // ── Upsert ────────────────────────────────────────────────
  async upsert(records: VectorRecord[]): Promise<{ mutation_id: string | null }> {
    if (records.length === 0) return { mutation_id: null };
    const points = await Promise.all(
      records.map(async (r) => ({
        id: await uuidv5(NAMESPACE_DNS, r.id),
        vector: r.values,
        payload: { ...r.metadata, chunk_id: r.id } as QdrantPointPayload,
      })),
    );
    const res = await this.fetch(
      `/collections/${this.cfg.collection}/points?wait=true`,
      { method: 'PUT', body: JSON.stringify({ points }) },
    );
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Qdrant upsert failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    // Qdrant doesn't return a mutation id; null is acceptable per VectorStore contract.
    return { mutation_id: null };
  }

  // ── Query ─────────────────────────────────────────────────
  async query(
    vector: number[],
    opts: { topK: number; filter: DenseFilter },
  ): Promise<DenseHit[]> {
    const must: Array<Record<string, unknown>> = [
      { key: 'tenant_id', match: { value: opts.filter.tenant_id } },
      { key: 'namespace_id', match: { value: opts.filter.namespace_id } },
    ];
    if (opts.filter.version_id) {
      const v = opts.filter.version_id;
      must.push(
        typeof v === 'string'
          ? { key: 'version_id', match: { value: v } }
          : { key: 'version_id', match: { any: v.$in } },
      );
    }
    if (opts.filter.artifact_type) {
      const a = opts.filter.artifact_type;
      must.push(
        typeof a === 'string'
          ? { key: 'artifact_type', match: { value: a } }
          : { key: 'artifact_type', match: { any: a.$in } },
      );
    }
    const res = await this.fetch(`/collections/${this.cfg.collection}/points/search`, {
      method: 'POST',
      body: JSON.stringify({
        vector,
        limit: opts.topK,
        filter: { must },
        with_payload: true,
      }),
    });
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Qdrant search failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as {
      result: Array<{ id: string | number; score: number; payload?: { chunk_id?: string } }>;
    };
    return body.result.map((m) => ({
      chunk_id: m.payload?.chunk_id ?? String(m.id),
      score: m.score,
    }));
  }

  // ── Delete ────────────────────────────────────────────────
  async deleteByIds(ids: string[]): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    const points = await Promise.all(ids.map((id) => uuidv5(NAMESPACE_DNS, id)));
    const res = await this.fetch(
      `/collections/${this.cfg.collection}/points/delete?wait=true`,
      { method: 'POST', body: JSON.stringify({ points }) },
    );
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Qdrant delete failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    return { count: ids.length };
  }

  // ── Internal ──────────────────────────────────────────────
  private fetch(path: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.cfg.apiKey ? { 'api-key': this.cfg.apiKey } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    };
    return fetch(`${this.cfg.url}${path}`, { ...init, headers });
  }
}
