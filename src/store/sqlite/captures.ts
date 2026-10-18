// hippo.db's Captures: the whole batch on one handle, opened with openStore since a write sets up the mirror folders.
import type { DatabaseSyncLike } from '../../db/index.js';
import { duplicateKey } from '../../util/same-text.js';
import { writeEntryMirrors } from './entry-writes.js';
import { stampOriginProject } from './entry-row.js';
import { gatedWrite } from './gated-write.js';
import { updateStatsOn } from './index-and-stats.js';
import type { StoreFiles, OnHandle } from './open.js';
import type { CaptureItem, CaptureWriteOptions, CapturedOutcome, Captures } from '../port/captures.js';
import { EVERY_SCOPE, loadTextsHoldingWordsAt } from './candidates.js';
import { openStore } from './handles.js';

/** One outcome per item, in order, on a handle opened with openStore. `keys` holds the texts already stored and gains
 * each one written, so a repeat inside the batch is skipped. */
function writeCapturedItemsAt(
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

export function sqliteCaptures(on: OnHandle): Captures {
  return {
    write: (items, keys, opts) => on((db, files) => writeCapturedItemsAt(db, files, items, keys, opts), openStore),
    textsHolding: (tenantId, words, { project, everyScope } = {}) =>
      on(
        (db) => loadTextsHoldingWordsAt(db, tenantId, words, project, everyScope ? EVERY_SCOPE : undefined),
        openStore,
      ),
  };
}
