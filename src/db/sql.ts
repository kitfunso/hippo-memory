// SQL text for an IN list or VALUES rows, for the data layer and the SQLite adapter that bind them.
import type { KeysetPosition } from '../base/util/keyset.js';

/** `n` bound-parameter marks joined for an IN list or VALUES row, e.g. 3 -> "?, ?, ?". */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** SQLite's default bound-parameter limit since 3.32; node:sqlite bundles a newer SQLite. */
export const SQLITE_MAX_BOUND_PARAMS = 32766;

/** How many VALUES rows of `bindsPerRow` marks one statement can bind. */
export function rowsPerStatement(bindsPerRow: number): number {
  return Math.floor(SQLITE_MAX_BOUND_PARAMS / bindsPerRow);
}

/** `rows` VALUES rows of `bindsPerRow` marks each, e.g. (2, 2) -> "(?, ?), (?, ?)". */
export function valuesRows(rows: number, bindsPerRow: number): string {
  const row = `(${placeholders(bindsPerRow)})`;
  return Array.from({ length: rows }, () => row).join(', ');
}

/** A piece of SQL and the values its marks bind, in order: a WHERE term, or an ` AND ...` tail that may be empty. */
export interface SqlFragment {
  readonly sql: string;
  readonly params: readonly (string | number)[];
}

/** An ` AND ...` tail selecting rows strictly after `after` in (key DESC, id DESC) order; empty when it is unset. */
export function keysetAfter(sortCol: string, idCol: string, after: KeysetPosition | undefined): SqlFragment {
  if (!after) return { sql: '', params: [] };
  return { sql: ` AND (${sortCol}, ${idCol}) < (?, ?)`, params: [after.key, after.id] };
}
