// Generic pagination iterator. Wraps a cursor-based list call into
// an `AsyncIterable<T>` so callers can write
// `for await (const item of client.x.iterate(...))` without
// managing `next_cursor` themselves.
//
// The underlying contract every paginated route satisfies:
//
//     interface PageResponse<T> {
//       data: T[];
//       next_cursor: string | null;
//     }
//
// The fetcher closure is responsible for translating the cursor
// into the right query-param shape for its route. The iterator just
// yields items and stops when `next_cursor === null`.

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface PaginateOptions {
  signal?: AbortSignal;
}

export async function* paginate<T>(
  fetcher: (cursor: string | null) => Promise<Page<T>>,
  opts: PaginateOptions = {},
): AsyncIterable<T> {
  let cursor: string | null = null;
  for (;;) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    const page = await fetcher(cursor);
    for (const item of page.data) {
      if (opts.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      yield item;
    }
    if (page.next_cursor === null) return;
    cursor = page.next_cursor;
  }
}
