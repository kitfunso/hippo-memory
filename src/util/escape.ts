// Leaf module: literal-match escapes, kept in one place so every LIKE and RegExp caller escapes the same set.

/** Escape LIKE metacharacters for a query that declares `ESCAPE '\'`. */
export function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, '\\$&');
}

/** Escape a string for use as a literal inside a RegExp source. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
