/**
 * Bounded-concurrency async map — run `fn` over `items` with at most `limit`
 * in flight at once, preserving input order in the result.
 *
 * Why: several call sites federate per-id to a sibling app (e.g. resolving N
 * contact summaries for an overview/list page). A naive `Promise.all(ids.map…)`
 * fires ALL of them at once — a 500-row page becomes 500 simultaneous outbound
 * calls (socket/pool exhaustion here, a thundering herd there). A small worker
 * pool caps the fan-out without serializing it.
 *
 * Pure, dependency-free (no p-limit). A rejected `fn` rejects the whole call,
 * same as `Promise.all`; callers that need per-item degrade should make `fn`
 * resolve to a sentinel instead of throwing.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (items.length === 0) return out;

  const ceiling = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: ceiling }, () => worker()));
  return out;
}
