// Cap for id-shaped request fields (ids, tenant, session, scope, class): far above real values, small enough to bound
// logs and indexes.
export const MAX_ID_LEN = 256;

// Page size every list surface (CLI, HTTP, store) falls back to when the caller names none.
export const DEFAULT_LIST_LIMIT = 100;

// Ceiling for a caller-named list page; SQLite `LIMIT ?` and one response's size bound it, and every list surface
// shares it.
export const MAX_LIST_LIMIT = 1000;

/** The one list-limit rule: absent means the default; a positive integer up to the ceiling passes.
 * Anything else returns undefined, so each surface words its own error. */
export function resolveListLimit(
  requested: number | undefined,
  defaultLimit: number = DEFAULT_LIST_LIMIT,
  maxLimit: number = Infinity,
): number | undefined {
  if (requested === undefined) return defaultLimit;
  return Number.isInteger(requested) && requested > 0 && requested <= maxLimit ? requested : undefined;
}
