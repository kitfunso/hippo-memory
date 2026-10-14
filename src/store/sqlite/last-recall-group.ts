// hippo.db's LastRecall group: the last recall sits in its meta table, and a traced outcome links on the outcome's own
// handle.
import { withWriteScope } from '../../db/index.js';
import { appendAuditEvent } from '../audit.js';
import { strengthenRetrieved, strengthenRetrievedInOwnTx } from '../entry-writes.js';
import { localGoalRecallRows, writeGoalRecallLog } from '../goals.js';
import { loadLastRecall, saveIndex } from '../index-and-stats.js';
import { onHandle } from '../open.js';
import type { LastRecall, RecallWrites, Sync } from '../port.js';
import { writeRecallTrace } from '../recall-trace.js';
import { applyOutcomeAt } from './entry-writes-group.js';

/** What a finished recall wrote after its audit rows: the trace's id, null when none was asked or its write failed, and
 * the ids strengthened. */
interface RecallFinish {
  readonly traceId: number | null;
  readonly strengthened: ReadonlySet<string>;
}

/** sqliteStore's finishRecall, for the synchronous recall that cannot await the port. */
export function finishRecallAt(hippoRoot: string, writes: RecallWrites): RecallFinish {
  return onHandle(hippoRoot, (db) => {
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
  });
}

export function sqliteLastRecall(hippoRoot: string): Sync<LastRecall> {
  return {
    applyTracedOutcome: (outcome, traceId) => applyOutcomeAt(hippoRoot, outcome, traceId),
    applyOutcomeToLast(target, good) {
      const { last_retrieval_ids: ids, last_trace_id: trace } = loadLastRecall(hippoRoot);
      if (ids.length === 0) return [];
      return applyOutcomeAt(hippoRoot, { ...target, ids, good }, trace === null ? undefined : Number(trace));
    },
    finishRecall(writes, globalRoot) {
      const { ids, opts } = writes.strengthen;
      const { traceId, strengthened } = finishRecallAt(hippoRoot, writes);
      if (globalRoot !== undefined) strengthenRetrieved(globalRoot, ids.filter((id) => !strengthened.has(id)), opts);
      // One write for both keys, so an outcome never pairs these ids with an older trace; a lost trace saves null.
      saveIndex(hippoRoot, { last_retrieval_ids: [...ids], last_trace_id: traceId === null ? null : String(traceId) });
      return traceId;
    },
  };
}

/** The group as a served store answers it: the call runs at once and resolves through a Promise, so a throw rejects as
 * another store's would. */
export function servedLastRecall(sync: Sync<LastRecall>): LastRecall {
  return {
    applyTracedOutcome: async (outcome, traceId) => sync.applyTracedOutcome(outcome, traceId),
    applyOutcomeToLast: async (target, good) => sync.applyOutcomeToLast(target, good),
    finishRecall: async (writes, globalRoot) => sync.finishRecall(writes, globalRoot),
  };
}
