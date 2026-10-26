// The failures a root has warned about. A bad key fails every write, so each distinct failure warns
// once in full and its repeats are counted, then summed at most once per interval.
import { MINUTE_MS } from './time.js';

const NOTICE_KEY_CAP = 64;
const REPEAT_SUMMARY_INTERVAL_MS = MINUTE_MS;

interface Seen {
  lastNoticeAt: number;
  suppressed: number;
}

/** What one failure should print: its full warning, a count of the repeats since the last
 * notice, or nothing. */
export type FailureNotice =
  | { readonly kind: 'first' }
  | { readonly kind: 'repeats'; readonly count: number }
  | null;

/** One root's warned failures, kept for the root's life and never shared with another root. */
export class FailureNotices {
  readonly #seen = new Map<string, Seen>();

  /** Records one failure under `key` at `nowMs` and says what to print for it. */
  note(key: string, nowMs: number): FailureNotice {
    const seen = this.#seen.get(key);
    if (seen) {
      seen.suppressed += 1;
      if (nowMs - seen.lastNoticeAt < REPEAT_SUMMARY_INTERVAL_MS) return null;
      const count = seen.suppressed;
      seen.suppressed = 0;
      seen.lastNoticeAt = nowMs;
      return { kind: 'repeats', count };
    }
    // Oldest key out, so a full set still lets a new failure warn.
    const oldest = this.#seen.size >= NOTICE_KEY_CAP ? this.#seen.keys().next() : undefined;
    if (oldest !== undefined && !oldest.done) this.#seen.delete(oldest.value);
    this.#seen.set(key, { lastNoticeAt: nowMs, suppressed: 0 });
    return { kind: 'first' };
  }
}
