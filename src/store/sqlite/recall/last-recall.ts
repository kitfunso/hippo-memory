import { type DatabaseSyncLike, withWriteScope } from '../../../db/index.js';
import { appendAuditEvents } from '../audit/audit.js';
import {
  strengthenRetrieved,
  strengthenRetrievedInOwnTx,
  writeOutcome,
} from '../entries/entry-writes.js';
import { localGoalRecallRows, writeGoalRecallLog } from '../sessions/goals.js';
import { saveIndex } from '../entries/index-and-stats.js';
import { readLastRecall } from '../folder-files/mirrors.js';
import type { Handles, StoreFiles, StoreModel } from '../runtime/open.js';
import type { EntryTarget } from '../../../base/ports/store/entry-writes.js';
import { answered, bound } from '../runtime/bound.js';
import { openStore } from '../runtime/handles.js';
import type { LastRecall, RecallWrites } from '../../../base/ports/store.js';
import { writeRecallTrace } from './recall-trace.js';

interface RecallFinish {
  readonly traceId: number | null;
  readonly strengthened: ReadonlySet<string>;
}

/** sqliteStore's finishRecall, for the synchronous recall that cannot await the port. */
export function finishRecall(
  db: DatabaseSyncLike,
  rules: StoreModel,
  writes: RecallWrites,
): RecallFinish {
  const traceAndStrengthen = (): RecallFinish => ({
    traceId: writes.trace ? writeRecallTrace(db, writes.trace) : null,
    strengthened: writes.strengthen
      ? strengthenRetrievedInOwnTx(db, writes.strengthen.ids, writes.strengthen.opts, rules)
      : new Set<string>(),
  });
  if (writes.goalLog.length === 0 && writes.audit.length === 0) return traceAndStrengthen();
  return withWriteScope(db, 'finish_recall', () => {
    writeGoalRecallLog(db, localGoalRecallRows(db, writes.goalLog));
    appendAuditEvents(db, writes.audit);
    return traceAndStrengthen();
  });
}

function applyOutcomeToLast(
  db: DatabaseSyncLike,
  files: StoreFiles,
  target: EntryTarget,
  good: boolean,
): string[] {
  const { last_retrieval_ids: ids, last_trace_id: trace } = readLastRecall(db);
  if (ids.length === 0) return [];
  return writeOutcome(
    db,
    files,
    { ...target, ids, good },
    trace === null ? undefined : Number(trace),
  );
}

export function sqliteLastRecall({ on, files }: Handles): LastRecall {
  return {
    ...bound<Pick<LastRecall, 'applyOutcomeToLast'>>(
      on,
      { applyOutcomeToLast: (db, ...args) => applyOutcomeToLast(db, files, ...args) },
      openStore,
    ),
    finishRecall: (writes, globalRoot) =>
      answered(() => {
        const { ids, opts } = writes.strengthen;
        const { traceId, strengthened } = on((db) => finishRecall(db, files, writes));
        if (globalRoot !== undefined) {
          strengthenRetrieved(
            globalRoot,
            ids.filter((id) => !strengthened.has(id)),
            opts,
            files,
            files.opens.grant,
          );
        }
        const index = {
          last_retrieval_ids: [...ids],
          last_trace_id: traceId === null ? null : String(traceId),
        };
        on((db) => saveIndex(db, index), openStore);
        return traceId;
      }),
  };
}
