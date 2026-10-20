import type { RecallWrites } from './recall-writes.js';
import type { EntryTarget, OutcomeWrite } from './entry-writes.js';

/** A recall's writes when the store keeps it as its last one: `strengthen.ids` are the ids it returned. */
export type LastRecallWrites = RecallWrites & Required<Pick<RecallWrites, 'strengthen'>>;

/** The last recall a store keeps, so a later outcome can name it, and the outcome linked to a recall trace. */
export interface LastRecall {
  /** entryWrites.applyOutcome, then a link from recall trace `traceId` to the ids applied; resolves to those ids. */
  applyTracedOutcome(outcome: OutcomeWrite, traceId: number): Promise<string[]>;
  /** applyTracedOutcome on the ids and trace of the last recall, read together so an outcome never pairs them with an
   * older trace. */
  applyOutcomeToLast(target: EntryTarget, good: boolean): Promise<string[]>;
  /** finishRecall, then the ids this store lacks strengthened under `globalRoot`, then the ids and their trace saved as
   * the last recall in one write; resolves to the trace id, null when none was asked or its write failed. */
  finishRecall(writes: LastRecallWrites, globalRoot: string | undefined): Promise<number | null>;
}
