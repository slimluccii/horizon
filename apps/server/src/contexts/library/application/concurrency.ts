/**
 * Tiny promise-pool. Runs `worker` over `items` with at most `limit`
 * concurrent in-flight tasks. Order of resolution is not preserved; results
 * align with input order via a fixed-size output array.
 *
 * Why not p-limit / p-map: zero deps, ~25 LOC, exact behavior we need.
 */
export async function pMap<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}
