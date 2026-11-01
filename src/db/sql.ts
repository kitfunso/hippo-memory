// SQL text the data layer and the SQLite adapter share: IN lists, VALUES rows, and the row predicates
// an index and the reads it serves must spell alike.
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

/** A piece of SQL and the values its marks bind, in order: a WHERE term, or an ` AND ...` tail
 * that may be empty. */
export interface SqlFragment {
  readonly sql: string;
  readonly params: readonly (string | number)[];
}

/** An ` AND ...` tail selecting rows strictly after `after` in (key DESC, id DESC) order; empty
 * when it is unset. */
export function keysetAfter(
  sortCol: string,
  idCol: string,
  after: KeysetPosition | undefined,
): SqlFragment {
  if (!after) return { sql: '', params: [] };
  return { sql: ` AND (${sortCol}, ${idCol}) < (?, ?)`, params: [after.key, after.id] };
}

/** The rows the duplicate read groups: current distilled ones. */
export const CURRENT_DISTILLED =
  "COALESCE(kind, 'distilled') = 'distilled' AND COALESCE(superseded_by, '') = ''";

// A tag list with a `\`, a digit, an object or a nested list may not hold its tags' text as
// written: an escape, or a value String() writes another way.
export const TAGS_NOT_AS_WRITTEN = `instr(tags_json, '\\') > 0 OR tags_json GLOB '*[0-9{]*' \
OR instr(substr(tags_json, 2), '[') > 0`;

/** The rows whose text a trigram lookup may miss where JavaScript's lower-casing finds it: tags
 * not as written, and a dotted capital I, which FTS5 does not fold to `i`. Migration v64 indexes
 * them, so a text filter reads them by index. */
export const TEXT_OUTSIDE_TRIGRAMS = `${TAGS_NOT_AS_WRITTEN} OR instr(content, char(304)) > 0 \
OR instr(tags_json, char(304)) > 0`;
