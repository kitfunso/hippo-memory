// The row windows and caps the store reads, each set once so every read that shares one answers the
// same rows.

/** Fresh raw rows one read returns at most. */
export const MAX_FRESH_RAW = 200;

/** Newest admitted rows LIKE tests for a term under 3 characters, which no trigram lookup can
 * answer. */
export const LIKE_WINDOW_ROWS = 2000;

/** How many of a tenant's newest rows schemaFit reads; older rows no longer move the fit. */
export const SCHEMA_FIT_WINDOW_ROWS = 2000;

/** Working-memory entries one scope keeps; past it the lowest importance goes first. */
export const WM_MAX_ENTRIES = 20;

/** Session events a read returns when its caller names no limit. */
export const SESSION_EVENT_LIMIT = 8;

/** Events of one completed session a sleep reads to render its trace, the newest kept. */
export const TRACE_EVENT_ROWS = 1000;
