// What only hippo.db does: operations no port method covers, so they never run on another store.
import type { ArchiveOpts } from '../../raw-archive.js';
import type { WriteEntryOptions } from '../entry-writes.js';
import { loadIndex } from '../index-and-stats.js';
import { changeScopeGrantAt, type ScopeGrantChange } from '../key-writes.js';
import { onHandle } from '../open.js';
import type { EntryTarget, EntryWrite, OutcomeWrite, RawArchive } from '../port.js';
import { applyOutcomeAt, archiveRawAt, writeEntryAt } from './entry-writes-group.js';

/** The port's writes with an option that needs hippo.db's own handle, so no served store can run them. */
export interface SqliteLocal {
  /** entryWrites.archiveRaw with a connector's hook, which writes on the archive's handle inside its write scope. */
  archiveRaw(archive: RawArchive, afterArchive: NonNullable<ArchiveOpts['afterArchive']>): string;
  /** entryWrites.writeEntry for a connector: its hook and a flagged row's quarantine record write on the row's handle inside its write scope. */
  writeEntry(write: EntryWrite, afterWrite: WriteEntryOptions['afterWrite']): void;
  /** entryWrites.applyOutcome, then a link from the recall trace to the ids applied, on the same handle after the commit. */
  applyOutcome(outcome: OutcomeWrite, traceId: number): string[];
  /** applyOutcome on the ids of the last recall, which hippo.db's meta table holds with that recall's trace; answers the ids applied. */
  applyOutcomeToLastRecall(target: EntryTarget, good: boolean): string[];
}

export function sqliteLocal(hippoRoot: string): SqliteLocal {
  return {
    archiveRaw: (archive, afterArchive) => archiveRawAt(hippoRoot, archive, afterArchive),
    writeEntry: (write, afterWrite) => writeEntryAt(hippoRoot, write, afterWrite),
    applyOutcome: (outcome, traceId) => applyOutcomeAt(hippoRoot, outcome, traceId),
    // The ids and the trace come from one read of the index, so the outcome is linked to the recall that returned those ids.
    applyOutcomeToLastRecall(target, good) {
      const { last_retrieval_ids: ids, last_trace_id: trace } = loadIndex(hippoRoot);
      if (ids.length === 0) return [];
      return applyOutcomeAt(hippoRoot, { ...target, ids, good }, trace === null ? undefined : Number(trace));
    },
  };
}

/** What a served store answers for each write that needs hippo.db's own handle: a refusal. */
export const REFUSED_ON_A_STORE: Omit<SqliteLocal, 'applyOutcomeToLastRecall'> = {
  archiveRaw() {
    throw new Error('afterArchive runs on hippo.db only, never through a store');
  },
  writeEntry() {
    throw new Error('afterWrite and untrusted content are written to hippo.db only, never through a store');
  },
  applyOutcome() {
    throw new Error('an outcome links its recall trace on hippo.db only, never through a store');
  },
};

/** Off the port: only the local CLI changes grants, through synchronous published functions a store's Promise cannot answer. */
export function changeScopeGrant(hippoRoot: string, change: ScopeGrantChange): void {
  onHandle(hippoRoot, (db) => changeScopeGrantAt(db, change));
}
