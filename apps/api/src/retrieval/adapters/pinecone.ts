// Pinecone serverless adapter. Uses the data-plane host URL
// (e.g. https://my-idx.svc.us-east-1.pinecone.io) directly. The
// caller supplies the host as `vector_index_name` on the
// namespace; the operator pre-creates the index out-of-band via
// Pinecone dashboard or REST.
//
// Vector IDs are chunk_ids verbatim — Pinecone accepts up to 512
// bytes per id; the existing _chunk_id_guard caps at 64.

import { TextralError } from '@textral/contracts';
import type {
  DenseFilter,
  DenseHit,
  VectorRecord,
  VectorStore,
} from '../vector-store.js';

interface PineconeConfig {
  /** Full URL, e.g. "https://my-idx.svc.us-east-1.pinecone.io". */
  host: string;
  apiKey: string;
  dimensions: number;
  /** Pinecone native namespace inside the index. Falsy (`''` / null) →
   *  query/upsert against Pinecone's default (unnamed) namespace; the
   *  adapter omits the `namespace` field on the wire in that case.
   *  Truthy → include on every request body for partition isolation. */
  namespace: string | null;
}

export class PineconeAdapter implements VectorStore {
  constructor(private readonly cfg: PineconeConfig) {}

  async ensureBackingExists(): Promise<void> {
    // Index creation is operator-side. Verify reachability with a
    // POST on /describe_index_stats; surface a clean 400 if not.
    // Reachability is per-index, not per-namespace — the namespace is
    // implicitly created on first upsert.
    const res = await this.fetch('/describe_index_stats', {
      method: 'POST',
      body: '{}',
    });
    if (res.status === 404) {
      throw new TextralError(
        'BAD_REQUEST',
        400,
        `Pinecone index at ${this.cfg.host} not found. Provision it via the Pinecone dashboard or API first.`,
      );
    }
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Pinecone reachability check failed (${res.status})`,
      );
    }
  }

  /** Adds the `namespace` field to a Pinecone request body when one
   *  is configured. Falsy → omit (= use Pinecone's default unnamed
   *  namespace, preserving backwards compatibility for rows backfilled
   *  by migration 0009). */
  private withNamespace<T extends Record<string, unknown>>(body: T): T {
    if (this.cfg.namespace) {
      return { ...body, namespace: this.cfg.namespace };
    }
    return body;
  }

  async upsert(records: VectorRecord[]): Promise<{ mutation_id: string | null }> {
    if (records.length === 0) return { mutation_id: null };
    // Pinecone's metadata API accepts string | number | boolean | string[].
    // VectorMetadata is all-strings today, which trivially satisfies the
    // wider type — direct assignment, no double-cast.
    const vectors = records.map((r) => {
      const metadata: Record<string, string | number | boolean | string[]> = { ...r.metadata };
      return { id: r.id, values: r.values, metadata };
    });
    const res = await this.fetch('/vectors/upsert', {
      method: 'POST',
      body: JSON.stringify(this.withNamespace({ vectors })),
    });
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Pinecone upsert failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    return { mutation_id: null };
  }

  async query(
    vector: number[],
    opts: { topK: number; filter: DenseFilter },
  ): Promise<DenseHit[]> {
    const filter: Record<string, unknown> = {
      tenant_id: { $eq: opts.filter.tenant_id },
      namespace_id: { $eq: opts.filter.namespace_id },
    };
    if (opts.filter.version_id) {
      filter.version_id =
        typeof opts.filter.version_id === 'string'
          ? { $eq: opts.filter.version_id }
          : { $in: opts.filter.version_id.$in };
    }
    if (opts.filter.artifact_type) {
      filter.artifact_type =
        typeof opts.filter.artifact_type === 'string'
          ? { $eq: opts.filter.artifact_type }
          : { $in: opts.filter.artifact_type.$in };
    }
    const res = await this.fetch('/query', {
      method: 'POST',
      body: JSON.stringify(
        this.withNamespace({
          vector,
          topK: opts.topK,
          filter,
          includeMetadata: false,
          includeValues: false,
        }),
      ),
    });
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Pinecone query failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as {
      matches: Array<{ id: string; score: number }>;
    };
    return body.matches.map((m) => ({ chunk_id: m.id, score: m.score }));
  }

  async deleteByIds(ids: string[]): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    const res = await this.fetch('/vectors/delete', {
      method: 'POST',
      body: JSON.stringify(this.withNamespace({ ids })),
    });
    if (!res.ok) {
      throw new TextralError(
        'INTERNAL',
        500,
        `Pinecone delete failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    return { count: ids.length };
  }

  private fetch(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.cfg.host}${path}`, {
      ...init,
      headers: {
        'Api-Key': this.cfg.apiKey,
        // Pin a recent stable API version. Update if Pinecone
        // releases a newer one and the data-plane shape changes.
        'X-Pinecone-API-Version': '2025-04',
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  }
}
