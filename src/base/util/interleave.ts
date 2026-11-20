/** `a` and `b` taken in turn, each id once: at its first place, with the last row object for that
 * id in either list. Then the first `limit` of those, a fraction rounded up and none at 0 or below,
 * as the loop this replaced returned. */
export function interleaveRows<R extends { readonly id: string }>(
  a: readonly R[],
  b: readonly R[],
  limit: number,
): R[] {
  const byId = new Map<string, R>();
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    for (const row of [a[i], b[i]]) {
      if (row !== undefined) byId.set(row.id, row);
    }
  }
  return [...byId.values()].slice(0, Math.max(0, Math.ceil(limit)));
}
