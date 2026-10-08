// Bounded-concurrency map. Used for LLM fan-out, where the serial version was
// the single biggest wall-clock cost in a run: ~400 Haiku calls at roughly a
// second each is ~7 minutes of pure waiting.
//
// Bounded rather than Promise.all: firing 400 requests at once earns 429s, and
// the retries then cost more than the concurrency saved.

export interface PoolOpts {
  /** Called after each item settles, for progress output. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order
 * in the returned array. Rejects on the first error, like Promise.all — callers
 * that want partial results should catch inside `fn`.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  opts: PoolOpts = {},
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  let done = 0;

  // Each worker pulls the next index off a shared cursor, so a slow item holds
  // up only its own worker rather than a whole batch (which is what chunking
  // into fixed groups of `limit` would do).
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      opts.onProgress?.(++done, items.length);
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
