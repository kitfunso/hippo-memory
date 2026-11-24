export const MAX_BODY_BYTES = 1024 * 1024;

export const MAX_ID_LEN = 256;

export const MAX_HOOK_FIELD_LEN = 128;

export const MAX_SHORT_FIELD_LEN = 4096;

export const MAX_LEAD_IN_CHARS = 2000;

export const MAX_CONTENT_LEN = MAX_BODY_BYTES;

export const MAX_DATE_LEN = 64;

export const MAX_ARRAY_ITEMS = 100;

export const BASIS_POINTS = 10_000;

export const MAX_FRESH_RAW = 200;

export const WM_MAX_ENTRIES = 20;

export const SESSION_EVENT_LIMIT = 8;

export const DEFAULT_LIST_LIMIT = 100;

export const DEFAULT_LEARN_DAYS = 7;

export const MAX_LIST_LIMIT = 1000;

export const MAX_AUDIT_LIMIT = 10_000;

export const MAX_REPLY_BYTES = 1024 * 1024;

/** The one list-limit rule: absent means the default; a positive integer up to the ceiling passes.
 * Anything else returns undefined, so each surface words its own error. */
export function resolveListLimit(
  requested: number | undefined,
  defaultLimit: number = DEFAULT_LIST_LIMIT,
  maxLimit: number = Infinity,
): number | undefined {
  if (requested === undefined) return defaultLimit;
  return Number.isInteger(requested) && requested > 0 && requested <= maxLimit
    ? requested
    : undefined;
}
