// The row windows and caps the store reads, each set once so every read that shares one answers the
// same rows.

/** Newest admitted rows LIKE tests for a term under 3 characters, which no trigram lookup can
 * answer. */
export const LIKE_WINDOW_ROWS = 2000;

/** How many of a tenant's newest rows schemaFit reads; older rows no longer move the fit. */
export const SCHEMA_FIT_WINDOW_ROWS = 2000;

/** Events of one completed session a sleep reads to render its trace, the newest kept. */
export const TRACE_EVENT_ROWS = 1000;

/** Newest session events the recent-session mirror file holds after each append. */
export const RECENT_MIRROR_EVENTS = 20;
