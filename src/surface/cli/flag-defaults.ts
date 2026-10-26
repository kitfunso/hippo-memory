// CLI flag defaults the help text prints; a leaf module so the verb table reads them without
// loading a handler.

/** `hippo init --scan` seeds a year of history across many repos. */
export const SEED_DAYS_SCAN = 365;
/** A single-repo `hippo init` seeds a month, enough context without a long first run. */
export const SEED_DAYS_SINGLE = 30;
/** `hippo recall --max-neighbors` upper bound, so one hop cannot fan out across the store. */
export const MAX_NEIGHBORS_FLAG = 200;
/** `hippo eval --bootstrap` default case count. */
export const DEFAULT_BOOTSTRAP_CASES = 50;
/** `hippo wm push` default importance, the midpoint of the 0-1 scale. */
export const WM_DEFAULT_IMPORTANCE = 0.5;
