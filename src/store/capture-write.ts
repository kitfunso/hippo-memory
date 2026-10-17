// The write half of `hippo capture`: each item through the write gate on one store handle, then mirrored and counted.
import type { MemoryEntry } from '../core/memory.js';
import type { DatabaseSyncLike } from '../db/index.js';
import { duplicateKey } from '../util/same-text.js';
import { writeEntryMirrors } from './entry-writes.js';
import { stampOriginProject } from './entry-row.js';
import { gatedWrite } from './gated-write.js';
import { updateStatsOn } from './index-and-stats.js';

export type CapturedOutcome = 'captured' | 'skipped' | 'rejected';

export interface CaptureItem {
  readonly content: string;
  /** Built only for an item that is not a repeat of an earlier one, since building can throw. */
  readonly makeEntry: () => MemoryEntry;
}

export interface CaptureWriteOptions {
  readonly actor?: string;
  /** No stats, as in a server process. */
  readonly lean: boolean;
  /** Called with each captured entry after its write, so the caller can embed it; the store never picks a provider. */
  readonly onCaptured?: (entry: MemoryEntry) => void;
}

/** One outcome per item, in order, on a handle opened with openStore. `keys` holds the texts already stored and gains
 * each one written, so a repeat inside the batch is skipped. */
export function writeCapturedItemsAt(
  db: DatabaseSyncLike,
  hippoRoot: string,
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
