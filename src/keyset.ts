// Keyset paging for list queries ordered by (sort key DESC, id DESC), so a page never skips or repeats a row when rows arrive between requests.

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

/** An ` AND ...` WHERE fragment and its params selecting rows strictly after `after`; empty when `after` is unset. */
export function keysetAfter(
  sortCol: string,
  idCol: string,
  after: KeysetPosition | undefined,
): KeysetClause {
  if (!after) return { sql: '', params: [] };
  return { sql: ` AND (${sortCol}, ${idCol}) < (?, ?)`, params: [after.key, after.id] };
}
