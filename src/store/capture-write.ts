// The write half of `hippo capture`: each item through the write gate on one store handle, then mirrored and counted.
import type { MemoryEntry } from '../core/memory.js';
import { closeHippoDb } from '../db/index.js';
import { duplicateKey } from '../util/same-text.js';
import { embedMemory } from './embeddings/index.js';
import { writeEntryMirrors } from './entry-writes.js';
import { stampOriginProject } from './entry-row.js';
import { gatedWrite } from './gated-write.js';
import { updateStatsOn } from './index-and-stats.js';
import { openStore } from './open.js';

export type CapturedOutcome = 'captured' | 'skipped' | 'rejected';

export interface CaptureItem {
  readonly content: string;
  /** Built only for an item that is not a repeat of an earlier one, since building can throw. */
  readonly makeEntry: () => MemoryEntry;
}

export interface CaptureWriteOpts {
  readonly actor?: string;
  /** No stats and no embedding, since embedding runs a model in a server process. */
  readonly lean: boolean;
}

/** One outcome per item, in order. `keys` holds the texts already stored and gains each one written, so a repeat inside the batch is skipped. */
export function writeCapturedItems(hippoRoot: string, items: readonly CaptureItem[], keys: Set<string>, opts: CaptureWriteOpts): CapturedOutcome[] {
  const db = openStore(hippoRoot);
  try {
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
      if (!opts.lean) void embedMemory(hippoRoot, entry);
      return 'captured';
    });
  } finally {
    closeHippoDb(db);
  }
}
