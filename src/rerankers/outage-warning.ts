// One way for a reranker to report that it stopped working, without a line per recall.
import { log, type LogFields } from '../util/log.js';

const REPEAT_MS = 5 * 60_000;

export interface OutageWarning {
  /** `fields` carries the error's class and stack onto the warning line. */
  failed(reason: string, fields?: LogFields): void;
  answered(): void;
}

/** Warns when `name` starts failing, at most every five minutes while it keeps failing,
 * and once when it answers again. `fallback` says what recall does meanwhile. */
export function createOutageWarning(name: string, fallback: string): OutageWarning {
  let failures = 0;
  let unreported = 0;
  let warnedAt = 0;
  return {
    failed(reason: string, fields?: LogFields): void {
      failures++;
      if (failures > 1 && Date.now() - warnedAt < REPEAT_MS) {
        unreported++;
        return;
      }
      const skipped = unreported > 0 ? ` ${unreported} more calls failed since the last warning.` : '';
      const repeat = `While it fails this repeats at most every ${REPEAT_MS / 60_000} minutes.`;
      log.warn(`${name} reranker unavailable (${reason}); ${fallback}.${skipped} ${repeat}`, fields);
      warnedAt = Date.now();
      unreported = 0;
    },
    answered(): void {
      if (failures === 0) return;
      // At warn so it shows at the default level, next to the outage line it closes.
      log.warn(`${name} reranker is answering again after ${failures} failed ${failures === 1 ? 'call' : 'calls'}.`);
      failures = 0;
      unreported = 0;
    },
  };
}
