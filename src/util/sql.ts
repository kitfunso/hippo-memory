// SQL text helpers shared by every layer that builds an IN list or VALUES row.

/** `n` bound-parameter marks joined for an IN list or VALUES row, e.g. 3 -> "?, ?, ?". */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}
