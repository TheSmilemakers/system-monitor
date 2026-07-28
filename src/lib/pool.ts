/**
 * Bounded-concurrency map.
 *
 * Unbounded `Promise.all` over the cleanup catalogue spawns two filesystem
 * walks per target at once. That no longer blocks the event loop, but it does
 * saturate disk I/O, which slowed a concurrent /api/stats request to ~10s.
 * Limiting the pool keeps the scan fast without starving everything else.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
