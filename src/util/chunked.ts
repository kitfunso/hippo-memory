/** Ids per `IN (...)` list: far under SQLite's bound-parameter limit, with room for the tenant filter. */
const ID_CHUNK = 500;

/** `items` in consecutive slices of at most `size`. */
export function chunked<T>(items: readonly T[], size: number = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
