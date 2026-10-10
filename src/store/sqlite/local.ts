// What only hippo.db does: operations no port method covers, so they never run on another store.
import { strengthenRetrieved } from '../entry-writes.js';
import { loadLastRecall, saveIndex } from '../index-and-stats.js';
import { changeScopeGrantAt, type ScopeGrantChange } from '../key-writes.js';
import { onHandle } from '../open.js';
import type { EntryTarget, OutcomeWrite, RecallWrites } from '../port.js';
import { applyOutcomeAt } from './entry-writes-group.js';
import { finishRecallAt } from './store.js';

/** A recall's writes when hippo.db keeps it as its last one: `strengthen.ids` are the ids it returned. */
type LastRecallWrites = RecallWrites & Required<Pick<RecallWrites, 'strengthen'>>;

/** The port's writes with a part that needs hippo.db's own handle or its meta table, which no other store has. */
export interface SqliteLocal {
  /** entryWrites.applyOutcome, then a link from the recall trace to the ids applied, on the same handle after the commit. */
  applyOutcome(outcome: OutcomeWrite, traceId: number): string[];
  /** applyOutcome on the ids of the last recall, which hippo.db's meta table holds with that recall's trace; answers the ids applied. */
  applyOutcomeToLastRecall(target: EntryTarget, good: boolean): string[];
  /** finishRecall, then the ids this root lacks strengthened under `globalRoot`, then the ids and their trace saved as the last recall;
   *  answers the trace id. A store of another kind keeps no last recall, so its stand-in is its own finishRecall, answering null. */
  finishLastRecall(writes: LastRecallWrites, globalRoot: string | undefined): number | null | Promise<number | null>;
}

export function sqliteLocal(hippoRoot: string): SqliteLocal {
  return {
    applyOutcome: (outcome, traceId) => applyOutcomeAt(hippoRoot, outcome, traceId),
    // The ids and the trace come from one statement, so the outcome is linked to the recall that returned those ids.
    applyOutcomeToLastRecall(target, good) {
      const { last_retrieval_ids: ids, last_trace_id: trace } = loadLastRecall(hippoRoot);
      if (ids.length === 0) return [];
      return applyOutcomeAt(hippoRoot, { ...target, ids, good }, trace === null ? undefined : Number(trace));
    },
    finishLastRecall(writes, globalRoot) {
      const { ids, opts } = writes.strengthen;
      const { traceId, strengthened } = finishRecallAt(hippoRoot, writes);
      if (globalRoot !== undefined) strengthenRetrieved(globalRoot, ids.filter((id) => !strengthened.has(id)), opts);
      // One write for both keys, so an outcome never pairs these ids with an older trace; a lost trace saves null.
      saveIndex(hippoRoot, { last_retrieval_ids: [...ids], last_trace_id: traceId === null ? null : String(traceId) });
      return traceId;
    },
  };
}

/** What a served store answers for each write that needs hippo.db's own handle: a refusal. */
export const REFUSED_ON_A_STORE: Pick<SqliteLocal, 'applyOutcome'> = {
  applyOutcome() {
    throw new Error('an outcome links its recall trace on hippo.db only, never through a store');
  },
};

/** Off the port: only the local CLI changes grants, through synchronous published functions a store's Promise cannot answer. */
export function changeScopeGrant(hippoRoot: string, change: ScopeGrantChange): void {
  onHandle(hippoRoot, (db) => changeScopeGrantAt(db, change));
}
