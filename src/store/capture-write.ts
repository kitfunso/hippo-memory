// The write half of `hippo capture`: each item through the write gate on one store handle, then mirrored and counted.
import type { MemoryEntry } from '../core/memory.js';
import { closeHippoDb, withWriteScope } from '../db/index.js';
import { duplicateKey } from '../util/same-text.js';
import { supersedeInTx, writeEntryMirrors } from './entry-writes.js';
import { stampOriginProject } from './entry-row.js';
import { gatedWrite, type GatedWriteResult } from './gated-write.js';
import { updateStatsOn } from './index-and-stats.js';
import { openStore } from './open.js';

export type CapturedOutcome = 'captured' | 'skipped' | 'rejected';

export interface CaptureItem {
  readonly content: string;
  /** Built only for an item that is not a repeat of an earlier one, since building can throw. */
  readonly makeEntry: () => MemoryEntry;
  /** A stated rule: `ruleKeys` stop it, not `keys`, and it supersedes the held copies `replaces` names, in its own write. */
  readonly rule?: boolean;
  readonly replaces?: readonly string[];
}

export interface CaptureWriteOpts {
  readonly actor?: string;
  /** No stats, as in a server process. */
  readonly lean: boolean;
  /** Called with each captured entry after its write, so the caller can embed it; the store never picks a provider. */
  readonly onCaptured?: (entry: MemoryEntry) => void;
  /** The held keys that stop a stated rule; absent, every key in `keys` does. */
  readonly ruleKeys?: ReadonlySet<string>;
}

/** One outcome per item, in order. `keys` holds the texts already stored and gains each one written, so a repeat inside the batch is skipped. */
export function writeCapturedItems(hippoRoot: string, items: readonly CaptureItem[], keys: Set<string>, opts: CaptureWriteOpts): CapturedOutcome[] {
  const db = openStore(hippoRoot);
  try {
    const ruleKeys = opts.ruleKeys ?? keys;
    const actor = opts.actor ?? 'cli';
    return items.map((item) => {
      if ((item.rule ? ruleKeys : keys).has(duplicateKey(item.content))) return 'skipped';
      const entry = item.makeEntry();
      // One rejected item must not abort the rest of this capture's items.
      const stamped = stampOriginProject(hippoRoot, entry);
      const write = (): GatedWriteResult => {
        const written = gatedWrite(db, hippoRoot, stamped, { actor: opts.actor });
        if (written !== 'written') return written;
        for (const id of item.replaces ?? []) supersedeInTx(db, { tenantId: stamped.tenantId, id, newId: stamped.id, actor });
        return written;
      };
      // The rule and the copies it replaces commit together or not at all.
      const outcome = item.replaces?.length ? withWriteScope(db, 'capture_rule', write) : write();
      if (outcome === 'skipped:rejected') return 'rejected';
      if (outcome !== 'written') return 'skipped';
      writeEntryMirrors(hippoRoot, stamped);
      if (!opts.lean) updateStatsOn(db, hippoRoot, { remembered: 1 });
      keys.add(duplicateKey(item.content)); // within-batch dedup
      opts.onCaptured?.(entry);
      return 'captured';
    });
  } finally {
    closeHippoDb(db);
  }
}
