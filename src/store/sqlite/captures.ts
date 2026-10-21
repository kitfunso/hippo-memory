// hippo.db's Captures: the whole batch on one handle, opened with openStore since a write sets up the mirror folders.
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { duplicateKey, longestWord, storedTextKeys } from '../../base/util/same-text.js';
import { writeEntryMirrors } from './entry-writes.js';
import { stampOriginProject } from './entry-row.js';
import { gatedWrite } from './gated-write.js';
import { updateStatsOn } from './index-and-stats.js';
import type { StoreFiles, OnHandle } from './open.js';
import type { CaptureDedup, CaptureWriteOptions, CapturedOutcome, Captures } from '../port/capture.js';
import type { Sync } from './served.js';
import { loadTextsHoldingWords } from './candidates.js';
import { EVERY_SCOPE } from './rule-sql.js';
import { openStore } from './handles.js';
import { bound, boundWithFiles, skipEmpty, type Bodies } from './bound.js';

/** The texts rows under `dedup` hold, of those the entries' longest words find. */
function heldKeys(db: DatabaseSyncLike, entries: readonly MemoryEntry[], dedup: CaptureDedup): Set<string> {
  const words = entries.map((entry) => longestWord(entry.content));
  const admit = dedup.everyScope ? EVERY_SCOPE : undefined;
  return storedTextKeys(loadTextsHoldingWords(db, dedup.tenantId, words, dedup.project, admit));
}

/** One outcome per entry, in order, in one transaction that reads the caller's dedup again first, so a text another
 * writer stored since that read is skipped; mirrors and stats follow the commit. */
function writeCapturedEntries(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  entries: readonly MemoryEntry[],
  opts: CaptureWriteOptions,
): CapturedOutcome[] {
  const written: MemoryEntry[] = [];
  const outcomes = withWriteScope(db, 'capture_write', () => {
    const held = heldKeys(db, entries, opts.dedup);
    return entries.map((entry): CapturedOutcome => {
      if (held.has(duplicateKey(entry.content))) return 'skipped';
      // One rejected entry must not abort the rest of this capture's entries.
      const stamped = stampOriginProject(hippoRoot, entry);
      const outcome = gatedWrite(db, hippoRoot, stamped, { actor: opts.actor });
      if (outcome === 'skipped:rejected') return 'rejected';
      if (outcome !== 'written') return 'skipped';
      written.push(stamped);
      return 'captured';
    });
  });
  for (const entry of written) writeEntryMirrors(hippoRoot, entry);
  if (!opts.lean && written.length > 0) updateStatsOn(db, hippoRoot, { remembered: written.length });
  return outcomes;
}

const capturedTextsBodies: Bodies<Pick<Captures, 'textsHolding'>> = {
  textsHolding: (db, tenantId, words, { project, everyScope } = {}) =>
    loadTextsHoldingWords(db, tenantId, words, project, everyScope ? EVERY_SCOPE : undefined),
};

export function sqliteCaptures(on: OnHandle): Sync<Captures> {
  const { write } = boundWithFiles<Pick<Captures, 'write'>>(on, { write: writeCapturedEntries }, openStore);
  return {
    write: skipEmpty(write, () => []),
    ...bound(on, capturedTextsBodies, openStore),
  };
}
