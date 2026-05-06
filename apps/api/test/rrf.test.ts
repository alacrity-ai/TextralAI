import { describe, it, expect } from 'vitest';
import { rrf } from '../src/retrieval/rrf.js';

describe('rrf', () => {
  it('fuses two arms with k=60 and yields a unified sorted output', () => {
    const dense = [{ chunk_id: 'a' }, { chunk_id: 'b' }, { chunk_id: 'c' }];
    const sparse = [{ chunk_id: 'b' }, { chunk_id: 'd' }, { chunk_id: 'a' }];
    const fused = rrf([dense, sparse]);
    expect(fused.length).toBeGreaterThan(0);
    const ids = fused.map((f) => f.chunk_id);
    // 'b' appears at rank 1 in sparse and 2 in dense → strong score.
    // 'a' appears at rank 1 dense and rank 3 sparse → also strong.
    expect(ids.slice(0, 2).sort()).toEqual(['a', 'b']);
  });

  it('handles a single-arm input gracefully', () => {
    const dense = [{ chunk_id: 'a' }, { chunk_id: 'b' }];
    const fused = rrf([dense]);
    expect(fused.map((f) => f.chunk_id)).toEqual(['a', 'b']);
  });

  it('rank monotonicity: bumping a chunk up never lowers its fused score', () => {
    const before = rrf([
      [{ chunk_id: 'a' }, { chunk_id: 'b' }, { chunk_id: 'c' }],
      [{ chunk_id: 'c' }, { chunk_id: 'a' }, { chunk_id: 'b' }],
    ]);
    const after = rrf([
      [{ chunk_id: 'b' }, { chunk_id: 'a' }, { chunk_id: 'c' }], // 'b' now top of arm 1
      [{ chunk_id: 'c' }, { chunk_id: 'a' }, { chunk_id: 'b' }],
    ]);
    const bBefore = before.find((f) => f.chunk_id === 'b')!.score;
    const bAfter = after.find((f) => f.chunk_id === 'b')!.score;
    expect(bAfter).toBeGreaterThanOrEqual(bBefore);
  });

  it('respects custom k', () => {
    const a = rrf([[{ chunk_id: 'x' }]], { k: 10 });
    const b = rrf([[{ chunk_id: 'x' }]], { k: 100 });
    // Smaller k → larger contribution.
    expect(a[0]!.score).toBeGreaterThan(b[0]!.score);
  });
});
