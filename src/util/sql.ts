// SQL text helpers shared by every layer that builds an IN list or VALUES row.

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

/** How many ids one statement can bind when each id is bound `copies` times beside `otherBinds` more marks. */
export function idsPerStatement(copies: number, otherBinds: number): number {
  return Math.floor((SQLITE_MAX_BOUND_PARAMS - otherBinds) / copies);
}

/** `rows` VALUES rows of `bindsPerRow` marks each, e.g. (2, 2) -> "(?, ?), (?, ?)". */
export function valuesRows(rows: number, bindsPerRow: number): string {
  const row = `(${placeholders(bindsPerRow)})`;
  return Array.from({ length: rows }, () => row).join(', ');
}
