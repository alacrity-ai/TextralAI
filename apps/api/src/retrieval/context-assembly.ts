// Context assembly with per-layer budgets, unified [N] numbering,
// and Option A oversize-admit (Phase 5).
//
// Algorithm (per §5.10 in PHASE_5_IMPLEMENTATION.md):
//   1. Hydrate via WHERE id IN (...).
//   2. Re-sort hydrated rows by fused-rank order.
//   3. Bucket by artifact_type.
//   4. Compute per-layer caps in tokens (layer_budgets normalized).
//   5. Walk layer_order: greedy include each bucket up to cap. Admit
//      a single oversized chunk only when its layer is otherwise
//      empty AND there's enough remaining max_context_tokens budget.
//   6. Spill carryover to the next layer in declared order. Last-
//      layer underfill is unused.
//   7. Emit in layer_order with [N] numbering across layers.

import type { Env } from '../types.js';
import { countTokens } from './tokenizer.js';
import type { FusedHit } from './rrf.js';
import { hydrateChunksByIds } from '../db/chunks.js';

export interface IncludedChunk {
  n: number;
  chunk_id: string;
  artifact_type: string;
  section_path: string | null;
  text: string;
  metadata: Record<string, unknown> | null;
}

export interface AssembledContext {
  context_block: string;
  included: IncludedChunk[];
  total_tokens: number;
  /** Phase 5 audit signal — number of chunks that were admitted into
   *  an empty layer despite exceeding its cap. */
  oversize_admits: number;
  /** Phase 5 audit signal — number of chunks that would have been
   *  admitted but for the overall token budget. */
  oversize_skips: number;
}

interface ChunkRow {
  id: string;
  text: string;
  artifact_type: string;
  section_path: string | null;
  metadata: string | null;
}

export interface AssembleArgs {
  fused: FusedHit[];
  tenant_id: string;
  max_context_tokens: number;
  /** Per-layer fractional budgets keyed by artifact_type. Normalized
   *  to sum to 1.0. When omitted, a single-layer (`passage: 1.0`)
   *  default applies — backwards compatible with Phase 4 behavior. */
  layer_budgets?: Record<string, number>;
  /** Order in which layers are emitted in the formatted context.
   *  Defaults to declaration order in `layer_budgets`. Citation
   *  numbering [N] increments across layers in this order. */
  layer_order?: string[];
}

const DEFAULT_LAYER_BUDGETS = { passage: 1.0 };

export async function assembleContext(env: Env, args: AssembleArgs): Promise<AssembledContext> {
  const { fused, tenant_id, max_context_tokens } = args;
  if (fused.length === 0) {
    return { context_block: '', included: [], total_tokens: 0, oversize_admits: 0, oversize_skips: 0 };
  }

  // 1. Hydrate.
  const ids = fused.map((f) => f.chunk_id);
  const rows = await hydrateChunksByIds(env.db, tenant_id, ids);
  const byId = new Map<string, ChunkRow>();
  for (const r of rows) byId.set(r.id, r);

  // 2. Re-sort hydrated rows by fused rank.
  const ordered: ChunkRow[] = [];
  for (const f of fused) {
    const row = byId.get(f.chunk_id);
    if (row) ordered.push(row);
  }

  // 3. Bucket by artifact_type.
  const layerBudgets = normalizeBudgets(args.layer_budgets ?? DEFAULT_LAYER_BUDGETS);
  const layerOrder =
    args.layer_order ?? Object.keys(args.layer_budgets ?? DEFAULT_LAYER_BUDGETS);
  const buckets = new Map<string, ChunkRow[]>();
  for (const layer of layerOrder) buckets.set(layer, []);
  for (const row of ordered) {
    const bucket = buckets.get(row.artifact_type);
    if (bucket) bucket.push(row);
    // Rows whose artifact_type isn't declared in layer_order are
    // dropped (intentional: profile authors can prune by omitting).
  }

  // 4. Compute per-layer caps.
  const caps = new Map<string, number>();
  for (const layer of layerOrder) {
    caps.set(layer, Math.floor(max_context_tokens * (layerBudgets[layer] ?? 0)));
  }

  // 5. Greedy include per layer, with spill carryover.
  const lines: string[] = [];
  const included: IncludedChunk[] = [];
  let totalTokens = 0;
  let spillCarry = 0;
  let oversizeAdmits = 0;
  let oversizeSkips = 0;

  for (const layer of layerOrder) {
    const bucket = buckets.get(layer) ?? [];
    const layerCap = (caps.get(layer) ?? 0) + spillCarry;
    let layerUsed = 0;
    let layerHadAnyAdmit = false;

    for (const row of bucket) {
      const header = formatHeader(included.length + 1, row);
      const block = `${header}\n${row.text}\n`;
      const cost = countTokens(block);

      if (layerUsed + cost <= layerCap) {
        // Fits within the layer cap.
        lines.push(block);
        included.push({
          n: included.length + 1,
          chunk_id: row.id,
          artifact_type: row.artifact_type,
          section_path: row.section_path,
          text: row.text,
          metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
        });
        layerUsed += cost;
        totalTokens += cost;
        layerHadAnyAdmit = true;
        continue;
      }

      // Doesn't fit. Option A oversize-admit: include iff the layer
      // is otherwise empty AND we have global budget for it.
      if (!layerHadAnyAdmit && totalTokens + cost <= max_context_tokens) {
        lines.push(block);
        included.push({
          n: included.length + 1,
          chunk_id: row.id,
          artifact_type: row.artifact_type,
          section_path: row.section_path,
          text: row.text,
          metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
        });
        layerUsed += cost;
        totalTokens += cost;
        oversizeAdmits += 1;
        layerHadAnyAdmit = true;
        // After admitting an oversize chunk we cap this layer — no
        // further admissions even if the bucket has more.
        break;
      }

      // Skipped: doesn't fit and either layer not-empty or no global budget.
      if (!layerHadAnyAdmit) oversizeSkips += 1;
      break;
    }

    // Spill any unused budget forward (only if not the last layer).
    spillCarry = Math.max(0, layerCap - layerUsed);
  }

  return {
    context_block: lines.join('\n'),
    included,
    total_tokens: totalTokens,
    oversize_admits: oversizeAdmits,
    oversize_skips: oversizeSkips,
  };
}

function normalizeBudgets(budgets: Record<string, number>): Record<string, number> {
  const sum = Object.values(budgets).reduce((a, b) => a + b, 0);
  if (sum <= 0) return budgets;
  if (Math.abs(sum - 1.0) < 0.001) return budgets;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(budgets)) out[k] = v / sum;
  return out;
}

function formatHeader(n: number, row: ChunkRow): string {
  const parts = [`${row.artifact_type}`, `chunk=${row.id}`];
  if (row.section_path) parts.push(`section=${row.section_path}`);
  return `[${n}] (${parts.join(', ')})`;
}
