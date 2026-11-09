// When sleep stops sending work to the model that keeps failing; pure, the store keeps only the numbers.
import { DAY_MS } from '../../base/util/time.js';
import { blockHash } from '../../base/util/token-text.js';

/** Failed rebuilds in a row after which a dirty summary is held back from the model. */
export const REBUILD_FAILURES_BEFORE_HOLD = 3;
const REBUILD_HOLD_BASE_DAYS = 1;
const REBUILD_HOLD_MAX_DAYS = 7;

/** The ISO time a summary with `failures` failed rebuilds in a row is next sent to the model: one
 * day after the third, doubling with each further one up to seven days; null below the third. */
export function rebuildRetryAfter(failures: number, now: Date): string | null {
  if (failures < REBUILD_FAILURES_BEFORE_HOLD) return null;
  const doublings = failures - REBUILD_FAILURES_BEFORE_HOLD;
  const days = Math.min(REBUILD_HOLD_BASE_DAYS * 2 ** doublings, REBUILD_HOLD_MAX_DAYS);
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

/** Days an empty extraction mark keeps its source out of the batch. */
export const EMPTY_EXTRACTION_TTL_DAYS = 30;

/** Whether `mark` still stands for `content`: its digest is the text's and it is under 30 days old.
 * A mark whose time does not parse stands for nothing. */
export function emptyMarkStands(
  mark: { readonly digest: string; readonly at: string } | undefined,
  content: string,
  now: Date,
): boolean {
  if (mark === undefined || mark.digest !== blockHash(content)) return false;
  return now.getTime() - Date.parse(mark.at) < EMPTY_EXTRACTION_TTL_DAYS * DAY_MS;
}
