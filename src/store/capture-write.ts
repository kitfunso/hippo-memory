// The write half of `hippo capture`: each item through the write gate on one store handle, then mirrored and counted.
import type { DatabaseSyncLike } from '../db/index.js';
import { duplicateKey } from '../util/same-text.js';
import { writeEntryMirrors } from './sqlite/entry-writes.js';
import { stampOriginProject } from './sqlite/entry-row.js';
import { gatedWrite } from './sqlite/gated-write.js';
import { updateStatsOn } from './sqlite/index-and-stats.js';
import type { StoreFiles } from './sqlite/open.js';
import type { CaptureItem, CaptureWriteOptions, CapturedOutcome } from './port/captures.js';

/** One outcome per item, in order, on a handle opened with openStore. `keys` holds the texts already stored and gains
 * each one written, so a repeat inside the batch is skipped. */
export function writeCapturedItemsAt(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  items: readonly CaptureItem[],
  keys: Set<string>,
  opts: CaptureWriteOptions,
): CapturedOutcome[] {
  return items.map((item) => {
    if (keys.has(duplicateKey(item.content))) return 'skipped';
    const entry = item.makeEntry();
    // One rejected item must not abort the rest of this capture's items.
    const stamped = stampOriginProject(hippoRoot, entry);
    const outcome = gatedWrite(db, hippoRoot, stamped, { actor: opts.actor });
    if (outcome === 'skipped:rejected') return 'rejected';
    if (outcome !== 'written') return 'skipped';
    writeEntryMirrors(hippoRoot, stamped);
    if (!opts.lean) updateStatsOn(db, hippoRoot, { remembered: 1 });
    keys.add(duplicateKey(item.content)); // within-batch dedup
    opts.onCaptured?.(entry);
    return 'captured';
  });
}
