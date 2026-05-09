// Pagination iterator tests.

import { describe, it, expect } from 'vitest';
import { paginate } from '../src/index.js';

describe('paginate', () => {
  it('iterates all items across multiple pages, in order', async () => {
    const pages = [
      { data: [1, 2, 3], next_cursor: 'p2' },
      { data: [4, 5, 6], next_cursor: 'p3' },
      { data: [7, 8, 9], next_cursor: null },
    ];
    const seenCursors: (string | null)[] = [];
    const items: number[] = [];
    for await (const item of paginate<number>(async (cursor) => {
      seenCursors.push(cursor);
      const idx = cursor === null ? 0 : cursor === 'p2' ? 1 : 2;
      return pages[idx]!;
    })) {
      items.push(item);
    }
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(seenCursors).toEqual([null, 'p2', 'p3']);
  });

  it('terminates on next_cursor === null', async () => {
    let calls = 0;
    const items: number[] = [];
    for await (const item of paginate<number>(async () => {
      calls++;
      return { data: [1], next_cursor: null };
    })) {
      items.push(item);
    }
    expect(calls).toBe(1);
    expect(items).toEqual([1]);
  });

  it('handles empty first page (next_cursor=null, data=[])', async () => {
    const items: number[] = [];
    for await (const item of paginate<number>(async () => ({ data: [], next_cursor: null }))) {
      items.push(item);
    }
    expect(items).toEqual([]);
  });

  it('aborts cleanly between pages', async () => {
    const ac = new AbortController();
    const items: number[] = [];
    let pageCount = 0;
    const promise = (async () => {
      for await (const item of paginate<number>(
        async (cursor) => {
          pageCount++;
          if (pageCount === 2) ac.abort();
          return cursor === null
            ? { data: [1, 2], next_cursor: 'p2' }
            : { data: [3, 4], next_cursor: 'p3' };
        },
        { signal: ac.signal },
      )) {
        items.push(item);
      }
    })();
    await expect(promise).rejects.toThrow();
    // First page items yielded. Page 2's fetch resolves but the
    // abort check at the top of the inner yield-loop fires before
    // yielding any of [3, 4]. Confirms the iterator doesn't dribble
    // items out of an aborted page.
    expect(items).toEqual([1, 2]);
  });

  it('aborts mid-page (between yields)', async () => {
    const ac = new AbortController();
    const items: number[] = [];
    const promise = (async () => {
      for await (const item of paginate<number>(
        async () => ({ data: [1, 2, 3], next_cursor: null }),
        { signal: ac.signal },
      )) {
        items.push(item);
        if (item === 2) ac.abort();
      }
    })();
    await expect(promise).rejects.toThrow();
    // 1 + 2 yielded; 3 caught by abort check before yield.
    expect(items).toEqual([1, 2]);
  });
});
