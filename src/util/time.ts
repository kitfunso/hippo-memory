// Durations in the base layer, so no layer imports a higher one for a constant.
export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
/** Longest wait for one git call from a command or a learn pass. */
export const GIT_CALL_TIMEOUT_MS = 10_000;
/** Longest wait for a git call on a prompt path, where the user is waiting. */
export const GIT_PROMPT_TIMEOUT_MS = 3_000;
/** One 365-day year in seconds. */
export const YEAR_S = 31_536_000;
