// What only hippo.db does: operations no port method covers, so they never run on another store.
import type { ArchiveOpts } from '../../raw-archive.js';
import { strengthenRetrieved, type WriteEntryOptions } from '../entry-writes.js';
import { loadIndex, saveIndex } from '../index-and-stats.js';
import { changeScopeGrantAt, type ScopeGrantChange } from '../key-writes.js';
import { onHandle } from '../open.js';
import type { EntryTarget, EntryWrite, OutcomeWrite, RawArchive, RecallWrites } from '../port.js';
import { applyOutcomeAt, archiveRawAt, writeEntryAt } from './entry-writes-group.js';
import { finishRecallAt } from './store.js';

/** A recall's writes when hippo.db keeps it as its last one: `strengthen.ids` are the ids it returned. */
type LastRecallWrites = RecallWrites & Required<Pick<RecallWrites, 'strengthen'>>;

/** The port's writes with a part that needs hippo.db's own handle or its meta table, which no other store has. */
export interface SqliteLocal {
  /** entryWrites.archiveRaw with a connector's hook, which writes on the archive's handle inside its write scope. */
  archiveRaw(archive: RawArchive, afterArchive: NonNullable<ArchiveOpts['afterArchive']>): string;
  /** entryWrites.writeEntry for a connector: its hook and a flagged row's quarantine record write on the row's handle inside its write scope. */
  writeEntry(write: EntryWrite, afterWrite: WriteEntryOptions['afterWrite']): void;
  /** entryWrites.applyOutcome, then a link from the recall trace to the ids applied, on the same handle after the commit. */
  applyOutcome(outcome: OutcomeWrite, traceId: number): string[];
  /** applyOutcome on the ids of the last recall, which hippo.db's meta table holds with that recall's trace; answers the ids applied. */
  applyOutcomeToLastRecall(target: EntryTarget, good: boolean): string[];
  /** finishRecall, then the ids this root lacks strengthened under `globalRoot`, then the ids and their trace saved as the last recall.
   *  A store of another kind keeps no last recall, so its stand-in is its own finishRecall, hence the Promise. */
  finishLastRecall(writes: LastRecallWrites, globalRoot: string | undefined): void | Promise<void>;
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
    finishLastRecall(writes, globalRoot) {
      const { ids, opts } = writes.strengthen;
      const { traceId, strengthened } = finishRecallAt(hippoRoot, writes);
      if (globalRoot !== undefined) strengthenRetrieved(globalRoot, ids.filter((id) => !strengthened.has(id)), opts);
      // One write for both keys, so an outcome never pairs these ids with an older trace; a lost trace saves null.
      saveIndex(hippoRoot, { last_retrieval_ids: [...ids], last_trace_id: traceId === null ? null : String(traceId) });
    },
  };
}

/** What a served store answers for each write that needs hippo.db's own handle: a refusal. */
export const REFUSED_ON_A_STORE: Pick<SqliteLocal, 'archiveRaw' | 'writeEntry' | 'applyOutcome'> = {
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
