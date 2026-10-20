// Keyset paging for list queries ordered by (sort key DESC, id DESC), so a page never skips or repeats a row when rows
// arrive between requests.

/** The sort key and id of the last row a page returned. */
export interface KeysetPosition {
  readonly key: string | number;
  readonly id: string | number;
}

/** A WHERE fragment and the params it binds. */
export interface KeysetClause {
  sql: string;
  params: Array<string | number>;
}

/** A page's rows and the cursor the next page starts after, null on the last page. */
export interface KeysetPage<T, C> {
  readonly rows: T[];
  readonly next: C | null;
}

/** The first `limit` of `rows`, which a read fetched one row past `limit` only to say whether another page follows. */
export function keysetPage<T, C>(rows: readonly T[], limit: number, cursorOf: (row: T) => C): KeysetPage<T, C> {
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  return { rows: kept, next: rows.length > limit && last !== undefined ? cursorOf(last) : null };
}

/** An ` AND ...` WHERE fragment and its params selecting rows strictly after `after`; empty when `after` is unset. */
export function keysetAfter(sortCol: string, idCol: string, after: KeysetPosition | undefined): KeysetClause {
  if (!after) return { sql: '', params: [] };
  return { sql: ` AND (${sortCol}, ${idCol}) < (?, ?)`, params: [after.key, after.id] };
}
