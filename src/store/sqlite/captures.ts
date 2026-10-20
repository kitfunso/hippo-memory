// hippo.db's Captures: the whole batch on one handle, opened with openStore since a write sets up the mirror folders.
import type { DatabaseSyncLike } from '../../db/index.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { writeEntryMirrors } from './entry-writes.js';
import { stampOriginProject } from './entry-row.js';
import { gatedWrite } from './gated-write.js';
import { updateStatsOn } from './index-and-stats.js';
import type { StoreFiles, OnHandle } from './open.js';
import type { CaptureWriteOptions, CapturedOutcome, Captures } from '../port/captures.js';
import type { Sync } from './served.js';
import { EVERY_SCOPE, loadTextsHoldingWordsAt } from './candidates.js';
import { openStore } from './handles.js';
import { bound, boundWithFiles, skipEmpty, type Bodies } from './bound.js';

/** One outcome per entry, in order, on a handle opened with openStore. */
function writeCapturedEntriesAt(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  entries: readonly MemoryEntry[],
  opts: CaptureWriteOptions,
): CapturedOutcome[] {
  return entries.map((entry) => {
    // One rejected entry must not abort the rest of this capture's entries.
    const stamped = stampOriginProject(hippoRoot, entry);
    const outcome = gatedWrite(db, hippoRoot, stamped, { actor: opts.actor });
    if (outcome === 'skipped:rejected') return 'rejected';
    if (outcome !== 'written') return 'skipped';
    writeEntryMirrors(hippoRoot, stamped);
    if (!opts.lean) updateStatsOn(db, hippoRoot, { remembered: 1 });
    return 'captured';
  });
}

const capturedTextsAt: Bodies<Pick<Captures, 'textsHolding'>> = {
  textsHolding: (db, tenantId, words, { project, everyScope } = {}) =>
    loadTextsHoldingWordsAt(db, tenantId, words, project, everyScope ? EVERY_SCOPE : undefined),
};

export function sqliteCaptures(on: OnHandle): Sync<Captures> {
  const { write } = boundWithFiles<Pick<Captures, 'write'>>(on, { write: writeCapturedEntriesAt }, openStore);
  return {
    write: skipEmpty(write, () => []),
    ...bound(on, capturedTextsAt, openStore),
  };
}
