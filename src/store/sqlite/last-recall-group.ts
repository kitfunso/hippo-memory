// hippo.db's LastRecall group: the last recall sits in its meta table, and a traced outcome links on the outcome's own
// handle.
import { type DatabaseSyncLike, withWriteScope } from '../../db/index.js';
import { appendAuditEvent } from './audit.js';
import { strengthenRetrievedInOwnTx } from './entry-writes.js';
import { strengthenRetrieved } from './folder-forms.js';
import { localGoalRecallRows, writeGoalRecallLog } from './goals.js';
import { loadLastRecallAt, saveIndexAt } from './index-and-stats.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';
import type { LastRecall, RecallWrites, Sync } from '../port.js';
import { writeRecallTrace } from './recall-trace.js';
import { applyOutcomeAt } from './entry-writes-group.js';

/** What a finished recall wrote after its audit rows: the trace's id, null when none was asked or its write failed, and
 * the ids strengthened. */
interface RecallFinish {
  readonly traceId: number | null;
  readonly strengthened: ReadonlySet<string>;
}

/** sqliteStore's finishRecall, for the synchronous recall that cannot await the port. */
export function finishRecallAt(db: DatabaseSyncLike, writes: RecallWrites): RecallFinish {
  const traceAndStrengthen = (): RecallFinish => ({
    traceId: writes.trace ? writeRecallTrace(db, writes.trace) : null,
    strengthened: writes.strengthen
      ? strengthenRetrievedInOwnTx(db, writes.strengthen.ids, writes.strengthen.opts)
      : new Set<string>(),
  });
  // Alone, the fail-soft trace and strengthen keep their own scopes so a busy lock loses them, never the read.
  if (writes.goalLog.length === 0 && writes.audit.length === 0) return traceAndStrengthen();
  // Inside this scope both run as savepoints, so one recall commits once and a failed trace or strengthen still
  // unwinds alone.
  return withWriteScope(db, 'finish_recall', () => {
    writeGoalRecallLog(db, localGoalRecallRows(db, writes.goalLog));
    for (const event of writes.audit) appendAuditEvent(db, event);
    return traceAndStrengthen();
  });
}

export function sqliteLastRecall(on: OnHandle): Sync<LastRecall> {
  return {
    applyTracedOutcome: (outcome, traceId) => on((db, files) => applyOutcomeAt(db, files, outcome, traceId), openStore),
    applyOutcomeToLast: (target, good) =>
      on((db, files) => {
        const { last_retrieval_ids: ids, last_trace_id: trace } = loadLastRecallAt(db);
        if (ids.length === 0) return [];
        return applyOutcomeAt(db, files, { ...target, ids, good }, trace === null ? undefined : Number(trace));
      }, openStore),
    finishRecall(writes, globalRoot) {
      const { ids, opts } = writes.strengthen;
      const { traceId, strengthened } = on((db) => finishRecallAt(db, writes));
      if (globalRoot !== undefined) {
        strengthenRetrieved(
          globalRoot,
          ids.filter((id) => !strengthened.has(id)),
          opts,
        );
      }
      // One write for both keys, so an outcome never pairs these ids with an older trace; a lost trace saves null.
      const index = { last_retrieval_ids: [...ids], last_trace_id: traceId === null ? null : String(traceId) };
      on((db) => saveIndexAt(db, index), openStore);
      return traceId;
    },
  };
}
