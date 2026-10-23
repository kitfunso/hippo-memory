// The row windows and caps both adapters read, each set once so the two stores answer with the same rows.

/** Fresh raw rows one read returns at most. */
export const MAX_FRESH_RAW = 200;

/** Newest admitted rows the substring match tests, so a query matching nothing costs the same at any store size. */
export const LIKE_WINDOW_ROWS = 2000;

/** How many of a tenant's newest rows schemaFit reads; older rows no longer move the fit. */
export const SCHEMA_FIT_WINDOW_ROWS = 2000;

/** Working-memory entries one scope keeps; past it the lowest importance goes first. */
export const WM_MAX_ENTRIES = 20;

/** Session events a read returns when its caller names no limit. */
export const SESSION_EVENT_LIMIT = 8;
