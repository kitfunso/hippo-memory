// What doctor reports about the spool folder, read only.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorCode } from '../base/util/log.js';
import {
  BUSY_CODES,
  NEW_STEM,
  SPOOL_DIR,
  STALE_MS,
  type SpoolFs,
  TMP,
  WAITING,
  claimOf,
  created,
} from './spool-files.js';

export interface SpoolCounts {
  waiting: number;
  stale: number;
  bad: number;
}

function mtimeOf(fsx: SpoolFs, file: string): number | null {
  try {
    return fsx.statSync(file).mtimeMs;
  } catch (err) {
    const code = errorCode(err);
    // Moved by a replay after the listing, or held by another program: left out of this count
    // rather than failing it.
    if (code === 'ENOENT' || BUSY_CODES.has(code)) return null;
    throw err;
  }
}

/**
 * What doctor reports, read only: files a replay should have taken by now, claims and tmp files a
 * dead process left, and `.bad` files.
 */
export function spoolCounts(
  hippoRoot: string,
  now: Date,
  waitingAfterMs: number,
  fsx: SpoolFs = fs,
): SpoolCounts {
  const counts: SpoolCounts = { waiting: 0, stale: 0, bad: 0 };
  const dir = path.join(hippoRoot, SPOOL_DIR);
  if (!fsx.existsSync(dir)) return counts;
  const at = now.getTime();
  for (const name of fsx.readdirSync(dir)) {
    const file = path.join(dir, name);
    const waiting = WAITING.exec(name);
    const claim = claimOf(name);
    if (name.endsWith('.bad')) counts.bad++;
    else if (waiting !== null) {
      const spooled = NEW_STEM.test(waiting[1]) ? created(waiting[1]) : mtimeOf(fsx, file);
      if (spooled !== null && at - spooled > waitingAfterMs) counts.waiting++;
    } else if (claim !== null || TMP.test(name)) {
      const since = claim?.claimedAt ?? mtimeOf(fsx, file);
      if (since !== null && Math.abs(at - since) > STALE_MS) counts.stale++;
    }
  }
  return counts;
}
