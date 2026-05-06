// Reciprocal Rank Fusion.
//
// Standard k=60 default (Cormack/Clarke/Lynam, 2009). When only one arm
// has results, RRF over a single list is well-defined.

export interface RankedHit {
  chunk_id: string;
}

export interface FusedHit {
  chunk_id: string;
  score: number;
}

export function rrf(arms: Array<RankedHit[]>, opts: { k?: number } = {}): FusedHit[] {
  const k = opts.k ?? 60;
  const scores = new Map<string, number>();
  for (const arm of arms) {
    for (let i = 0; i < arm.length; i++) {
      const id = arm[i]!.chunk_id;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return [...scores.entries()]
    .map(([chunk_id, score]) => ({ chunk_id, score }))
    .sort((a, b) => b.score - a.score);
}
