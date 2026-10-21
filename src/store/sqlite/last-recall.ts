// hippo.db's LastRecall group: the last recall sits in its meta table, and a traced outcome links on the outcome's own
// handle.
import { type DatabaseSyncLike, withWriteScope } from '../../db/index.js';
import { appendAuditEvents } from './audit.js';
import { strengthenRetrievedInOwnTx, applyOutcome } from './entry-writes.js';
import { strengthenRetrieved } from './folder-forms.js';
import { localGoalRecallRows, writeGoalRecallLog } from './goals.js';
import { saveIndex } from './index-and-stats.js';
import { readLastRecall } from './mirrors.js';
import type { Handles, StoreFiles } from './open.js';
import type { HippoIndex } from './rows.js';
import type { EntryTarget } from '../port/entry-writes.js';
import { bound, boundWithFiles, type FileBodies } from './bound.js';
import type { LossAversion } from '../../base/memory/memory.js';
import { openStore } from './handles.js';
import type { LastRecall, RecallWrites } from '../port.js';
import type { Sync } from './served.js';
import { writeRecallTrace } from './recall-trace.js';

/** What a finished recall wrote after its audit rows: the trace's id, null when none was asked or its write failed, and
 * the ids strengthened. */
interface RecallFinish {
  readonly traceId: number | null;
  readonly strengthened: ReadonlySet<string>;
}

/** sqliteStore's finishRecall, for the synchronous recall that cannot await the port. */
export function finishRecall(db: DatabaseSyncLike, rules: LossAversion, writes: RecallWrites): RecallFinish {
  const traceAndStrengthen = (): RecallFinish => ({
    traceId: writes.trace ? writeRecallTrace(db, writes.trace) : null,
    strengthened: writes.strengthen
      ? strengthenRetrievedInOwnTx(db, writes.strengthen.ids, writes.strengthen.opts, rules)
      : new Set<string>(),
  });
  // Alone, the fail-soft trace and strengthen keep their own scopes so a busy lock loses them, never the read.
  if (writes.goalLog.length === 0 && writes.audit.length === 0) return traceAndStrengthen();
  // Inside this scope both run as savepoints, so one recall commits once and a failed trace or strengthen still unwinds
  // alone.
  return withWriteScope(db, 'finish_recall', () => {
    writeGoalRecallLog(db, localGoalRecallRows(db, writes.goalLog));
    for (const event of writes.audit) appendAuditEvents(db, [event]);
    return traceAndStrengthen();
  });
}

/** The outcome for the last recall's ids, linked to its trace; `[]` when no recall has run. */
function applyOutcomeToLast(db: DatabaseSyncLike, files: StoreFiles, target: EntryTarget, good: boolean): string[] {
  const { last_retrieval_ids: ids, last_trace_id: trace } = readLastRecall(db);
  if (ids.length === 0) return [];
  return applyOutcome(db, files, { ...target, ids, good }, trace === null ? undefined : Number(trace));
}

const outcomesBodies: FileBodies<Pick<LastRecall, 'applyOutcomeToLast'>> = {
  applyOutcomeToLast: applyOutcomeToLast,
};

/** The two writes a finished recall makes here, either side of the global store's strengthen. */
interface RecallEnds {
  finish(writes: RecallWrites): RecallFinish;
  saveIndex(index: Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'>): void;
}

export function sqliteLastRecall({ on, files }: Handles): Sync<LastRecall> {
  const { finish } = boundWithFiles<Pick<RecallEnds, 'finish'>>(on, { finish: finishRecall });
  const ends = bound<Pick<RecallEnds, 'saveIndex'>>(on, { saveIndex }, openStore);
  return {
    ...boundWithFiles(on, outcomesBodies, openStore),
    finishRecall(writes, globalRoot) {
      const { ids, opts } = writes.strengthen;
      const { traceId, strengthened } = finish(writes);
      if (globalRoot !== undefined) {
        strengthenRetrieved(
          globalRoot,
          ids.filter((id) => !strengthened.has(id)),
          opts,
          files,
        );
      }
      // One write for both keys, so an outcome never pairs these ids with an older trace; a lost trace saves null.
      const index = { last_retrieval_ids: [...ids], last_trace_id: traceId === null ? null : String(traceId) };
      ends.saveIndex(index);
      return traceId;
    },
  };
}
