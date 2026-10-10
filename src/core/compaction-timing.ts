// Waits and windows shared by the compaction record's SQL (src/store) and the hooks and CLI that schedule it.

/** PostCompact has 10 s in all (PreCompact 30 s), so a locked store must be given up on early. */
export const COMPACTION_DB_WAIT_MS = 2000;

/** Long enough that a live hook has finished with its own record. */
export const REPLAY_AFTER_MS = 10 * 60_000;

/** Claude Code deletes transcripts after 30 days, so an older gap can never be filled. */
export const TRANSCRIPT_FILL_WINDOW_MS = 30 * 24 * 60 * 60_000;
