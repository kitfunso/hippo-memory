/** `a` and `b` taken in turn, each id once, up to `limit`. A repeated id keeps its first place and
 * the row object seen last. */
export function interleaveRows<R extends { readonly id: string }>(
  a: readonly R[],
  b: readonly R[],
  limit: number,
): R[] {
  const out = new Map<string, R>();
  for (let i = 0; out.size < limit && i < Math.max(a.length, b.length); i++) {
    for (const row of [a[i], b[i]]) {
      if (row !== undefined && out.size < limit) out.set(row.id, row);
    }
  }
  return [...out.values()];
}
